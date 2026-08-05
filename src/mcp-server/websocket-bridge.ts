import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "http";
import { randomUUID, timingSafeEqual } from "crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { WS_PORT, WS_PORT_MAX, WS_HOST, BRIDGE_DIR, TIMEOUTS, WS_HEARTBEAT_INTERVAL, WS_STALE_THRESHOLD, WS_RECONNECT_GRACE, PKG_VERSION } from "../shared/constants.js";
import { isProblemCode, type ServerCommand, type ExtensionResponse, type ProblemCode } from "../shared/protocol.js";
import { computeHandshakeProof, HANDSHAKE_MESSAGE_TYPES } from "../shared/bridge-handshake.js";

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

  enqueue(message: string, timeoutMs = DEFAULT_MSG_TIMEOUT): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        const oldest = this.queue.shift();
        if (oldest?.timer) clearTimeout(oldest.timer);
        oldest?.reject(notConnected("Queue overflow — message evicted"));
      }
      const item: QueuedMessage = { message, resolve, reject, enqueueTime: Date.now(), timeoutMs };
      this.queue.push(item);
      // Independent timeout — reject if not drained before expiry (prevents infinite hang when WS never connects)
      item.timer = setTimeout(() => {
        const idx = this.queue.indexOf(item);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(notConnected(`Queued message expired after ${timeoutMs}ms — extension not connected`));
        }
      }, timeoutMs);
    });
  }

  async drain(sendFn: (msg: string, resolve: (v: unknown) => void, reject: (e: Error) => void) => Promise<void>): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.timer) clearTimeout(item.timer); // leaving the queue — drop its expiry timer
      if (Date.now() - item.enqueueTime > item.timeoutMs) {
        item.reject(notConnected("Queued message expired"));
        continue;
      }
      try {
        // sendFn registers item.resolve/reject in the pending map, but the returned
        // promise resolves on transmission confirmation — not on response receipt.
        // This prevents head-of-line blocking: a slow response (e.g. 30s navigate)
        // no longer blocks subsequent queued items from being transmitted.
        await sendFn(item.message, item.resolve as (v: unknown) => void, item.reject as (e: Error) => void);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
        break; // Stop draining — connection likely lost, preserve remaining items
      }
      await new Promise(r => setTimeout(r, 50));
    }
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
  connected: boolean;
  latencyMs: number;
  uptime: number;
  reconnects: number;
  queueDepth: number;
  // Epoch ms of the last inbound MCP tool dispatch. Surfaced in /health and the
  // bridge file so a multi-bridge consumer can elect the most-recently-active server.
  lastActivityAt: number;
  version: string;
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
        if (err.code === "EADDRINUSE") console.error(`[Bridge] Port ${port} in use — trying next...`);
        else console.error(`[Bridge] listen error on ${port}: ${err.code ?? err.message}`);
        resolve(false); // once() auto-removed this handler; next iteration attaches a fresh one
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolve(true);
      });
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
  private lastBridgeWriteAt = 0;
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
        this.client.ping();
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
    try {
      ws.close(WS_CLOSE_BRIDGE_BUSY, "bridge busy — a live extension holds this session");
    } catch {
      // Already gone; nothing to close.
    }

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
  private touchBridgeFile(): void {
    if (this.stopped) return; // no re-advertising after teardown
    const now = Date.now();
    if (now - this.lastBridgeWriteAt < 1000) return;
    this.lastBridgeWriteAt = now;
    try {
      this.writeBridgeFile(this.actualPort, this.bridgeToken);
    } catch { /* bridge file is best-effort discovery — never throw on a tool path */ }
  }

  getHealth(): ConnectionHealth {
    return {
      connected: this.isConnected,
      latencyMs: this.latencyMs,
      uptime: this.connectTime > 0 && this.isConnected ? Date.now() - this.connectTime : 0,
      reconnects: Math.max(0, this.reconnectCount),
      queueDepth: this.messageQueue.depth,
      lastActivityAt: this.lastActivityAt,
      version: PKG_VERSION,
    };
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

      if (this.messageQueue.depth > 0) {
        console.error(`[Bridge] Draining ${this.messageQueue.depth} queued messages`);
        this.messageQueue.drain((msg, resolve, reject) => {
          return new Promise<void>((txResolve, txReject) => {
            if (!this.isConnected) { txReject(new Error("Disconnected during drain")); return; }
            const parsed = JSON.parse(msg) as ServerCommand;
            const timer = setTimeout(() => {
              this.pending.delete(parsed.id);
              reject(Object.assign(new Error(`Queued command timed out: ${parsed.type}`), { problem: "timeout" satisfies ProblemCode }));
            }, TIMEOUTS.WS_COMMAND);
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
            // Bind OUR listening port into the proof so a relayed proof from a different
            // port fails the extension's expected-port check.
            void computeHandshakeProof(this.bridgeToken, parsed.nonce, this.actualPort).then(proof => {
              try { ws.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.handshake, proof })); } catch { /* socket closed */ }
            }).catch(() => { /* crypto failed — drop; the extension times out and refuses */ });
            return;
          }
          const msg = parsed as unknown as ExtensionResponse;
          if (msg.type === "refresh_port") {
            this.onPortRefreshRequested?.();
            return;
          }
          this.handleMessage(msg);
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

      ws.on("close", () => {
        // Guard: only act if THIS ws is still the active client.
        // When the extension reconnects, the old ws's close fires async
        // AFTER this.client already points to the new connection.
        if (this.client !== ws) {
          console.error("[Bridge] Stale client closed (already replaced)");
          return;
        }
        console.error("[Bridge] Extension disconnected");
        this.stopHeartbeat();
        this.client = null;
        this.connectTime = 0;
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

    // Cleanup on exit
    const cleanup = () => removeBridgeFile();
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    process.on("beforeExit", cleanup);
  }

  get isConnected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  get queueDepth(): number { return this.messageQueue.depth; }

  async send(command: Omit<ServerCommand, "id"> & Record<string, unknown>, timeout: number = TIMEOUTS.WS_COMMAND): Promise<unknown> {
    const id = randomUUID();
    const fullCommand = { ...command, id } as ServerCommand;
    const serialized = JSON.stringify(fullCommand);

    if (!this.isConnected) {
      console.error(`[Bridge] Queuing command (offline): ${command.type} (queue depth: ${this.messageQueue.depth + 1})`);
      const queueTimeout = Math.max(timeout, 45_000);
      return this.messageQueue.enqueue(serialized, queueTimeout);
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

  private handleMessage(msg: ExtensionResponse): void {
    // Extension-initiated actions (fire-and-forget, no response expected)
    if (msg.type === "open_crawlio_app") {
      import("child_process").then(({ execFile }) => {
        execFile("open", ["-a", "Crawlio"], () => {});
      }).catch(() => {});
      return;
    }

    if (msg.type === "connected") {
      console.error(`[Bridge] Extension identified: ${msg.extensionId}`);
      return;
    }

    if (msg.type === "pong") {
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
    this.stopHeartbeat();
    if (this.reconnectGraceTimer) { clearTimeout(this.reconnectGraceTimer); this.reconnectGraceTimer = null; }
    if (this.contentionProbeTimer) { clearTimeout(this.contentionProbeTimer); this.contentionProbeTimer = null; }
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
    removeBridgeFile();
  }
}
