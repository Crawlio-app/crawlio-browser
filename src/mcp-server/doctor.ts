// Read-only health doctor — `crawlio-browser doctor`.
//
// Side-effect-free probes, evidence per check, exact fix commands, redaction at the
// output boundary, exit taxonomy. Dispatched in index.ts BEFORE the WebSocketBridge
// is constructed, so a doctor run can never start a server, bind a port, or write
// a bridge file. Template: egress-audit.ts (collect / render / run split with
// injectable deps, the same shape provision.mjs uses for the native host).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest } from "node:http";
import {
  defaultIsPidAlive,
  listLiveBridges,
  HOST_NAME,
  targetDirs,
  type LiveBridge,
} from "../../bin/native-host/provision.mjs";
import { BRIDGE_DIR, PKG_VERSION } from "../shared/constants.js";
import { CLIENT_REGISTRY, isAlreadyConfigured, type McpClientDef } from "./init.js";
import { CrawlioClient } from "./crawlio-client.js";
import { redactSecrets } from "./redact.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PORTAL_URL = "http://127.0.0.1:3001";

export type DoctorStatus = "ok" | "warn" | "off" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  /** Human-readable one-liner for the render path. */
  detail: string;
  evidence: Record<string, unknown>;
  fix?: string;
}

export interface DoctorReport {
  schema: "ai.crawlio.browser-doctor.v1";
  generatedAt: string;
  version: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
}

export interface DoctorDeps {
  bridgesDir?: string;
  fetchFn?: typeof fetch;
  isPidAlive?: (pid: number) => boolean;
  readDir?: (p: string) => string[];
  readFile?: (p: string, enc: string) => string;
  fileExists?: (p: string) => boolean;
  portalUrl?: string;
  portFree?: (port: number) => Promise<boolean>;
  appIsRunning?: () => Promise<boolean>;
  appSocketPaths?: string[];
  udsHealth?: (socketPath: string) => Promise<boolean>;
  registry?: McpClientDef[];
  hostDirs?: () => string[];
  stagedHostPath?: string;
  launchdPlistPath?: string;
}

interface BridgeHealth {
  pid: number;
  port: number;
  connected: boolean;
  uptime?: number;
  queueDepth?: number;
  version?: string;
  /** What the extension reported about its own optional permissions when it identified. */
  extensionPermissions?: { granted: boolean; permissions: Record<string, boolean>; missing: string[] };
  /** Chrome profiles seen this run, and which holds the bridge. Absent on older servers. */
  profiles?: { connected: string | null; preferred: string | null; seen: Array<{ profileId: string; connected: boolean }> };
}

/**
 * Fetch one bridge's /health and return its body — same service/pid/port
 * cross-check as provision.mjs `validateBridgeViaHealth`, kept local because the
 * doctor needs the body fields (connected/uptime/queueDepth), not just a boolean.
 */
