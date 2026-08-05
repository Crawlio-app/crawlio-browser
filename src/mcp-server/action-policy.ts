import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface ActionPolicy {
  default: "allow" | "deny";
  allow?: string[];
  deny?: string[];
}

export type PolicyDecision = "allow" | "deny";

/**
 * Load and validate an action policy from a JSON file.
 * Throws on missing file, invalid JSON, or invalid "default" value.
 */
export function loadActionPolicy(policyPath: string): ActionPolicy {
  const resolved = resolve(policyPath);
  const content = readFileSync(resolved, "utf-8");
  const policy = JSON.parse(content) as ActionPolicy;

  if (policy.default !== "allow" && policy.default !== "deny") {
    throw new Error(
      `Invalid action policy: "default" must be "allow" or "deny", got "${String(policy.default)}"`
    );
  }

  if (policy.allow && !Array.isArray(policy.allow)) {
    throw new Error(`Invalid action policy: "allow" must be an array`);
  }
  if (policy.deny && !Array.isArray(policy.deny)) {
    throw new Error(`Invalid action policy: "deny" must be an array`);
  }

  return policy;
}

/**
 * Match a tool name against a pattern.
 * Supports glob suffix: "get_*" matches any tool starting with "get_".
 * Exact match otherwise.
 */
function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}

/**
 * Check whether a tool is allowed or denied by the action policy.
 *
 * Priority: explicit deny > explicit allow > default.
 */
export function checkActionPolicy(toolName: string, policy: ActionPolicy): PolicyDecision {
  // Explicit deny takes precedence
  if (policy.deny) {
    for (const pattern of policy.deny) {
      if (matchesPattern(toolName, pattern)) return "deny";
    }
  }

  // Explicit allow overrides default deny
  if (policy.allow) {
    for (const pattern of policy.allow) {
      if (matchesPattern(toolName, pattern)) return "allow";
    }
  }

  return policy.default;
}

// --- Hot-reload support ---

let cachedPolicyPath: string | null = null;
let cachedPolicyMtimeMs = 0;
let cachedPolicy: ActionPolicy | null = null;
const RELOAD_CHECK_INTERVAL_MS = 5_000;
let lastCheckMs = 0;

export function initPolicyReloader(policyPath: string, policy: ActionPolicy): void {
  cachedPolicyPath = resolve(policyPath);
  cachedPolicyMtimeMs = statSync(cachedPolicyPath).mtimeMs;
  cachedPolicy = policy;
}

export function reloadPolicyIfChanged(): ActionPolicy | null {
  if (!cachedPolicyPath) return cachedPolicy;

  const now = Date.now();
  if (now - lastCheckMs < RELOAD_CHECK_INTERVAL_MS) return cachedPolicy;
  lastCheckMs = now;

  try {
    const currentMtime = statSync(cachedPolicyPath).mtimeMs;
    if (currentMtime !== cachedPolicyMtimeMs) {
      cachedPolicy = loadActionPolicy(cachedPolicyPath);
      cachedPolicyMtimeMs = currentMtime;
      console.error(`[MCP] Action policy reloaded from ${cachedPolicyPath}`);
    }
  } catch {
    // File may have been removed; keep using cached policy
  }

  return cachedPolicy;
}

/** Reset module state — for testing only */
export function _resetPolicyState(): void {
  cachedPolicyPath = null;
  cachedPolicyMtimeMs = 0;
  cachedPolicy = null;
  lastCheckMs = 0;
}
