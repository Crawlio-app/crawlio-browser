import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "http";
import { randomUUID, timingSafeEqual } from "crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { WS_PORT, WS_PORT_MAX, WS_HOST, BRIDGE_DIR, TIMEOUTS, WS_HEARTBEAT_INTERVAL, WS_STALE_THRESHOLD, WS_RECONNECT_GRACE, PKG_VERSION } from "../shared/constants.js";
import { isProblemCode, type ServerCommand, type ExtensionResponse, type ProblemCode } from "../shared/protocol.js";
import { computeHandshakeProof, HANDSHAKE_MESSAGE_TYPES } from "../shared/bridge-handshake.js";
import { applyTargetTab } from "./target-tab.js";
import { ProfileRoster, isProfileId, type ProfileRecord } from "../shared/profile-identity.js";
import { isNewerWorkerGeneration, parseWorkerGeneration, type WorkerGeneration } from "../shared/worker-generation.js";

// Resolve the absolute path to index.js for the setup page
function resolveIndexPath(): string {
  // Primary: process.argv[1] is the script Node is running
  if (process.argv[1] && process.argv[1].includes("dist")) {
    return process.argv[1];
  }
  // Fallback: resolve from this module's location
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);
    return resolve(thisDir, "index.js");
  } catch {
    return "<path-to-crawlio-browser>/dist/mcp-server/index.js";
  }
}