async function fetchBridgeHealth(bridge: LiveBridge, fetchFn: typeof fetch): Promise<BridgeHealth | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${bridge.port}/health`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (!body || body.service !== "crawlio-mcp" || body.pid !== bridge.pid || body.port !== bridge.port) return null;
    return {
      pid: bridge.pid,
      port: bridge.port,
      connected: body.connected === true,
      uptime: typeof body.uptime === "number" ? body.uptime : undefined,
      queueDepth: typeof body.queueDepth === "number" ? body.queueDepth : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      extensionPermissions: body.extensionPermissions as BridgeHealth["extensionPermissions"],
      profiles: body.profiles as BridgeHealth["profiles"],
    };
  } catch {
    return null;
  }
}

function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function checkBridges(deps: Required<Pick<DoctorDeps, "bridgesDir" | "fetchFn">> & DoctorDeps): Promise<DoctorCheck> {
  const live = listLiveBridges(deps.bridgesDir, deps.isPidAlive ?? defaultIsPidAlive, deps.readDir, deps.readFile);
  const healths: BridgeHealth[] = [];
  for (const b of live) {
    const h = await fetchBridgeHealth(b, deps.fetchFn);
    if (h) healths.push(h);
  }
  // Token deliberately never copied into evidence; redactSecrets is belt-and-braces.
  const evidence: Record<string, unknown> = {
    bridgesDir: deps.bridgesDir,
    liveFiles: live.length,
    validatedServers: healths.length,
    servers: healths,
  };
  if (healths.some((h) => h.connected)) {
    const c = healths.find((h) => h.connected);
    return { id: "bridge.servers", status: "ok", detail: `extension connected (pid ${c?.pid} @ :${c?.port}, ${healths.length} server${healths.length === 1 ? "" : "s"})`, evidence };
  }
  if (healths.length > 0) {
    return {
      id: "bridge.servers", status: "warn",
      detail: `${healths.length} server${healths.length === 1 ? "" : "s"} up, extension not connected`,
      evidence,
      fix: "Open Chrome, install/enable the Crawlio extension (https://www.crawlio.app/browser-agent), then click it on any tab to connect.",
    };
  }
  if (live.length > 0) {
    return {
      id: "bridge.servers", status: "error",
      detail: `${live.length} bridge file(s) with live pids but no server answered /health`,
      evidence,
      fix: "Stale or foreign bridge state — restart your MCP client session; stale files are cleaned at next server start.",
    };
  }
  return {
    id: "bridge.servers", status: "off",
    detail: "no bridge server running",
    evidence,
    fix: "Normal when no MCP client session is active — bridge servers start with the client. Open Claude Code/Cursor with crawlio-browser configured, or run `npx crawlio-browser init --portal` for an always-on server.",
  };
}

/**
 * Does the connected extension actually hold its optional permissions?
 *
 * A partial grant is the failure this exists to catch: `tabs` present so browsing works and
 * everything looks fine, `nativeMessaging` absent so the extension can never receive the
 * trusted bridge token and stays trust-on-first-use — meaning a rogue local server can win the
 * bridge election and drive CDP. Every other check passed in exactly that state, so the doctor
 * reported "healthy" while the rogue-server defense was switched off.
 */
async function checkExtensionPermissions(
  deps: Required<Pick<DoctorDeps, "bridgesDir" | "fetchFn">> & DoctorDeps,
): Promise<DoctorCheck> {
  const live = listLiveBridges(deps.bridgesDir, deps.isPidAlive ?? defaultIsPidAlive, deps.readDir, deps.readFile);
  const healths: BridgeHealth[] = [];
  for (const b of live) {
    const h = await fetchBridgeHealth(b, deps.fetchFn);
    if (h) healths.push(h);
  }
  const connected = healths.find((h) => h.connected);
  const reported = connected?.extensionPermissions;
  const evidence: Record<string, unknown> = { reported: reported ?? null };

  if (!connected) {
    return {
      id: "extension.permissions", status: "off",
      detail: "no extension connected — nothing to report",
      evidence,
    };
  }
  if (!reported) {
    return {
      id: "extension.permissions", status: "warn",
      detail: "extension connected but did not report its permissions",
      evidence,
      fix: "The extension predates permission reporting. Reload it at chrome://extensions to get an accurate answer.",
    };
  }
  if (reported.granted) {
    const held = Object.keys(reported.permissions).filter((p) => reported.permissions[p]);
    return {
      id: "extension.permissions", status: "ok",
      detail: `all optional permissions granted (${held.join(", ")})`,
      evidence,
    };
  }
  const missing = reported.missing.join(", ");
  const securityRelevant = reported.missing.includes("nativeMessaging");
  return {
    id: "extension.permissions", status: "warn",
    detail: securityRelevant
      ? `missing ${missing} — the extension cannot verify which local server it talks to`
      : `missing ${missing}`,
    evidence,
    fix: "Open Crawlio's dedicated onboarding page, review and grant all requested browser access, then rerun doctor.",
  };
}

/**
 * Which Chrome profile is being driven.
 *
 * Worth a check of its own because the failure it catches is silent: with the extension enabled
 * in two profiles, commands land in whichever one won the bridge, and the only symptom is that
 * the page the operator is looking at never changes.
 */
async function checkProfiles(
  deps: Required<Pick<DoctorDeps, "bridgesDir" | "fetchFn">> & DoctorDeps,
): Promise<DoctorCheck> {
  const live = listLiveBridges(deps.bridgesDir, deps.isPidAlive ?? defaultIsPidAlive, deps.readDir, deps.readFile);
  const healths: BridgeHealth[] = [];
  for (const b of live) {
    const h = await fetchBridgeHealth(b, deps.fetchFn);
    if (h) healths.push(h);
  }
  const connected = healths.find((h) => h.connected);
  const profiles = connected?.profiles;
  const evidence: Record<string, unknown> = { profiles: profiles ?? null };

  if (!connected) {
    return { id: "extension.profile", status: "off", detail: "no extension connected — no profile to report", evidence };
  }
  if (!profiles?.connected) {
    return {
      id: "extension.profile", status: "warn",
      detail: "extension connected but did not identify its Chrome profile",
      evidence,
      fix: "The extension predates profile identity. Reload it at chrome://extensions.",
    };
  }

  const others = profiles.seen.filter((p) => p.profileId !== profiles.connected);
  const detail = others.length
    ? `driving profile ${profiles.connected}; ${others.length} other profile(s) seen`
    : `driving profile ${profiles.connected}`;
  return {
    id: "extension.profile", status: "ok",
    detail: profiles.preferred ? `${detail} (pinned)` : detail,
    evidence,
    ...(others.length && !profiles.preferred
      ? { fix: "More than one profile has connected. Use switch_profile to pin the one you mean." }
      : {}),
  };
}

async function checkPortal(deps: Required<Pick<DoctorDeps, "portalUrl" | "fetchFn" | "fileExists">> & DoctorDeps): Promise<DoctorCheck> {
  const plist = deps.launchdPlistPath ?? join(homedir(), "Library", "LaunchAgents", "com.crawlio.agent.plist");
  const launchdInstalled = deps.fileExists(plist);
  const port = Number(new URL(deps.portalUrl).port || 3001);
  try {
    const res = await deps.fetchFn(`${deps.portalUrl}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) {
      return { id: "portal.health", status: "error", detail: `portal /health answered HTTP ${res.status}`, evidence: { url: deps.portalUrl, httpStatus: res.status, launchdInstalled }, fix: "Restart the portal: `npx crawlio-browser init --portal`." };
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (body?.transport !== "portal") {
      return { id: "portal.health", status: "error", detail: `port ${port} answered but is not the crawlio portal`, evidence: { url: deps.portalUrl, launchdInstalled, service: body?.transport ?? null }, fix: `Another service occupies port ${port} — stop it or run the portal on a different port (\`--port\`).` };
    }
    return {
      id: "portal.health", status: "ok",
      detail: `portal up (${String(body.mode)} mode, ${String(body.toolCount)} tools, extension ${body.bridgeConnected === true ? "connected" : "not connected"})`,
      evidence: { url: deps.portalUrl, mode: body.mode, toolCount: body.toolCount, bridgeConnected: body.bridgeConnected === true, uptime: body.uptime, version: body.version, launchdInstalled },
    };
  } catch {
    const free = await (deps.portFree ?? defaultPortFree)(port);
    if (!free) {
      return { id: "portal.health", status: "error", detail: `port ${port} is occupied but /health does not answer`, evidence: { url: deps.portalUrl, portFree: false, launchdInstalled }, fix: `Something is squatting port ${port} — find it with \`lsof -i :${port}\` or run the portal on a different port.` };
    }
    if (launchdInstalled) {
      return { id: "portal.health", status: "error", detail: "launchd agent installed but portal not running", evidence: { url: deps.portalUrl, portFree: true, launchdInstalled }, fix: `launchctl load ${plist} — or reinstall with \`npx crawlio-browser init --portal\`. Logs: ~/Library/Logs/Crawlio/server.err` };
    }
    return { id: "portal.health", status: "off", detail: "portal not running (optional)", evidence: { url: deps.portalUrl, portFree: true, launchdInstalled }, fix: "Optional — `npx crawlio-browser init --portal` for multi-client / ChatGPT Desktop / persistence across sessions." };
  }
}

