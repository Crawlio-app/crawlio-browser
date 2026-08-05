// Anonymous usage telemetry — install id + AGGREGATE counts only.
//
// What it sends: a random install id (UUIDv4, persisted at ~/.crawlio/install-id),
// the platform, the Node version, the package version, and aggregate counters
// (tool-call count, session count, uptime). That's it.
//
// What it NEVER sends: page content, URLs, cookies, storage, DOM, network bodies,
// captured data, file paths, hostnames, or anything else that could identify a user
// or a site. No PII, ever.
//
// It is fire-and-forget: a disabled, failed, or slow ping can never block or error an
// init step or a tool call. Opt out completely with CRAWLIO_TELEMETRY=0. See TELEMETRY.md.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PKG_VERSION } from "../shared/constants.js";

const CRAWLIO_DIR = join(homedir(), ".crawlio");
const INSTALL_ID_FILE = join(CRAWLIO_DIR, "install-id");
// Free Cloudflare Worker sink (override for self-host/testing). The /server-install and
// /server-usage routes live on the worker; until they exist a ping just 404s harmlessly.
const TELEMETRY_BASE = process.env.CRAWLIO_TELEMETRY_URL || "https://worker.crawlio.app";
const PING_TIMEOUT_MS = 2000;

/** Where the install id lives on disk — surfaced by `audit-egress` so it is never a hidden file. */
export function installIdPath(): string { return INSTALL_ID_FILE; }
/** The endpoint telemetry is sent to (env-overridable). Surfaced by `audit-egress`. */
export function telemetryEndpoint(): string {
  return process.env.CRAWLIO_TELEMETRY_URL || "https://worker.crawlio.app";
}

/** Telemetry is ON by default; any of 0/false/off/no (case-insensitive) disables it. */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.CRAWLIO_TELEMETRY ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

let cachedInstallId: string | null = null;
/** Stable anonymous install id (UUIDv4) persisted at ~/.crawlio/install-id (0600). */
export function getInstallId(): string {
  if (cachedInstallId) return cachedInstallId;
  try {
    const existing = readFileSync(INSTALL_ID_FILE, "utf8").trim();
    if (existing) { cachedInstallId = existing; return existing; }
  } catch { /* not created yet */ }
  const id = randomUUID();
  try {
    mkdirSync(CRAWLIO_DIR, { recursive: true });
    writeFileSync(INSTALL_ID_FILE, id + "\n", { mode: 0o600 });
  } catch { /* read-only home — id is ephemeral for this run, still anonymous */ }
  cachedInstallId = id;
  return id;
}

/**
 * Replace the install id with a fresh random one. Returns { previous, next }.
 *
 * This is the property the Windows GDID lacks and the reason it is inescapable: there, the
 * identifier is anchored on the vendor's servers, so deleting the local copy just makes the machine
 * re-download *the same number*. Ours is minted locally and held by no one, so a rotation is real —
 * we cannot map the new id back to the old one even if asked.
 */
export function rotateInstallId(): { previous: string | null; next: string } {
  let previous: string | null = null;
  try {
    previous = existsSync(INSTALL_ID_FILE) ? readFileSync(INSTALL_ID_FILE, "utf8").trim() || null : null;
  } catch { /* unreadable — treat as absent */ }
  try { rmSync(INSTALL_ID_FILE, { force: true }); } catch { /* best-effort */ }
  cachedInstallId = null;
  return { previous, next: getInstallId() };
}

interface TelemetryBody { event: string; [k: string]: unknown }

// Single best-effort POST, short timeout, all errors swallowed. NEVER throws.
async function send(path: string, body: TelemetryBody): Promise<void> {
  if (!telemetryEnabled()) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    await globalThis.fetch(`${TELEMETRY_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: getInstallId(),
        pkgVersion: PKG_VERSION,
        platform: process.platform,
        nodeVersion: process.versions.node,
        ts: Date.now(),
        ...body,
      }),
      signal: controller.signal,
      keepalive: true,
    });
  } catch { /* best-effort — telemetry must never surface to the user */ } finally {
    clearTimeout(timer);
  }
}

/** One-time install ping (called from init). */
export function pingInstall(): void {
  void send("/server-install", { event: "install" });
}

// In-memory aggregate usage for the current server session — no per-call network.
const usage = { toolCalls: 0, startedAt: Date.now() };
export function recordToolCall(): void { usage.toolCalls++; }

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 min

/**
 * Start session telemetry: one "server started" heartbeat now, then an aggregate heartbeat
 * every 30 min (carrying the running tool-call count). The interval is unref'd so it never
 * keeps the process alive. Call once at server startup; no-op when telemetry is disabled.
 */
export function startSessionTelemetry(): void {
  if (!telemetryEnabled() || heartbeatTimer) return;
  void send("/server-usage", { event: "session_start" });
  heartbeatTimer = setInterval(() => {
    void send("/server-usage", { event: "heartbeat", toolCalls: usage.toolCalls, uptimeMs: Date.now() - usage.startedAt });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

/** Stop the heartbeat (test/teardown hygiene). */
export function stopSessionTelemetry(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