const RESOLVED_INDEX_PATH = resolveIndexPath();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSetupHTML(indexPath: string): string {
  const cmd = escapeHtml(`claude mcp add crawlio-browser -- node ${indexPath} --portal`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crawlio Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
      color: rgba(0,0,0,0.6);
      background: #fff;
      padding: 48px 24px;
    }
    .container { max-width: 640px; margin: 0 auto; }
    .breadcrumb { font-size: 14px; color: rgba(0,0,0,0.25); margin-bottom: 24px; }
    .breadcrumb a { color: rgba(0,0,0,0.25); text-decoration: none; }
    .breadcrumb a:hover { color: rgba(0,0,0,0.6); }
    .breadcrumb span { color: rgba(0,0,0,0.4); }
    h1 { font-size: 30px; font-weight: 500; color: rgba(0,0,0,0.87); margin-bottom: 8px; letter-spacing: -0.02em; }
    header p { color: rgba(0,0,0,0.4); font-size: 16px; margin-bottom: 40px; }
    .step { margin-bottom: 32px; }
    .step-label { font-size: 13px; font-weight: 500; color: #7c3aed; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .step h2 { font-size: 18px; font-weight: 500; color: rgba(0,0,0,0.87); margin-bottom: 8px; }
    .step p { color: rgba(0,0,0,0.6); font-size: 15px; margin-bottom: 16px; line-height: 1.7; }
    .code-wrap {
      background: #f0f0f4;
      border-radius: 12px;
      overflow: hidden;
    }
    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px 0;
    }
    .dots { display: flex; gap: 6px; }
    .dots span { width: 10px; height: 10px; border-radius: 50%; }
    .dot-r { background: #ef4444; }
    .dot-y { background: #eab308; }
    .dot-g { background: #22c55e; }
    .code-actions { display: flex; align-items: center; gap: 8px; }
    .lang-tag { font-size: 12px; color: rgba(0,0,0,0.3); font-weight: 500; }
    #copy-btn {
      background: none;
      border: none;
      color: rgba(0,0,0,0.3);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      transition: color 0.15s;
    }
    #copy-btn:hover { color: rgba(0,0,0,0.6); }
    .code-body {
      padding: 16px 20px 20px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.6;
      color: rgba(0,0,0,0.7);
    }
    .code-body code { white-space: pre; }
    .inline-code {
      background: rgba(124,58,237,0.1);
      color: #7c3aed;
      padding: 2px 6px;
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 14px;
    }
    .divider { height: 1px; background: rgba(0,0,0,0.06); margin: 32px 0; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(0,0,0,0.06); font-size: 13px; color: rgba(0,0,0,0.25); text-align: center; }
    .footer a { color: #7c3aed; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    .success-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(34,197,94,0.1); color: #16a34a; font-size: 13px; font-weight: 500; padding: 6px 12px; border-radius: 20px; margin-bottom: 24px; }
    .success-badge svg { flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="breadcrumb"><a href="https://docs.crawlio.app/browser-agent">Browser Agent</a> <span>/</span> Setup</div>
    <header>
      <div class="success-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Extension authorized</div>
      <h1>Set up MCP server</h1>
      <p>Connect your AI agent to the browser</p>
    </header>
    <main>
      <div class="step">
        <div class="step-label">Step 1</div>
        <h2>Add the MCP server</h2>
        <p>Run this command in your terminal:</p>
        <div class="code-wrap">
          <div class="code-header">
            <div class="dots"><span class="dot-r"></span><span class="dot-y"></span><span class="dot-g"></span></div>
            <div class="code-actions">
              <span class="lang-tag">BASH</span>
              <button onclick="copyCmd()" id="copy-btn" title="Copy"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
            </div>
          </div>
          <div class="code-body"><code id="cmd">${cmd}</code></div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="step">
        <div class="step-label">Step 2</div>
        <h2>Start automating</h2>
        <p>Open your AI application and start using Crawlio tools. Try asking your AI to <span class="inline-code">connect_tab</span> or <span class="inline-code">capture_page</span>.</p>
      </div>
    </main>
    <div class="footer">Need help? Visit the <a href="https://docs.crawlio.app/browser-agent/welcome">full documentation</a></div>
  </div>
  <script>
    function copyCmd() {
      var text = document.getElementById('cmd').textContent;
      navigator.clipboard.writeText(text).then(function() {
        var btn = document.getElementById('copy-btn');
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        setTimeout(function() { btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedMessage {
  message: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueueTime: number;
  timeoutMs: number;
  /**
   * How long the caller allowed for a *response*, as distinct from timeoutMs — the budget for
   * waiting on the queue, which carries a floor so a briefly-absent extension can still arrive.
   * Draining used a flat 30s here, so `send(cmd, 4000)` could sit for 30 seconds once queued:
   * the caller's own deadline was discarded the moment its command took the queue path.
   */
  commandTimeoutMs: number;
  // Expiry timer — cleared the moment the item leaves the queue (drained/evicted/cleared)
  // so a successfully-drained message doesn't leave a live timer dangling.
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_QUEUE_SIZE = 100;
const DEFAULT_MSG_TIMEOUT = 30_000;

/**
 * Every queue rejection means the same thing to a caller: the command never reached the
 * extension because it was not connected. Tag them so that is machine-readable rather than
 * something to infer from the message text.
 */
function notConnected(message: string): Error {
  return Object.assign(new Error(message), { problem: "not_connected" satisfies ProblemCode });
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];

  enqueue(message: string, timeoutMs = DEFAULT_MSG_TIMEOUT, commandTimeoutMs = timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        const oldest = this.queue.shift();
        if (oldest?.timer) clearTimeout(oldest.timer);
        oldest?.reject(notConnected("Queue overflow — message evicted"));
      }
      const item: QueuedMessage = { message, resolve, reject, enqueueTime: Date.now(), timeoutMs, commandTimeoutMs };
      this.queue.push(item);
      // Independent timeout — reject if not drained before expiry (prevents infinite hang when WS never connects)
      this.armExpiry(item, timeoutMs);
    });
  }

  /**
   * Arm an item's queue-expiry timer for `ms`, replacing any existing one.
   *
   * Split out because an item can rejoin the queue after a failed transmission, and it must keep
   * counting against its ORIGINAL deadline rather than getting a fresh full budget each time.
   */
  private armExpiry(item: QueuedMessage, ms: number): void {
    if (item.timer) clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      const idx = this.queue.indexOf(item);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
        item.reject(notConnected(`Queued message expired after ${item.timeoutMs}ms — extension not connected`));
      }
    }, ms);
  }

  async drain(sendFn: (msg: string, resolve: (v: unknown) => void, reject: (e: Error) => void, commandTimeoutMs: number) => Promise<void>): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.timer) { clearTimeout(item.timer); item.timer = undefined; } // leaving the queue
      if (Date.now() - item.enqueueTime > item.timeoutMs) {
        item.reject(notConnected("Queued message expired"));
        continue;
      }
      try {
        // sendFn registers item.resolve/reject in the pending map, but the returned
        // promise resolves on transmission confirmation — not on response receipt.
        // This prevents head-of-line blocking: a slow response (e.g. 30s navigate)
        // no longer blocks subsequent queued items from being transmitted.
        await sendFn(item.message, item.resolve as (v: unknown) => void, item.reject as (e: Error) => void, item.commandTimeoutMs);
      } catch {
        // Transmission never happened, so this command is still owed an answer and its caller is
        // still waiting. Failing it here threw away work the queue exists to protect — put it
        // back at the head with what remains of its deadline, and let the next drain carry it.
        this.requeueFront(item);
        break; // Stop draining — connection likely lost, preserve remaining items
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  /** Return an undeliverable item to the head of the queue, still on its original deadline. */
  private requeueFront(item: QueuedMessage): void {
    const remaining = item.timeoutMs - (Date.now() - item.enqueueTime);
    if (remaining <= 0) {
      item.reject(notConnected("Queued message expired"));
      return;
    }
    this.queue.unshift(item);
    this.armExpiry(item, remaining);
  }

  get depth(): number { return this.queue.length; }

  clear(): void {
    for (const item of this.queue) {
      if (item.timer) clearTimeout(item.timer); // leaving the queue — drop its expiry timer
      item.reject(notConnected("Queue cleared — connection reset"));
    }
    this.queue = [];
  }
}

interface ConnectionHealth {
  /** True only when the attached extension is admitted and its identity handshake has settled. */
  connected: boolean;
  /** Lower-level diagnostic: a socket exists, even if it is not ready to receive commands. */
  socketConnected: boolean;
  latencyMs: number;
  uptime: number;
  reconnects: number;
  queueDepth: number;
  // Epoch ms of the last inbound MCP tool dispatch. Surfaced in /health and the
  // bridge file so a multi-bridge consumer can elect the most-recently-active server.
  lastActivityAt: number;
  version: string;
  // What the connected extension reports about its own optional permissions, asked once when
  // it identifies itself. Exposed here because /health is the only thing a separate process
  // (`crawlio-browser doctor`) can read — without it, "is nativeMessaging actually granted?"
  // could only be inferred from side effects like whether a native-host process had spawned.
  extensionPermissions?: {
    granted: boolean;
    permissions: Record<string, boolean>;
    missing: string[];
  };
  // Chrome profiles seen this run, and which one holds the bridge. Same reasoning as
  // extensionPermissions: /health is what a separate process can read, so putting the roster
  // here is what lets `crawlio-browser doctor` report the active profile rather than guess.
  profiles?: {
    connected: string | null;
    preferred: string | null;
    seen: ProfileRecord[];
  };
}

/**
 * Per-send options.
 *
 * `queueWhenOffline` defaults to true, which is right for real work: an extension reconnecting
 * after a service-worker restart should not lose the command in flight, so it waits on the queue
 * with a 45s floor. It is wrong for a probe — "is a browser attached", "what framework is this" —
 * where the offline answer is known immediately and the caller already handles it. Two such
 * probes run on every `execute`, which is how a call with no browser attached came to block for
 * 45 seconds before returning a result it could have produced at once.
 */
export interface SendOptions {
  queueWhenOffline?: boolean;
}

const HEARTBEAT_INTERVAL = WS_HEARTBEAT_INTERVAL;
const STALE_THRESHOLD = WS_STALE_THRESHOLD;

/// How long the incumbent has to answer a contention probe before it is treated
/// as dead. Short on purpose: a genuine reconnect after a silently-dropped
/// transport must not have to wait out STALE_THRESHOLD (90s) to reclaim.
const CONTENDED_PROBE_TIMEOUT = 5_000;

/// Floor between contention log lines. Refusals are the steady state when more
/// than one extension is installed, and this log is unrotated.
const CONTENTION_LOG_INTERVAL = 60_000;

/// Application close code (4000–4999) telling a client the bridge is held by a
/// live extension, so it can back off rather than treat this as an error.
const WS_CLOSE_BRIDGE_BUSY = 4009;
/** A newer worker from the incumbent profile may retry immediately after the stale one is freed. */
const WS_CLOSE_NEWER_GENERATION_RETRY = 4010;
/**
 * How long a pinned profile has to take the bridge before the pin is dropped.
 *
 * The extension retries roughly every 3s, so this is many attempts — long enough that a browser
 * still starting up wins, short enough that pinning a profile whose Chrome has quit does not
 * leave every tool dead for the life of the process.
 */
const PROFILE_SWITCH_GRACE = 30_000;
/**
 * How long a refused client gets to identify itself before the socket closes.
 *
 * The extension sends `connected` in its open handler, so this only has to cover local delivery.
 * Short on purpose: a refused client must not linger, and a silent one costs exactly this.
 */
const REFUSED_IDENTIFY_WINDOW = 750;

/**
 * How long we wait for the extension's identity challenge before releasing the queue anyway.
 *
 * Only reached by a client that never challenges — an extension predating the handshake. One that
 * old cannot refuse us either, so releasing is both safe and the only way it ever gets a command.
 * The real extension challenges in its open handler and answers in ~1ms, so this never fires in
 * practice; it is purely the version-skew escape hatch.
 */
const HANDSHAKE_SETTLE_GRACE = 2_000;
// Reloaded Chrome can leave an older anonymous worker knocking before the current generation
// (which reports profileId/workerGeneration) arrives. Do not give that legacy-looking socket the
// offline queue immediately: once transmitted, commands cannot safely be replayed after the
// newer worker supersedes it. Genuine legacy extensions still become usable after this grace.
const LEGACY_CLIENT_ADMISSION_GRACE = 10_000;

/** Minimum gap between bridge-file writes. A burst of tool calls must not hammer the disk. */
const BRIDGE_WRITE_INTERVAL = 1_000;

const WS_RATE_LIMIT = 60; // max commands per second

class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerSecond: number;

  constructor(maxPerSecond: number) {
    this.maxPerSecond = maxPerSecond;
  }

  allow(): boolean {
    const now = Date.now();
    const windowStart = now - 1000;
    // Remove expired timestamps
    while (this.timestamps.length > 0 && this.timestamps[0] <= windowStart) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxPerSecond) return false;
    this.timestamps.push(now);
    return true;
  }
}

const HEALTH_CORS_ORIGINS = [
  "chrome-extension://",
  "http://127.0.0.1",
  "http://localhost",
];

function isAllowedHealthOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  for (const allowed of HEALTH_CORS_ORIGINS) {
    if (origin.startsWith(allowed)) return origin;
  }
  return null;
}

/**
 * DNS-rebind guard for the HTTP/WS listener. A rebind attack serves a page from
 * `evil.com` whose DNS is rebound to 127.0.0.1, so the browser connects to
 * loopback but still sends `Host: evil.com`. Requiring the Host header to name
 * loopback rejects that request while leaving the extension and local tools
 * (which dial `127.0.0.1`) untouched. Port suffix is ignored.
 */
export function isAllowedHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  // Bracketed IPv6 with optional port: [::1] or [::1]:9333
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close > 0 && h.slice(1, close) === "::1";
  }
  // hostname with optional :port
  const hostname = h.replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/**
 * WS client accept decision, AFTER the host-header (DNS-rebind) guard has passed. Accept iff
 * the client presented a valid bridge token, OR it connects with a chrome-extension:// origin
 * (the extension — a web page can't forge that origin, and a TOFU extension has no token yet).
 * A bare no-origin / localhost-origin connection is REJECTED — it let any unauthenticated
 * local process drive/forge the session. Pure + exported for unit testing.
 */
export function isAcceptableWsClient(origin: string | undefined, tokenValid: boolean): boolean {
  if (tokenValid) return true;
  return typeof origin === "string" && origin.startsWith("chrome-extension://");
}

async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port <= WS_PORT_MAX; port++) {
    try {
      const res = await fetch(`http://${WS_HOST}:${port}/health`, {
        signal: AbortSignal.timeout(300),
      });
      const body = await res.json() as { service?: string; pid?: number };
      if (body.service === "crawlio-mcp" && body.pid === process.pid) {
        return port; // Our own zombie — safe to reuse
      }
      // Another live crawlio-mcp — skip this port
    } catch (err) {
      // Only a genuinely REFUSED connection means the port is free. A timeout, reset, or
      // foreign-protocol/parse error means SOMETHING is listening there — skip it rather
      // than claim it free and then lose the race to bind(). undici surfaces the
      // OS errno on err.cause.code.
      const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
      if (code === "ECONNREFUSED") return port; // nobody home — claim it
      // else: occupied/unreachable — try the next port
    }
  }
  throw new Error(`All ports ${WS_PORT}-${WS_PORT_MAX} in use by crawlio-mcp instances`);
}