function checkNativeHost(deps: Required<Pick<DoctorDeps, "fileExists">> & DoctorDeps): DoctorCheck {
  const hostDir = process.env.CRAWLIO_NM_DIR
    ? join(process.env.CRAWLIO_NM_DIR, "native-host")
    : join(homedir(), ".crawlio", "native-host");
  const staged = deps.stagedHostPath ?? join(hostDir, "host.mjs");
  const stagedPresent = deps.fileExists(staged);
  const dirs = (deps.hostDirs ?? targetDirs)();
  const manifests = dirs.map((d) => join(d, `${HOST_NAME}.json`)).filter((f) => deps.fileExists(f));
  const evidence = { stagedHost: staged, stagedPresent, browserDirsChecked: dirs.length, manifestsFound: manifests };
  if (stagedPresent && manifests.length > 0) {
    return { id: "nativehost.manifests", status: "ok", detail: `host staged, ${manifests.length} browser manifest${manifests.length === 1 ? "" : "s"}`, evidence };
  }
  if (stagedPresent || manifests.length > 0) {
    return { id: "nativehost.manifests", status: "warn", detail: stagedPresent ? "host staged but no browser manifest found" : "browser manifest(s) present but staged host missing", evidence, fix: "Repair with `node bin/native-host/install.mjs` (or `npx crawlio-browser init`). Without it the extension falls back to trust-on-first-use." };
  }
  return { id: "nativehost.manifests", status: "off", detail: "native messaging host not installed", evidence, fix: "Install with `npx crawlio-browser init` — lets the extension verify the server's identity instead of trusting the first one it finds. Optional but recommended." };
}

