export type SafetyEnv = Record<string, string | undefined>;

// Mode values that select the raw-capture lane. `raw` and `traffic` are the documented
// spellings; `re` and its long forms are earlier names kept working so existing configs do
// not break, and will be dropped in the next major.
const RAW_LANE_VALUES = new Set([
  "raw",
  "traffic",
  "traffic-analysis",
  "traffic_analysis",
  "re",
  "reverse-engineering",
  "reverse_engineering",
]);

/** Documented switch, plus the earlier name it replaced. */
const RAW_LANE_FLAGS = ["CRAWLIO_RAW_LANE", "CRAWLIO_RE_LANE"];

function envValue(env: SafetyEnv, key: string): string {
  return String(env[key] ?? "").trim().toLowerCase();
}

/**
 * True when the caller has explicitly asked for the raw-capture lane, which turns off
 * redaction, output truncation, and content-boundary wrapping — because those transform
 * exactly the page and traffic bytes this lane exists to preserve.
 */
export function isExplicitRawLane(env: SafetyEnv = process.env): boolean {
  for (const flag of RAW_LANE_FLAGS) {
    if (envValue(env, flag) === "1") return true;
  }
  for (const key of ["CRAWLIO_CONTEXT_MODE", "CRAWLIO_AGENT_MODE", "CRAWLIO_SAFETY_MODE", "CRAWLIO_LANE"]) {
    if (RAW_LANE_VALUES.has(envValue(env, key))) return true;
  }
  return false;
}

export function envFlagEnabled(env: SafetyEnv, key: string): boolean | null {
  const raw = envValue(env, key);
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}