/**
 * Bind `server` to the first free port in [startPort, maxPort], WALKING past any bind error
 * (EADDRINUSE from a zombie/concurrent instance, or a probe→bind race). Returns the bound port,
 * or `null` if the whole range is busy — in which case the caller must NOT crash: the MCP stdio
 * server stays up and browser tools degrade via the bridge's isConnected guard. A per-attempt
 * `once("error")` (auto-removed on fire) ensures a listen error can never escape to
 * process.uncaughtException. Exported for tests. `listen()` itself is the source of truth, so
 * this self-corrects past anything findAvailablePort's health probe missed.
 */
export async function listenWalkingPortRange(
  server: Server,
  startPort: number,
  maxPort: number,
  host: string,
): Promise<number | null> {
  for (let port = startPort; port <= maxPort; port++) {
    const listened = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") console.error(`[Bridge] Port ${port} in use — trying next...`);
        else console.error(`[Bridge] listen error on ${port}: ${err.code ?? err.message}`);
        resolve(false);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    if (listened) return port;
  }
  return null;
}

function cleanStaleBridgeFiles(): void {
  try {
    const files = readdirSync(BRIDGE_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(BRIDGE_DIR, file), "utf-8")) as { pid?: number };
        if (data.pid && data.pid !== process.pid) {
          try { process.kill(data.pid, 0); } catch {
            // Process doesn't exist — remove stale file
            try { unlinkSync(join(BRIDGE_DIR, file)); } catch { /* removal is best-effort */ }
          }
        }
      } catch { /* invalid JSON or read error — remove */
        try { unlinkSync(join(BRIDGE_DIR, file)); } catch { /* removal is best-effort */ }
      }
    }
  } catch { /* BRIDGE_DIR doesn't exist yet — fine */ }
}

function removeBridgeFile(): void {
  try { unlinkSync(join(BRIDGE_DIR, `${process.pid}.json`)); } catch { /* no file for this pid — fine */ }
}

export class WebSocketBridge {
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private messageQueue = new MessageQueue();
  private readonly bridgeToken = randomUUID();
  private rateLimiter = new SlidingWindowRateLimiter(WS_RATE_LIMIT);

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private contentionProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastContentionLog = 0;
  private contentionRefusals = 0;
  private lastPong = 0;
  private lastPingSent = 0;
  private latencyMs = 0;
  private connectTime = 0;
  private reconnectCount = -1; // first connection is not a "reconnect"
  private actualPort = WS_PORT;

  // Activity tracking for multi-bridge election. lastActivityAt is stamped on every
  // inbound MCP tool dispatch (via noteActivity) and published in /health + the bridge
  // file so a consumer can pick the most-recently-active server. startedAt is captured
  // once at construction (NOT per write) — it must stay stable across touches.
  private readonly startedAt = Date.now();
  // 0 until the FIRST inbound tool dispatch (noteActivity). A fresh, idle server must NOT
  // publish "just active" — that let a freshly-spawned idle bridge steal the election from
  // the bridge the user is actually driving. 0 sorts last in electActiveBridge.
  private lastActivityAt = 0;
  /** Cached from the extension on identify; see refreshExtensionPermissions(). */
  private extensionPermissions: ConnectionHealth["extensionPermissions"];
  /** Chrome profiles seen this run — the switch targets. */
  private readonly profiles = new ProfileRoster();
  /** Profile of the extension currently holding the bridge, if it reported one. */
  private connectedProfileId: string | null = null;
  /** Extension/runtime generation currently holding the socket, used only for safe reload takeover. */
  private connectedExtensionId: string | null = null;
  private connectedWorkerGeneration: WorkerGeneration | null = null;
  /**
   * When set, only this profile's extension may hold the bridge.
   *
   * The server still talks to exactly one extension at a time — this chooses *which*, it does not
   * multiplex. So the property that a rogue local server cannot knock a healthy extension off the
   * bridge is untouched: every extension still proves the server holds the real bridge token
   * before executing anything.
   *
   * It is a selector, NOT an isolation boundary, and nothing should be built on it as though it
   * were. The profile id is asserted over the wire rather than proved, and /health publishes the
   * pinned id unauthenticated, so a client that wanted to could read it and claim it. What the
   * pin buys is that the *cooperating* extensions — every real one — stay out of the way, which
   * is the actual problem: with Crawlio enabled in several profiles, commands used to land in
   * whichever one won the race. Making it enforceable would mean binding the id to something the
   * extension proves, which the native-host channel could carry.
   */
  private preferredProfileId: string | null = null;
  /**
   * Whether the connected socket may be transmitted to.
   *
   * False between accepting a socket and learning which profile it is, but only while a profile
   * is pinned. This is the whole isolation: an extension that never identifies simply never
   * receives commands, which closes the "omit profileId to dodge the filter" hole without a
   * refusal loop, and stops queued work from executing against the wrong browser.
   */
  private clientAdmitted = false;
  /** Delays queue transmission to an anonymous pre-generation client during reload convergence. */
  private legacyAdmissionTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True once our identity proof is on the wire for the current socket — or once it's clear the
   * client is never going to ask for one.
   *
   * No command may reach the extension ahead of that proof. The extension refuses anything
   * arriving while its handshake verdict is still pending, and (before this) answered nothing, so
   * the caller waited out its entire timeout for a command that had been dropped on the floor.
   * That was not a race anyone could win: the drain runs synchronously from the connection and
   * `connected` handlers, while the proof is answered from an async crypto promise, so the first
   * command after every reconnect went out ahead of it by construction. Gating transmission here
   * makes the ordering an invariant instead of a coin flip.
   */
  private handshakeSettled = false;
  private handshakeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current extensions acknowledge that they accepted our nonce-bound proof before work drains. */
  private handshakeAckRequired = false;
  private handshakeNonce: string | null = null;
  /** A connected socket owes us a permission check, deferred until it can receive one. */
  private permissionsRefreshPending = false;
  /** Profile the currently-pending commands were transmitted to; see failPendingOnProfileTakeover. */
  private pendingProfileId: string | null = null;
  private profileRefusals = 0;
  private lastProfileRefusalLog = 0;
  /** Cleared when the preferred profile fails to take the bridge; see switchProfile(). */
  private switchRevertTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exit handler registered in start(); held so stop() can unregister it. */
  private exitCleanup: (() => void) | null = null;
  private lastBridgeWriteAt = 0;
  /** Trailing-edge write owed to a throttled touchBridgeFile(); see there. */
  private bridgeTouchTimer: ReturnType<typeof setTimeout> | null = null;
  // Set in stop(): a torn-down bridge must never re-advertise itself by re-writing its
  // bridge file from a late noteActivity()/touchBridgeFile().
  private stopped = false;

  onClientConnected?: () => void;
  onPortRefreshRequested?: () => void;