function checkClientConfigs(deps: Required<Pick<DoctorDeps, "fileExists" | "registry">> & DoctorDeps): DoctorCheck {
  const readFile = deps.readFile ?? ((p: string, enc: string) => readFileSync(p, enc as BufferEncoding) as unknown as string);
  const rows: Array<{ client: string; format: string; configExists: boolean; configured: boolean | "unknown" }> = [];
  for (const c of deps.registry) {
    let detected = false;
    try { detected = c.detect(); } catch { /* treat as undetected */ }
    if (!detected) continue;
    const configExists = deps.fileExists(c.configPath);
    let configured: boolean | "unknown" = false;
    if (configExists) {
      if (c.format === "json") {
        try {
          const parsed = JSON.parse(readFile(c.configPath, "utf8")) as Record<string, unknown>;
          const section = (parsed?.[c.serverKey] ?? {}) as Record<string, unknown>;
          configured = isAlreadyConfigured({ mcpServers: section });
        } catch {
          configured = "unknown";
        }
      } else {
        // TOML/YAML writers are append-only in init.ts; no reader exists — report honestly.
        configured = "unknown";
      }
    }
    rows.push({ client: c.name, format: c.format, configExists, configured });
  }
  const configuredCount = rows.filter((r) => r.configured === true).length;
  const evidence = { detectedClients: rows.length, configuredClients: configuredCount, clients: rows };
  if (configuredCount > 0) {
    return { id: "clients.configs", status: "ok", detail: `configured in ${configuredCount} of ${rows.length} detected client${rows.length === 1 ? "" : "s"}`, evidence };
  }
  if (rows.length > 0) {
    return { id: "clients.configs", status: "warn", detail: `${rows.length} MCP client${rows.length === 1 ? "" : "s"} detected, none configured`, evidence, fix: "Run `npx crawlio-browser init` to configure detected clients." };
  }
  return { id: "clients.configs", status: "off", detail: "no MCP clients detected", evidence, fix: "Install an MCP client (Claude Code, Cursor, …) then run `npx crawlio-browser init`." };
}

// The app prefers the app-group socket and falls back to the log-dir socket;
// GET /health is token-exempt on both, built for exactly this stale-socket
// probing. The TCP control.port file is legacy — kept as the last fallback.
const APP_SOCKET_CANDIDATES = [
  join(homedir(), "Library", "Group Containers", "HR8X6TP7J6.com.crawlio.shared", "c.sock"),
  join(homedir(), "Library", "Logs", "Crawlio", "control.sock"),
];

function udsHealthProbe(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { socketPath, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function checkApp(deps: DoctorDeps): Promise<DoctorCheck> {
  const fileExists = deps.fileExists ?? existsSync;
  const probe = deps.udsHealth ?? udsHealthProbe;
  const sockets = deps.appSocketPaths ?? APP_SOCKET_CANDIDATES;
  for (const socketPath of sockets) {
    if (!fileExists(socketPath)) continue;
    if (await probe(socketPath)) {
      return { id: "crawlio.app", status: "ok", detail: "Crawlio.app control server reachable (uds)", evidence: { running: true, transport: "uds", socketPath } };
    }
  }
  const socketExists = sockets.some((s) => fileExists(s));
  const running = await (deps.appIsRunning ?? (() => new CrawlioClient().isRunning()))();
  if (running) {
    return { id: "crawlio.app", status: "ok", detail: "Crawlio.app control server reachable (tcp)", evidence: { running: true, transport: "tcp" } };
  }
  const detail = socketExists
    ? "Crawlio.app socket present but not answering — stale socket (optional)"
    : "Crawlio.app not running (optional)";
  return { id: "crawlio.app", status: "off", detail, evidence: { running: false, socketExists }, fix: "Optional — `open -a Crawlio` enables the engine-backed crawl/export tools." };
}

export async function collectDoctorReport(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const filled = {
    ...deps,
    bridgesDir: deps.bridgesDir ?? BRIDGE_DIR,
    fetchFn: deps.fetchFn ?? fetch,
    fileExists: deps.fileExists ?? existsSync,
    portalUrl: deps.portalUrl ?? PORTAL_URL,
    registry: deps.registry ?? CLIENT_REGISTRY,
  };
  const checks = [
    await checkBridges(filled),
    await checkExtensionPermissions(filled),
    await checkProfiles(filled),
    await checkPortal(filled),
    checkNativeHost(filled),
    checkClientConfigs(filled),
    await checkApp(filled),
  ];
  const summary: Record<DoctorStatus, number> = { ok: 0, warn: 0, off: 0, error: 0 };
  for (const c of checks) summary[c.status] += 1;
  return {
    schema: "ai.crawlio.browser-doctor.v1",
    generatedAt: new Date().toISOString(),
    version: PKG_VERSION,
    checks,
    summary,
  };
}

/**
 * Exit taxonomy (§3.2 rule 6): 0 healthy · 69 substrate down (nothing serving MCP)
 * · 1 degraded (server up but extension disconnected, or any check errored).
 * `crawlio.app` never affects the code — it is optional for the browser agent.
 */
export function exitCodeFor(report: DoctorReport): number {
  const byId = new Map(report.checks.map((c) => [c.id, c]));
  const bridge = byId.get("bridge.servers");
  const portal = byId.get("portal.health");
  const serverUp = bridge?.status === "ok" || bridge?.status === "warn" || portal?.status === "ok";
  if (!serverUp) return 69;
  const connected = bridge?.status === "ok" || (portal?.status === "ok" && portal.evidence.bridgeConnected === true);
  const anyError = report.checks.some((c) => c.status === "error");
  return connected && !anyError ? 0 : 1;
}

const GLYPHS: Record<DoctorStatus, string> = {
  ok: green("+"),
  warn: yellow("!"),
  off: dim("-"),
  error: red("x"),
};

export function renderDoctorReport(report: DoctorReport): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold("Crawlio Browser Doctor")} ${dim("v" + report.version)}`);
  out.push("");
  const idWidth = Math.max(...report.checks.map((c) => c.id.length));
  for (const c of report.checks) {
    out.push(`  ${GLYPHS[c.status]} ${c.id.padEnd(idWidth)}  ${c.detail}`);
    if (c.status !== "ok" && c.fix) out.push(`    ${dim("fix:")} ${dim(c.fix)}`);
  }
  out.push("");
  const code = exitCodeFor(report);
  const verdict = code === 0 ? green("healthy") : code === 69 ? red("substrate down") : yellow("degraded");
  const s = report.summary;
  out.push(`  ${s.ok} ok · ${s.warn} warn · ${s.off} off · ${s.error} error → ${verdict}`);
  out.push(`  ${dim("machine-readable: crawlio-browser doctor --json")}`);
  out.push("");
  return out.join("\n");
}

/** Entry point for the `doctor` subcommand. Read-only; returns the process exit code. */
export async function runDoctor(argv: readonly string[] = []): Promise<number> {
  const report = await collectDoctorReport();
  const code = exitCodeFor(report);
  const safe = redactSecrets(report) as DoctorReport;
  if (argv.includes("--json")) {
    console.log(JSON.stringify(safe, null, 2));
  } else {
    console.log(renderDoctorReport(safe));
  }
  return code;
}