  get port(): number { return this.actualPort; }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.client?.readyState === WebSocket.OPEN) {
        this.lastPingSent = Date.now();
        // A protocol-level WebSocket ping proves the TCP peer is alive, but Chrome handles its
        // pong below the extension service worker. It therefore does not count as extension
        // activity and cannot keep an MV3 worker alive. Send the protocol ping for transport
        // health and an ordinary protocol command for the worker lifetime; the latter reaches
        // background.ts and receives the existing `pong` response without touching page state.
        this.client.ping();
        if (this.isReady) {
          this.client.send(JSON.stringify({ type: "ping", id: `__crawlio_keepalive__:${this.lastPingSent}` }));
        }
        if (this.lastPong > 0 && Date.now() - this.lastPong > STALE_THRESHOLD) {
          console.error(`[Bridge] WebSocket stale — no pong in ${STALE_THRESHOLD / 1000}s, closing`);
          this.client.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Turn away a second client while a live one holds the bridge, and probe the
   * incumbent so a silently-dropped transport is released in seconds instead of
   * waiting out STALE_THRESHOLD.
   *
   * The refused client backs off (RECONNECT_BASE) and retries, so whichever
   * extension is genuinely alive keeps the session and the loser stops
   * retaliating. Refusing rather than evicting also strengthens the property the
   * connection filter is there for: a caller that reaches this
   * point can no longer knock a healthy extension off the bridge.
   */
  private refuseContendedConnection(ws: WebSocket): void {
    this.noteContention();
    // Let it say who it is on the way out.
    //
    // Refusing at the socket means a second profile's extension never reaches the `connected`
    // message, so it never enters the roster — and with two Chrome profiles running, list_profiles
    // showed one and switch_profile called the other "has not connected to this server". The
    // profile you would actually want to switch to is precisely the one being refused.
    //
    // This accepts nothing but an identification: no command can be issued, the socket is closed
    // either way, and the only state written is a profile id that is already validated and an
    // extension id that is already clamped.
    this.identifyOnTheWayOut(ws);

    // One probe per contention round, however many clients are knocking.
    if (this.contentionProbeTimer) return;
    const incumbent = this.client;
    if (!incumbent) return;
    const pongBefore = this.lastPong;
    try {
      incumbent.ping();
    } catch {
      // Ping failed outright — let the timer below adjudicate.
    }
    this.contentionProbeTimer = setTimeout(() => {
      this.contentionProbeTimer = null;
      if (this.client === incumbent && this.lastPong === pongBefore) {
        console.error("[Bridge] Incumbent failed its contention probe — releasing the bridge");
        incumbent.terminate();
      }
    }, CONTENDED_PROBE_TIMEOUT);
  }

  /**
   * Record a refused client's profile, then close it.
   *
   * Waits a moment for the `connected` message the extension sends immediately on open. Anything
   * else is ignored, and the socket closes on identification or on the deadline, whichever comes
   * first — a client that stays silent simply costs one short timer.
   */
  private identifyOnTheWayOut(ws: WebSocket): void {
    const close = () => {
      try { ws.close(WS_CLOSE_BRIDGE_BUSY, "bridge busy — a live extension holds this session"); } catch { /* already gone */ }
    };
    const deadline = setTimeout(() => { ws.off("message", onMessage); close(); }, REFUSED_IDENTIFY_WINDOW);
    if (deadline.unref) deadline.unref();

    const onMessage = (raw: WebSocket.RawData) => {
      let closeCode = WS_CLOSE_BRIDGE_BUSY;
      let closeReason = "bridge busy — a live extension holds this session";
      try {
        const len = typeof raw === "string" ? Buffer.byteLength(raw) : (raw as Buffer).length;
        if (len > 64 * 1024) return; // an identification is tiny; anything larger is not one
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type !== "connected" || !isProfileId(msg.profileId)) return;
        const extensionId = typeof msg.extensionId === "string" ? msg.extensionId.slice(0, 128) : "unknown";
        const generation = parseWorkerGeneration(msg.workerGeneration);
        const now = new Date().toISOString();
        const sameExtension = this.connectedExtensionId !== null && extensionId === this.connectedExtensionId;
        const sameProfile = this.connectedProfileId === null || msg.profileId === this.connectedProfileId;
        if (
          sameExtension &&
          sameProfile &&
          isNewerWorkerGeneration(generation, this.connectedWorkerGeneration)
        ) {
          // A Chrome unpacked-extension reload can leave the prior worker alive behind its native
          // port. The healthy incumbent would otherwise win forever, while the popup opened from
          // the new generation claimed it was connected to a different/partial bridge. Release
          // only an explicitly newer generation of the SAME extension/profile; the candidate is
          // still closed and must reconnect through the normal handshake before receiving work.
          console.error("[Bridge] Newer extension worker superseded the incumbent — releasing stale generation");
          this.client?.terminate();
          closeCode = WS_CLOSE_NEWER_GENERATION_RETRY;
          closeReason = "newer extension generation — retry";
        }
        // Seen, but not driving anything — it is being turned away.
        const incumbentIsSameProfile = msg.profileId === this.connectedProfileId;
        this.profiles.observe(msg.profileId, extensionId, now);
        // A second generation of the SAME profile commonly knocks while Chrome is retiring an
        // extension reload. Refusing that socket must not mark the still-live incumbent profile
        // offline in /health; only a genuinely different refused profile is disconnected.
        if (!incumbentIsSameProfile) this.profiles.disconnect(msg.profileId, now);
      } catch { /* not JSON, or not for us */ }
      clearTimeout(deadline);
      ws.off("message", onMessage);
      try { ws.close(closeCode, closeReason); } catch { close(); }
    };
    ws.on("message", onMessage);
  }

  /**
   * Rate-limit the contention log. With N extensions installed, refusal is the
   * steady state rather than an incident, and `server.err` is not rotated.
   */
  private noteContention(): void {
    this.contentionRefusals++;
    const now = Date.now();
    if (now - this.lastContentionLog < CONTENTION_LOG_INTERVAL) return;
    console.error(
      `[Bridge] Refused ${this.contentionRefusals} connection(s) since last report — a live extension holds this session. ` +
      `Enable the Crawlio extension in one Chrome profile only.`
    );
    this.lastContentionLog = now;
    this.contentionRefusals = 0;
  }

  /**
   * Rate-limit the profile-refusal log.
   *
   * With a profile pinned, every other installed extension retries on its reconnect backoff, so
   * refusal is the steady state rather than an incident — and server.err is not rotated. Same
   * reasoning, and same shape, as noteContention().
   */
  private noteProfileRefusal(): void {
    this.profileRefusals++;
    const now = Date.now();
    if (now - this.lastProfileRefusalLog < CONTENTION_LOG_INTERVAL) return;
    console.error(
      `[Bridge] Refused ${this.profileRefusals} connection(s) from other Chrome profiles since last report — ` +
      `profile ${this.preferredProfileId} is selected. Use switch_profile to change it.`
    );
    this.lastProfileRefusalLog = now;
    this.profileRefusals = 0;
  }

  private writeBridgeFile(port: number, token: string, lastActivityAt = this.lastActivityAt): string {
    // 0700 dir + 0600 file: the bridge token IS the handshake secret, so it must
    // not be world-/group-readable — esp. on a 0755-home Linux box where the file mode is
    // the only barrier. mode on mkdir/write is umask-masked, so chmod explicitly too.
    mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(BRIDGE_DIR, 0o700); } catch { /* best-effort */ }
    const bridgeFile = join(BRIDGE_DIR, `${process.pid}.json`);
    writeFileSync(bridgeFile, JSON.stringify({
      port,
      token,
      pid: process.pid,
      cwd: process.cwd(),
      startedAt: this.startedAt,
      lastActivityAt,
    }), { mode: 0o600 });
    try { chmodSync(bridgeFile, 0o600); } catch { /* best-effort */ }
    return bridgeFile;
  }

  // Stamp the most-recent inbound activity and propagate it to the bridge file (debounced).
  // Called from the MCP CallTool handler so /health + the bridge file always reflect the
  // freshest tool dispatch — the signal a multi-bridge consumer elects on.
  public noteActivity(ts: number = Date.now()): void {
    if (this.stopped) return; // a stopped bridge must not resurrect its bridge file
    this.lastActivityAt = ts;
    this.touchBridgeFile();
  }

  // Re-write the bridge file with the current lastActivityAt, throttled to ≤1 FS write/sec
  // so a burst of tool calls can't hammer the disk. The first write happens in start();
  // this only refreshes lastActivityAt for the multi-bridge election.
  //
  // The throttle DEFERS; it must never drop. start() stamps lastBridgeWriteAt, and a freshly
  // spawned server takes its first tool call within a few hundred milliseconds — so the one
  // write that decides whether this server is ever reachable always landed inside the window,
  // and discarding it left the file saying `lastActivityAt: 0`. With that first call then parked
  // on the queue waiting for a browser, no second call ever arrived to rewrite it: the native
  // host kept electing whichever older server tied at zero with the lowest pid, and every call
  // this server made expired on the queue. That is the whole of "MCP fails every time".
  private touchBridgeFile(): void {
    if (this.stopped) return; // no re-advertising after teardown
    const now = Date.now();
    const since = now - this.lastBridgeWriteAt;
    if (since < BRIDGE_WRITE_INTERVAL) {
      if (!this.bridgeTouchTimer) {
        this.bridgeTouchTimer = setTimeout(() => {
          this.bridgeTouchTimer = null;
          this.touchBridgeFile();
        }, BRIDGE_WRITE_INTERVAL - since);
        this.bridgeTouchTimer.unref?.(); // never hold the process open for a discovery hint
      }
      return;
    }
    this.lastBridgeWriteAt = now;
    try {
      this.writeBridgeFile(this.actualPort, this.bridgeToken);
    } catch { /* bridge file is best-effort discovery — never throw on a tool path */ }
  }

  getHealth(): ConnectionHealth {
    return {
      connected: this.isReady,
      socketConnected: this.isConnected,
      latencyMs: this.latencyMs,
      uptime: this.connectTime > 0 && this.isReady ? Date.now() - this.connectTime : 0,
      reconnects: Math.max(0, this.reconnectCount),
      queueDepth: this.messageQueue.depth,
      lastActivityAt: this.lastActivityAt,
      version: PKG_VERSION,
      ...(this.extensionPermissions ? { extensionPermissions: this.extensionPermissions } : {}),
      ...(this.profiles.size > 0 || this.preferredProfileId !== null
        ? {
            profiles: {
              connected: this.isReady ? this.connectedProfileId : null,
              preferred: this.preferredProfileId,
              seen: this.profiles.list(),
            },
          }
        : {}),
    };
  }

  /** Profiles seen this run, most recently seen first, marking which holds the bridge. */
  listProfiles(): { connected: string | null; preferred: string | null; seen: ProfileRecord[] } {
    return {
      connected: this.isConnected ? this.connectedProfileId : null,
      preferred: this.preferredProfileId,
      seen: this.profiles.list(),
    };
  }

  /**
   * Choose which profile may hold the bridge, and release the current one if it is not that.
   *
   * The displaced extension backs off and retries, the wanted profile's extension is accepted on
   * its next attempt, and the rest keep being refused — the same loop contention refusal already
   * relies on. Nothing new reconnects; the preference just changes who wins.
   *
   * Passing null clears the preference, restoring first-come.
   */
  switchProfile(profileId: string | null): { switched: boolean; reason?: string } {
    if (this.switchRevertTimer) { clearTimeout(this.switchRevertTimer); this.switchRevertTimer = null; }

    if (profileId === null) {
      this.preferredProfileId = null;
      // Whatever is attached is now acceptable, so release anything queued behind the pin.
      if (this.isConnected) this.admitClient();
      return { switched: true };
    }
    if (!isProfileId(profileId)) {
      return { switched: false, reason: `"${profileId}" is not a profile id — use list_profiles to see them.` };
    }
    if (!this.profiles.has(profileId)) {
      return {
        switched: false,
        reason:
          `Profile ${profileId} has not connected to this server, so switching to it would leave the bridge empty. ` +
          `Open Chrome in that profile with the Crawlio extension enabled, then try again.`,
      };
    }

    this.preferredProfileId = profileId;
    if (this.connectedProfileId === profileId && this.isConnected) {
      this.admitClient();
      return { switched: true };
    }

    // The roster never forgets a profile, so "has connected at some point" is not "is running
    // now" — the browser may have quit hours ago. Rather than leave every extension refused
    // forever, give the wanted one a window to appear and put things back if it does not. The
    // alternative is a dead bridge for the life of the process, recoverable only by an agent that
    // happens to know to clear the pin.
    this.switchRevertTimer = setTimeout(() => {
      this.switchRevertTimer = null;
      if (this.connectedProfileId === profileId) return; // it arrived
      console.error(`[Bridge] Profile ${profileId} did not take the bridge within ${PROFILE_SWITCH_GRACE / 1000}s — clearing the preference`);
      this.preferredProfileId = null;
      if (this.isConnected) this.admitClient();
    }, PROFILE_SWITCH_GRACE);
    if (this.switchRevertTimer.unref) this.switchRevertTimer.unref();

    // Close rather than terminate: a clean close lets the extension's own reconnect path run.
    if (this.connectedProfileId) this.profiles.disconnect(this.connectedProfileId, new Date().toISOString());
    this.clientAdmitted = false;
    this.client?.close(WS_CLOSE_BRIDGE_BUSY, "switching profile");
    return { switched: true };
  }

  /**
   * Ask the extension which optional permissions it holds and cache the answer.
   *
   * Asked for the full optional set rather than the per-feature subset the tool gate uses: this
   * is a diagnostic, so the interesting case is precisely the one a feature gate hides — a
   * partial grant where browsing works but `nativeMessaging` is absent, leaving the extension
   * trust-on-first-use and the rogue-server defense inactive.
   */
  /**
   * Ask the socket that just connected what it is allowed to do, once it can actually be asked.
   *
   * This is housekeeping about one specific socket, so it must never take the offline queue: a
   * connection that is refused moments later would leave its permission check parked there, to be
   * delivered to whichever browser connects next and answered on that browser's behalf. Deferred
   * to the transmit-ready moment instead, which is also when the answer becomes meaningful.
   */
  private refreshPermissionsWhenReady(): void {
    this.permissionsRefreshPending = true;
    this.flushPermissionsRefresh();
  }

  private flushPermissionsRefresh(): void {
    if (!this.permissionsRefreshPending || !this.canTransmit) return;
    this.permissionsRefreshPending = false;
    this.refreshExtensionPermissions();
  }

  private refreshExtensionPermissions(): void {
    // queueWhenOffline:false so a socket that dies between the readiness check and here can never
    // strand this on the queue.
    this.send({ type: "check_permissions", permissions: ["tabs", "nativeMessaging"] } as never, 5000, { queueWhenOffline: false })
      .then((data) => {
        const d = data as { permissions?: Record<string, boolean>; missing?: { permissions?: string[] } } | null;
        if (!d?.permissions) return;
        const missing = d.missing?.permissions ?? [];
        this.extensionPermissions = {
          granted: missing.length === 0,
          permissions: d.permissions,
          missing,
        };
        if (missing.length) {
          console.error(`[Bridge] Extension is missing optional permission(s): ${missing.join(", ")}`);
        }
      })
      .catch(() => { /* diagnostic only — never disturb the connection */ });
  }

  push(data: unknown): void {
    if (!this.isConnected) return;
    this.client!.send(JSON.stringify(data), (err) => {
      if (err) console.error("[Bridge] Push failed:", err.message);
    });
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      // DNS-rebind guard: refuse any request whose Host header is not loopback,
      // before serving /setup, /health, or CORS preflight.
      if (!isAllowedHostHeader(req.headers.host)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (req.url === "/setup") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(buildSetupHTML(RESOLVED_INDEX_PATH));
        return;
      }
      if (req.url === "/health") {
        const origin = req.headers.origin;
        const corsOrigin = isAllowedHealthOrigin(origin);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Private-Network": "true",
        };
        if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
        res.writeHead(200, headers);
        // The bridge token is NOT disclosed here. Legitimate local clients
        // read it from the 0600 bridge file (~/.crawlio/bridges/<pid>.json); the
        // extension authenticates via its chrome-extension:// origin. /health is
        // liveness only.
        res.end(JSON.stringify({
          service: "crawlio-mcp",
          pid: process.pid,
          port: this.actualPort,
          ...this.getHealth(),
        }));
        return;
      }
      // CORS preflight for extension fetch (no host_permissions)
      if (req.method === "OPTIONS") {
        const origin = req.headers.origin;
        const corsOrigin = isAllowedHealthOrigin(origin);
        const headers: Record<string, string> = {
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Private-Network": "true",
          "Access-Control-Max-Age": "86400",
        };
        if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
        res.writeHead(204, headers);
        res.end();
        return;
      }
      res.writeHead(426);
      res.end("Upgrade Required");
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: 10 * 1024 * 1024, // 10 MB — prevents memory exhaustion
      verifyClient: (
        info: { origin?: string; secure: boolean; req: import("http").IncomingMessage },
        callback: (result: boolean, code?: number, message?: string) => void
      ) => {
        // DNS-rebind guard on the WS upgrade too: a rebound page presents a
        // non-loopback Host even when it carries a lifted token.
        if (!isAllowedHostHeader(info.req.headers.host)) {
          console.error(`[Bridge] WebSocket upgrade rejected: non-loopback Host ${String(info.req.headers.host)}`);
          callback(false, 403, "Forbidden");
          return;
        }
        // Token validation — extract from ?token=xxx query param (constant-time compare).
        let tokenValid = false;
        const reqUrl = info.req.url;
        if (reqUrl) {
          try {
            const clientToken = new URL(reqUrl, "http://localhost").searchParams.get("token");
            if (clientToken) {
              const a = Buffer.from(this.bridgeToken);
              const b = Buffer.from(clientToken);
              tokenValid = a.length === b.length && timingSafeEqual(a, b);
            }
          } catch { /* malformed URL — leave tokenValid false */ }
        }

        // Accept the EXTENSION (chrome-extension:// origin — unforgeable by a web page) or any
        // token-authenticated client; reject bare no-origin / localhost connections so an
        // unauthenticated local process can't evict the extension and drive/forge the session.
        // The same-user origin-forgery residual is out of scope (see the helper).
        if (isAcceptableWsClient(info.origin, tokenValid)) { callback(true); return; }
        // Reject with 403 (NOT 401) — 401 triggers Chrome's "HTTP Authentication failed" error
        console.error(`[Bridge] WebSocket connection rejected: no valid token and non-extension origin (${String(info.origin)})`);
        callback(false, 403, "Forbidden");
      },
    });

    // `ws` forwards HTTP-server bind errors through this emitter before the per-attempt HTTP
    // listener below receives them. Without a WSS listener, a saturated port range throws from
    // EventEmitter and strands bridge.start() before the stdio MCP transport can start. Consume
    // expected bind failures here; listenWalkingPortRange remains the owner of retry/logging.
    this.wss.on("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (!this.httpServer?.listening && (code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL")) return;
      console.error("[Bridge] WebSocket server error:", error.message);
    });

    this.wss.on("connection", (ws) => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        // Eviction exists so an extension whose transport died can reclaim the
        // bridge. Applied to a HEALTHY incumbent it becomes symmetric, and with
        // more than one legitimate client — several Chrome profiles, or a Web
        // Store build alongside an unpacked dev build — every victim reconnects
        // and evicts whoever replaced it. That livelock reached 211,042
        // evictions and a 67 MB unrotated server.err before it was found.
        //
        // So evict only an incumbent that has actually stopped answering.
        const silentFor = Date.now() - this.lastPong;
        if (this.lastPong > 0 && silentFor <= STALE_THRESHOLD) {
          this.refuseContendedConnection(ws);
          return;
        }
        console.error(`[Bridge] Evicting unresponsive client — no pong in ${Math.round(silentFor / 1000)}s`);
        this.client.terminate();
      }
      console.error(`[Bridge] Extension connected`);
      // Cancel grace timer — preserve pending commands for resolution on new connection.
      // The pending map is keyed by command ID: if the extension processed a command
      // before disconnecting, it can send the response on this new connection.
      if (this.reconnectGraceTimer) {
        clearTimeout(this.reconnectGraceTimer);
        this.reconnectGraceTimer = null;
        if (this.pending.size > 0) {
          console.error(`[Bridge] Reconnect within grace period — ${this.pending.size} pending commands preserved`);
        }
      }
      this.client = ws;
      this.reconnectCount++;
      this.connectTime = Date.now();
      this.lastPong = Date.now();
      this.latencyMs = 0;
      this.startHeartbeat();
      this.onClientConnected?.();

      ws.on("pong", () => {
        this.lastPong = Date.now();
        if (this.lastPingSent > 0) {
          this.latencyMs = this.lastPong - this.lastPingSent;
        }
      });

      // Nothing may be transmitted until this socket has our identity proof; see
      // handshakeSettled. The grace timer is the escape hatch for a client that never challenges.
      this.handshakeSettled = false;
      this.handshakeAckRequired = false;
      this.handshakeNonce = null;
      if (this.handshakeSettleTimer) clearTimeout(this.handshakeSettleTimer);
      this.handshakeSettleTimer = setTimeout(() => {
        this.handshakeSettleTimer = null;
        this.settleHandshake();
      }, HANDSHAKE_SETTLE_GRACE);

      // Admission waits for the `connected` identity frame below. Current extensions include a
      // profile or worker generation and are admitted immediately; legacy anonymous clients get
      // a short grace so a just-reloaded current worker can supersede them before queued work is
      // irreversibly transmitted to the retiring generation.
      this.clientAdmitted = false;

      ws.on("message", (raw) => {
        try {
          if (!this.rateLimiter.allow()) {
            ws.send(JSON.stringify({ error: "Rate limited. Max 60 commands/second.", code: "RATE_LIMITED" }));
            return;
          }
          const len = typeof raw === "string" ? Buffer.byteLength(raw) : (raw as Buffer).length;
          if (len > 5 * 1024 * 1024) {
            console.error(`[Bridge] Oversized message dropped: ${(len / 1024 / 1024).toFixed(1)} MB`);
            return;
          }
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          // Server-identity handshake: prove we hold the bridge token so a
          // client that knows the real token (via the authenticated native channel)
          // can reject a rogue listener that never read the 0600 bridge file. New
          // message type — ignored by older extensions, so non-breaking.
          if (parsed.type === HANDSHAKE_MESSAGE_TYPES.challenge && typeof parsed.nonce === "string") {
            this.handshakeNonce = parsed.nonce;
            // Bind OUR listening port into the proof so a relayed proof from a different
            // port fails the extension's expected-port check.
            void computeHandshakeProof(this.bridgeToken, parsed.nonce, this.actualPort).then(proof => {
              try {
                ws.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.handshake, proof }));
                // The proof is now ahead of anything queued, and WebSocket delivery is ordered, so
                // a legacy extension can retain the old proof-first behavior. Current extensions
                // explicitly ACK the verdict; only that acknowledgement releases their queue.
                if (ws === this.client && !this.handshakeAckRequired) this.settleHandshake();
              } catch { /* socket closed */ }
            }).catch(() => { /* crypto failed — drop; the extension times out and refuses */ });
            return;
          }
          if (parsed.type === HANDSHAKE_MESSAGE_TYPES.accepted) {
            const accepted = parsed.accepted === true;
            const nonceMatches = typeof parsed.nonce === "string" && parsed.nonce === this.handshakeNonce;
            if (ws === this.client && this.handshakeAckRequired && accepted && nonceMatches) {
              this.settleHandshake();
            } else if (ws === this.client && this.handshakeAckRequired && !accepted && nonceMatches) {
              console.error("[Bridge] Extension rejected identity proof — retaining queued commands for reconnect");
            }
            return;
          }
          const msg = parsed as unknown as ExtensionResponse;
          if (msg.type === "refresh_port") {
            this.onPortRefreshRequested?.();
            return;
          }
          this.handleMessage(msg, ws);
        } catch (e) {
          console.error("[Bridge] Invalid message:", e);
        }
      });

      ws.on("error", (err) => {
        // Only log if this is still the active client (not an evicted stale connection)
        if (this.client === ws) {
          console.error("[Bridge] WebSocket error:", err.message);
        }
      });

      ws.on("close", (code, reason) => {
        // Guard: only act if THIS ws is still the active client.
        // When the extension reconnects, the old ws's close fires async
        // AFTER this.client already points to the new connection.
        if (this.client !== ws) {
          console.error("[Bridge] Stale client closed (already replaced)");
          return;
        }
        const closeReason = reason.toString("utf8").trim();
        console.error(
          `[Bridge] Extension disconnected (code ${code}${closeReason ? `: ${closeReason}` : ""})`,
        );
        this.stopHeartbeat();
        this.client = null;
        this.connectTime = 0;
        // The roster describes which browsers are reachable now, so a departed profile must stop
        // claiming to be connected — list_profiles, /health and doctor all read it verbatim, and
        // switchProfile would early-return "already there" for a profile that has quit.
        if (this.connectedProfileId) this.profiles.disconnect(this.connectedProfileId, new Date().toISOString());
        // Remember who the in-flight commands were addressed to. The grace below keeps them alive
        // on the bet that the same browser comes back and answers; if a different profile takes
        // the bridge instead, that bet is wrong and they have to be failed — see handleMessage.
        this.pendingProfileId = this.connectedProfileId;
        this.connectedProfileId = null;
        this.connectedExtensionId = null;
        this.connectedWorkerGeneration = null;
        this.clientAdmitted = false;
        this.handshakeSettled = false; // the next socket must prove itself before it gets anything
        this.handshakeAckRequired = false;
        this.handshakeNonce = null;
        this.permissionsRefreshPending = false; // that socket's permissions are no longer our question
        if (this.legacyAdmissionTimer) {
          clearTimeout(this.legacyAdmissionTimer);
          this.legacyAdmissionTimer = null;
        }
        if (this.handshakeSettleTimer) { clearTimeout(this.handshakeSettleTimer); this.handshakeSettleTimer = null; }
        // Grace period: wait for extension to reconnect before rejecting pending commands
        // Prevent premature session deletion on transport close
        if (this.pending.size > 0) {
          console.error(`[Bridge] ${this.pending.size} pending commands — waiting ${WS_RECONNECT_GRACE / 1000}s for reconnect`);
          this.reconnectGraceTimer = setTimeout(() => {
            this.reconnectGraceTimer = null;
            for (const [id, req] of this.pending) {
              clearTimeout(req.timer);
              req.reject(notConnected("Extension disconnected"));
              this.pending.delete(id);
            }
          }, WS_RECONNECT_GRACE);
        }
      });
    });

    this.wss.on("wsClientError", (err: Error, socket: import("stream").Duplex) => {
      console.error("[Bridge] WebSocket handshake error:", err.message);
      socket.destroy();
    });

    // Clean stale bridge files from dead processes
    cleanStaleBridgeFiles();

    // Dynamic port selection — find first free port in range
    const requestedPort = parseInt(process.env.CRAWLIO_PORT || "", 10);
    const startPort = (requestedPort >= WS_PORT && requestedPort <= WS_PORT_MAX)
      ? requestedPort : WS_PORT;
    // Smart start port: findAvailablePort health-probes the range and reuses our OWN pid's
    // zombie port. It throws if every port looks busy — but a busy PROBE can be a race, so we
    // still walk-and-bind from WS_PORT rather than give up here.
    let firstCandidate = startPort;
    try {
      firstCandidate = await findAvailablePort(startPort);
    } catch {
      firstCandidate = startPort;
    }

    // Bind the bridge, WALKING the port range on collision. A busy port must NEVER crash the
    // MCP stdio server (that was the disconnect bug: EADDRINUSE escaped to uncaughtException →
    // process.exit). If the whole range is taken we start WITHOUT a bridge — send() degrades
    // via its isConnected guard (browser tools report "extension not connected") instead of dying.
    const boundPort = await listenWalkingPortRange(this.httpServer!, firstCandidate, WS_PORT_MAX, WS_HOST);
    if (boundPort !== null) {
      this.actualPort = boundPort;
      console.error(`[Bridge] WebSocket server listening on ws://${WS_HOST}:${boundPort}`);
      // Write bridge file for extension discovery
      this.writeBridgeFile(this.actualPort, this.bridgeToken);
      this.lastBridgeWriteAt = Date.now();
    } else {
      console.error(
        `[Bridge] all ports ${WS_PORT}-${WS_PORT_MAX} busy — starting WITHOUT a browser bridge; ` +
        `browser tools will report offline until a port frees. MCP stdio server stays up.`,
      );
    }

    // Cleanup on exit. Kept on the instance so stop() can unregister: production runs one bridge
    // per process, but tests start many, and without removal each one leaves three process
    // listeners behind — enough to trip Node's MaxListeners warning and mask a real leak.
    this.exitCleanup = () => removeBridgeFile();
    process.on("SIGTERM", this.exitCleanup);
    process.on("SIGINT", this.exitCleanup);
    process.on("beforeExit", this.exitCleanup);
  }

  get isConnected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  /** Whether the current socket is safe and eligible to receive MCP commands. */
  get isReady(): boolean {
    return this.canTransmit;
  }

  /**
   * Connected AND cleared to receive commands.
   *
   * Distinct from isConnected, which stays the answer to "is an extension attached" for /health
   * and the status surfaces. A socket that has not yet said which profile it is, while a profile
   * is pinned, is attached but must not be sent anything.
   */
  private get canTransmit(): boolean {
    return this.isConnected && this.clientAdmitted && this.handshakeSettled;
  }

  /**
   * Fail in-flight commands that the newly-arrived browser cannot possibly answer.
   *
   * A disconnect keeps pending commands alive through the reconnect grace, because the usual case
   * is the same extension bouncing and coming back to answer them. With two Chrome profiles
   * competing for one bridge that assumption breaks: the command was transmitted to profile A,
   * A's socket died, and B took the bridge. B never saw it, so nothing will ever resolve it and
   * the caller sat out its whole timeout — a 30-second wait for an answer that could not come.
   * Failing it here turns that into an immediate, accurate error the caller can act on.
   */
  private failPendingOnProfileTakeover(profileId: string | null): void {
    if (!profileId || !this.pendingProfileId || profileId === this.pendingProfileId) {
      // Same browser back, or nothing to attribute — the grace period's own bet still stands.
      if (profileId) this.pendingProfileId = null;
      return;
    }
    const orphaned = this.pending.size;
    this.pendingProfileId = null;
    if (orphaned === 0) return;
    console.error(`[Bridge] Profile ${profileId} took the bridge — failing ${orphaned} command(s) sent to the previous profile`);
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(notConnected("A different Chrome profile took the bridge before this command was answered"));
      this.pending.delete(id);
    }
  }

  /**
   * The socket has our identity proof (or has proved it will never ask) — release the queue.
   *
   * Idempotent, and safe to call from either the proof callback or the grace timer, whichever
   * gets there first.
   */
  private settleHandshake(): void {
    if (this.handshakeSettleTimer) { clearTimeout(this.handshakeSettleTimer); this.handshakeSettleTimer = null; }
    if (this.handshakeSettled) return;
    this.handshakeSettled = true;
    if (this.clientAdmitted) this.drainQueue();
    this.flushPermissionsRefresh();
  }

  get queueDepth(): number { return this.messageQueue.depth; }

  /**
   * Hand the queued commands to the connected extension.
   *
   * Split out of the connection handler because with a profile pinned the drain must wait until
   * the socket has identified itself — draining on connect sent commands intended for the chosen
   * profile to whichever extension reconnected first, and attributed the results to the wrong one.
   */
  private drainQueue(): void {
    // Called from every point that could unblock the queue — connection, admission, handshake
    // settle — because none of them alone means the queue may move. Whichever lands last does the
    // draining; the earlier ones return here.
    if (!this.canTransmit) return;
    if (this.messageQueue.depth === 0) return;
    console.error(`[Bridge] Draining ${this.messageQueue.depth} queued messages`);
    this.messageQueue.drain((msg, resolve, reject, commandTimeoutMs) => {
      return new Promise<void>((txResolve, txReject) => {
        if (!this.canTransmit) { txReject(new Error("Disconnected during drain")); return; }
        const parsed = JSON.parse(msg) as ServerCommand;
        const timer = setTimeout(() => {
          this.pending.delete(parsed.id);
          reject(Object.assign(new Error(`Queued command timed out: ${parsed.type}`), { problem: "timeout" satisfies ProblemCode }));
        }, commandTimeoutMs);
        this.pending.set(parsed.id, { resolve, reject, timer });
        this.client!.send(msg, (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(parsed.id);
            txReject(err);
          } else {
            txResolve(); // Transmission confirmed — response handled by pending map
          }
        });
      });
    }).catch((e) => console.error("[Bridge] Queue drain error:", e));
  }

  /**
   * Admit the connected socket, releasing anything queued for it.
   *
   * Called once a socket has proved to be the profile the agent asked for. Idempotent, because a
   * re-identifying extension sends `connected` more than once.
   */
  private admitClient(): void {
    if (this.legacyAdmissionTimer) {
      clearTimeout(this.legacyAdmissionTimer);
      this.legacyAdmissionTimer = null;
    }
    if (this.clientAdmitted) return;
    this.clientAdmitted = true;
    this.drainQueue();
    this.flushPermissionsRefresh();
  }

  async send(
    command: Omit<ServerCommand, "id"> & Record<string, unknown>,
    timeout: number = TIMEOUTS.WS_COMMAND,
    opts: SendOptions = {},
  ): Promise<unknown> {
    const id = randomUUID();
    const fullCommand = { ...applyTargetTab(command), id } as ServerCommand;
    const serialized = JSON.stringify(fullCommand);

    if (!this.canTransmit) {
      // An admitted socket that is only waiting on the handshake has a browser behind it; the
      // wait is the ~1ms it takes to answer a challenge. Treating that as "offline" would make a
      // probe report no browser, and would put a 45-second floor on a millisecond wait.
      const settling = this.isConnected && this.clientAdmitted && !this.handshakeSettled;

      // A probe asks a question whose offline answer is already known, so waiting out the queue
      // floor buys nothing and costs the caller 45 seconds. Fail it now and let the caller
      // degrade, which is what every probe call site already does in its catch.
      if (opts.queueWhenOffline === false && !settling) {
        return Promise.reject(notConnected(`Extension not connected: ${command.type}`));
      }
      const why = settling ? "settling identity handshake" : this.isConnected ? "awaiting profile identity" : "offline";
      console.error(`[Bridge] Queuing command (${why}): ${command.type} (queue depth: ${this.messageQueue.depth + 1})`);
      // Only a genuinely absent browser needs the floor — it covers the extension arriving late.
      const queueTimeout = settling ? timeout : Math.max(timeout, 45_000);
      return this.messageQueue.enqueue(serialized, queueTimeout, timeout);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(
          new Error(`Command timed out after ${timeout}ms: ${command.type}`),
          { problem: "timeout" satisfies ProblemCode }
        ));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.client!.send(serialized, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private handleMessage(msg: ExtensionResponse, ws: WebSocket): void {
    // Extension-initiated actions (fire-and-forget, no response expected)
    if (msg.type === "open_crawlio_app") {
      import("child_process").then(({ execFile }) => {
        execFile("open", ["-a", "Crawlio"], () => {});
      }).catch(() => {});
      return;
    }

    if (msg.type === "connected") {
      // Only the socket that currently holds the bridge may identify. `ws` keeps emitting
      // messages while it is CLOSING, and a replacement socket is admitted in the meantime, so a
      // late `connected` from the outgoing socket would otherwise close its replacement — handing
      // any extension a repeatable way to evict the healthy incumbent.
      if (ws !== this.client) return;

      // Protocol v2: the extension will tell us whether it accepted the proof. Cancel the legacy
      // grace path so a stale-token connection can never receive queued work before that verdict.
      if (msg.handshakeAck === true) {
        this.handshakeAckRequired = true;
        if (this.handshakeSettleTimer) {
          clearTimeout(this.handshakeSettleTimer);
          this.handshakeSettleTimer = null;
        }
      }

      const profileId = isProfileId(msg.profileId) ? msg.profileId : null;
      const extensionId = typeof msg.extensionId === "string" ? msg.extensionId.slice(0, 128) : "unknown";
      const workerGeneration = parseWorkerGeneration(msg.workerGeneration);
      const now = new Date().toISOString();

      // Identity is set once per socket. Going from unidentified to identified is expected — the
      // extension re-identifies when its stored profile id resolves after connecting — but a
      // socket changing which profile it claims is not, and would let one connection fill the
      // roster with fabricated profiles.
      if (profileId && this.connectedProfileId && profileId !== this.connectedProfileId) {
        console.error(`[Bridge] Ignoring profile change ${this.connectedProfileId} -> ${profileId} on a live socket`);
        return;
      }

      if (profileId) this.profiles.observe(profileId, extensionId, now);

      // A pinned profile decides who may drive the browser. Anything else is released so the
      // wanted extension can take the socket — including a client that declines to identify,
      // which would otherwise hold the bridge simply by staying anonymous.
      if (this.preferredProfileId !== null && profileId !== this.preferredProfileId) {
        if (profileId) this.profiles.disconnect(profileId, now);
        this.noteProfileRefusal();
        // Same close code as contention, so the extension treats it as "someone else has it".
        ws.close(WS_CLOSE_BRIDGE_BUSY, "another Chrome profile is selected");
        return;
      }

      if (profileId) this.connectedProfileId = profileId;
      this.connectedExtensionId = extensionId;
      if (workerGeneration) this.connectedWorkerGeneration = workerGeneration;
      console.error(`[Bridge] Extension identified: ${extensionId}${profileId ? ` (profile ${profileId})` : ""}`);
      this.failPendingOnProfileTakeover(profileId);
      if (this.switchRevertTimer) { clearTimeout(this.switchRevertTimer); this.switchRevertTimer = null; }
      // A current, fully hydrated extension identifies its persisted profile, so it is safe to
      // release queued work immediately. A worker-generation id alone is not sufficient: a
      // short-lived replacement can connect before its profile storage read resolves, then die
      // with the first command in flight. Wait for its follow-up identity frame instead.
      if (profileId) {
        this.admitClient();
      } else if (!this.legacyAdmissionTimer) {
        const legacySocket = ws;
        this.legacyAdmissionTimer = setTimeout(() => {
          this.legacyAdmissionTimer = null;
          if (this.client === legacySocket) this.admitClient();
        }, LEGACY_CLIENT_ADMISSION_GRACE);
        this.legacyAdmissionTimer.unref?.();
      }
      // Ask once what it actually holds, and cache it for /health. Best-effort: a failure here
      // must never affect the connection, so nothing is awaited and nothing is thrown.
      this.refreshPermissionsWhenReady();
      return;
    }

    if (msg.type === "pong") {
      // Application-level heartbeats pass through the MV3 service worker (unlike WebSocket
      // control frames), so their reply is also a liveness signal even when no request is
      // waiting in the command map.
      this.lastPong = Date.now();
      if (this.lastPingSent > 0) this.latencyMs = this.lastPong - this.lastPingSent;
      const req = this.pending.get(msg.id);
      if (req) {
        clearTimeout(req.timer);
        req.resolve("pong");
        this.pending.delete(msg.id);
      }
      return;
    }

    if (msg.type === "response") {
      const req = this.pending.get(msg.id);
      if (req) {
        clearTimeout(req.timer);
        if (msg.success) {
          req.resolve(msg.data ?? {});
        } else {
          const err = new Error(msg.error ?? "Unknown extension error");
          // Preserve permission-related fields from the extension response
          const wire = msg as unknown as Record<string, unknown>;
          const errObj = err as unknown as Record<string, unknown>;
          if (wire.permission_required) {
            errObj.permission_required = true;
            errObj.missing = wire.missing;
            errObj.suggestion = wire.suggestion;
          }
          // Machine-readable failure kind, so callers branch on cause not prose.
          if (isProblemCode(wire.problem)) errObj.problem = wire.problem;
          req.reject(err);
        }
        this.pending.delete(msg.id);
      }
      return;
    }

    console.error("[Bridge] Unrecognized message type:", msg.type);
  }

  async stop(): Promise<void> {
    this.stopped = true; // gate noteActivity/touchBridgeFile so we don't re-write the bridge file
    if (this.bridgeTouchTimer) { clearTimeout(this.bridgeTouchTimer); this.bridgeTouchTimer = null; }
    this.stopHeartbeat();
    if (this.reconnectGraceTimer) { clearTimeout(this.reconnectGraceTimer); this.reconnectGraceTimer = null; }
    if (this.contentionProbeTimer) { clearTimeout(this.contentionProbeTimer); this.contentionProbeTimer = null; }
    if (this.switchRevertTimer) { clearTimeout(this.switchRevertTimer); this.switchRevertTimer = null; }
    if (this.legacyAdmissionTimer) { clearTimeout(this.legacyAdmissionTimer); this.legacyAdmissionTimer = null; }
    this.profiles.disconnectAll(new Date().toISOString());
    this.connectedProfileId = null;
    this.connectedExtensionId = null;
    this.connectedWorkerGeneration = null;
    this.clientAdmitted = false;
    this.handshakeSettled = false;
    this.handshakeAckRequired = false;
    this.handshakeNonce = null;
    if (this.handshakeSettleTimer) { clearTimeout(this.handshakeSettleTimer); this.handshakeSettleTimer = null; }
    // Clear in-flight command timers so they can't fire after teardown.
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(notConnected("Bridge stopped"));
      this.pending.delete(id);
    }
    this.messageQueue.clear();
    this.client?.close();
    this.wss?.close();
    this.httpServer?.close();
    if (this.exitCleanup) {
      process.off("SIGTERM", this.exitCleanup);
      process.off("SIGINT", this.exitCleanup);
      process.off("beforeExit", this.exitCleanup);
      this.exitCleanup = null;
    }
    removeBridgeFile();
  }
}
