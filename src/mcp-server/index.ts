import { randomBytes } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import rateLimit from "express-rate-limit";
import { PKG_VERSION } from "../shared/constants.js";
import { WebSocketBridge } from "./websocket-bridge.js";
import { CrawlioClient } from "./crawlio-client.js";
import { createTools, createCodeModeTools, TOOL_TIMEOUTS, toolError, problemOf, ensurePermission, PERMISSION_EXEMPT_TOOLS } from "./tools.js";
import { loadActionPolicy, checkActionPolicy, initPolicyReloader, reloadPolicyIfChanged, type ActionPolicy } from "./action-policy.js";
import { applyToolResponseSafety, type ToolResponseEnvelope } from "./tool-response-safety.js";
import { resolveStdioLifecycleConfig, decideStdioIdleExit } from "./lifecycle.js";
import { startSessionTelemetry, recordToolCall } from "./telemetry.js";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

process.title = "Crawlio Agent";

// --- Crash/exit observability ---------------------------------------------------------------
// Disconnects used to be a black box: the process exited and the reason scrolled past in the
// client's MCP stderr log. Persist non-zero exits (with the last fatal reason) so any FUTURE
// disconnect is self-explaining, and surface the previous exit on startup.
const CRASH_LOG = join(homedir(), ".crawlio", "mcp-crash.log");
let lastFatalReason: string | null = null;

function recordExit(code: number | string, detail?: string | null): void {
  try {
    mkdirSync(dirname(CRASH_LOG), { recursive: true });
    appendFileSync(CRASH_LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, code, detail: detail ?? undefined }) + "\n");
  } catch { /* never throw from an exit path */ }
}

function logPreviousExitIfRecent(): void {
  try {
    if (!existsSync(CRASH_LOG)) return;
    const lines = readFileSync(CRASH_LOG, "utf-8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return;
    const rec = JSON.parse(last) as { ts?: string; code?: unknown; detail?: string };
    const ageMs = rec.ts ? Date.now() - Date.parse(rec.ts) : Infinity;
    if (ageMs < 15 * 60 * 1000) {
      console.error(`[MCP] previous exit: code=${String(rec.code)}${rec.detail ? ` — ${rec.detail}` : ""} (${Math.round(ageMs / 1000)}s ago)`);
    }
  } catch { /* best-effort */ }
}

// Record any non-zero exit (exit hooks must be synchronous — appendFileSync is).
process.on("exit", (code) => { if (code !== 0) recordExit(code, lastFatalReason); });

const initMode = process.argv.includes("init") || process.argv.includes("--setup") || process.argv.includes("setup");
if (initMode) {
  const { runInit } = await import("./init.js");
  await runInit(process.argv.slice(2));
  process.exit(0);
}

// `audit-egress` — read-only: what this process can connect to, and what identifies you.
// Audit before mitigation: report what leaves the machine before offering to change it.
if (process.argv.includes("audit-egress")) {
  const { runEgressAudit } = await import("./egress-audit.js");
  runEgressAudit(process.argv.slice(2));
  process.exit(0);
}

// `telemetry rotate` — replace the anonymous install id with a fresh one.
if (process.argv.includes("telemetry") && process.argv.includes("rotate")) {
  const [{ runTelemetryRotate }, { rotateInstallId }] = await Promise.all([
    import("./egress-audit.js"),
    import("./telemetry.js"),
  ]);
  runTelemetryRotate(rotateInstallId);
  process.exit(0);
}

// `doctor` — read-only health of bridge/portal/native-host/client configs.
// Dispatched before the WebSocketBridge exists, so a doctor run can never start a
// server, bind a port, or write bridge state.
if (process.argv.includes("doctor")) {
  const { runDoctor } = await import("./doctor.js");
  process.exit(await runDoctor(process.argv.slice(2)));
}

const codeMode = !process.argv.includes("--full");
if (process.argv.includes("--code-mode")) {
  console.error("[MCP] Note: --code-mode is now the default and can be removed");
}
const portalMode = process.argv.includes("--portal");
const portalPort = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 3001;
})();

const bridge = new WebSocketBridge();
const crawlio = new CrawlioClient();

// stdio idle-exit bookkeeping — shared between the CallTool handler and the
// idle-watch interval started in main(). serverStartedAt anchors the startup
// grace window; lastToolActivity/activeRequests track tool traffic.
const serverStartedAt = Date.now();
let lastToolActivity: number | null = null;
let activeRequests = 0;

// Stamp inbound-request activity for the idle watchdog and return the timestamp. Called for
// EVERY inbound MCP request (ListTools, CallTool, …) — not just tool dispatch — so a live but
// tool-idle client (one that only lists tools or pings) is never mistaken for a leaked,
// orphaned server and reaped by the idle-exit watchdog. Multi-bridge election still keys on
// genuine tool dispatch (see the CallTool finally), not mere request traffic.
function noteInboundRequest(): number {
  lastToolActivity = Date.now();
  return lastToolActivity;
}

// Resolve the connected tab's origin for content-boundary wrapping. bridge.send() raises a
// sub-3s timeout to a 45s floor when the bridge is offline (the queue lane in send()), so race
// the status probe against a 3s fallback — origin resolution must never block a tool response
// past its own 3s budget. Falls back to "unknown" when the probe is slow, offline, or fails.
async function resolveConnectedOrigin(): Promise<string> {
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  const probe = (bridge.send({ type: "get_connection_status" }, 3000) as Promise<{ connectedTab?: { url?: string } }>)
    .catch(() => ({} as { connectedTab?: { url?: string } }));
  const fallback = new Promise<{ connectedTab?: { url?: string } }>((resolve) => {
    fallbackTimer = setTimeout(() => resolve({}), 3000);
  });
  try {
    const status = await Promise.race([probe, fallback]);
    return status?.connectedTab?.url || "unknown";
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
  }
}

const tools = codeMode
  ? createCodeModeTools(bridge, crawlio, { getActionPolicy: () => reloadPolicyIfChanged() ?? actionPolicy })
  : createTools(bridge, crawlio);

if (!codeMode) {
  console.error("[MCP] Full mode — exposing all 114 tools");
} else {
  console.error(`[MCP] Code mode (default) — ${tools.length} tools (search, execute, connect_tab + async jobs: get_job_result, list_jobs, cancel_job)`);
}

// --- Action policy ---
let actionPolicy: ActionPolicy | null = null;
const policyPath = process.env.CRAWLIO_ACTION_POLICY;
if (policyPath) {
  try {
    actionPolicy = loadActionPolicy(policyPath);
    initPolicyReloader(policyPath, actionPolicy);
    console.error(`[MCP] Action policy loaded from ${policyPath} (default: ${actionPolicy.default})`);
  } catch (err) {
    console.error(`[MCP] Failed to load action policy from ${policyPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function createMcpServer(): Server {
  const s = new Server(
    { name: "crawlio-browser", version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  s.setRequestHandler(ListToolsRequestSchema, async () => {
    noteInboundRequest();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = randomBytes(4).toString("hex");
    const toolName = request.params.name;
    // Track in-flight tool requests so the stdio idle watcher never exits mid-call,
    // and stamp lastToolActivity on every exit path (success, error, or early return).
    activeRequests++;
    try {
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        return toolError(`[${requestId}] Unknown tool: ${toolName}`);
      }

      if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
        const check = await ensurePermission(bridge, toolName);
        if (!check.allowed) {
          return toolError(check.error!);
        }
      }

      // Action policy enforcement — hot-reload on each call
      const currentPolicy = reloadPolicyIfChanged() ?? actionPolicy;
      if (currentPolicy) {
        const decision = checkActionPolicy(toolName, currentPolicy);
        if (decision === "deny") {
          return toolError(`Action '${toolName}' denied by action policy`, "policy_denied");
        }
      }

      const timeout = TOOL_TIMEOUTS[toolName] ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const result = await Promise.race([
          tool.handler(request.params.arguments ?? {}),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () =>
              reject(new Error(`Tool '${toolName}' timed out after ${timeout}ms`))
            );
          }),
        ]);
        await applyToolResponseSafety({
          toolName,
          response: result as ToolResponseEnvelope,
          resolveOrigin: resolveConnectedOrigin,
        });
        return result as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ZodError) {
          const issues = error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
          const response = toolError(`[${requestId}] Invalid input: ${issues}`);
          await applyToolResponseSafety({ toolName, response });
          return response;
        }
        const msg = error instanceof Error ? error.message : String(error);
        const response = toolError(`[${requestId}] ${msg}`, problemOf(error));
        await applyToolResponseSafety({ toolName, response });
        return response;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      activeRequests--;
      const activityAt = noteInboundRequest();
      // Genuine tool dispatch → publish the activity signal to /health + the bridge file so a
      // multi-bridge consumer elects the most-recently-active server (debounced in noteActivity).
      bridge.noteActivity(activityAt);
      recordToolCall(); // anonymous aggregate counter only (no per-call network); see telemetry.ts
    }
  });

  return s;
}

async function main() {
  logPreviousExitIfRecent();
  try {
    await bridge.start();
  } catch (e) {
    // bridge.start() now degrades instead of throwing, but never let a bridge failure stop
    // the stdio server from coming up — Claude Code must stay connected regardless.
    console.error("[MCP] bridge.start() failed (continuing without browser bridge):", e instanceof Error ? e.message : e);
  }
  startSessionTelemetry(); // anonymous session heartbeat (no-op if CRAWLIO_TELEMETRY=0); see TELEMETRY.md

  bridge.onClientConnected = async () => {
    try {
      const port = await crawlio.getPort();
      bridge.push({ type: "set_crawlio_port", port });
      console.error(`[MCP] Pushed Crawlio port ${port} to extension`);
    } catch (e) {
      console.error("[MCP] Could not push Crawlio port:", e);
    }
  };

  bridge.onPortRefreshRequested = async () => {
    try {
      const port = await crawlio.getPort();
      bridge.push({ type: "set_crawlio_port", port });
      console.error(`[MCP] Port refresh: pushed Crawlio port ${port}`);
    } catch (e) { console.error("[MCP] Port refresh failed:", e); }
  };

  if (portalMode) {
    await startPortalServer(portalPort);
  } else {
    const transport = new StdioServerTransport();
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    console.error("[MCP] Crawlio Browser MCP server running (stdio)");

    // Clean shutdown — release the WebSocket bridge (and its port) before exit.
    // stdin 'end' and 'close' both fire on disconnect (and the idle watchdog may race them),
    // so guard against re-entrant bridge.stop() with a one-shot flag.
    let shuttingDown = false;
    const shutdown = async (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`[MCP] ${reason} — shutting down`);
      await bridge.stop();
      process.exit(0);
    };

    // Graceful stdin close: when Claude Code disconnects, stdin emits 'end'.
    // Without this handler, pending reads silently stop and the server lingers.
    // 'close' is the cheaper secondary "client gone" signal — handle both.
    process.stdin.on("end", () => void shutdown("stdin ended — client disconnected"));
    process.stdin.on("close", () => void shutdown("stdin closed — client disconnected"));

    // Idle-exit watchdog: a leaked stdio server with no MCP client should not
    // pin its bridge port forever. Tick periodically and exit once idle past the
    // lane's limit. A 0 tool-idle limit (e.g. --monitor) disables this entirely.
    const lifecycle = resolveStdioLifecycleConfig(process.argv, process.env);
    if (lifecycle.toolIdleExitMs > 0) {
      const idleTimer = setInterval(() => {
        const decision = decideStdioIdleExit({
          now: Date.now(),
          serverStartedAt,
          lastToolActivity,
          activeMcpRequests: activeRequests,
          toolIdleExitMs: lifecycle.toolIdleExitMs,
          startupIdleExitMs: lifecycle.startupIdleExitMs,
        });
        if (decision.shouldExit) {
          void shutdown(`idle ${decision.idleMs}ms ≥ ${decision.limitMs}ms (${decision.reason}, lane=${lifecycle.lane})`);
        }
      }, 30_000);
      // Don't let the watchdog itself keep the event loop (and process) alive.
      idleTimer.unref();
    }
  }
}

const PORTAL_CORS_ENV = process.env.PORTAL_CORS_ORIGINS;
const ALLOWED_ORIGINS: RegExp[] = [
  ...(PORTAL_CORS_ENV
    ? PORTAL_CORS_ENV.split(",").map(o => new RegExp(`^${o.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
    : []),
  /^https:\/\/dash\.cloudflare\.com$/,
  /^https:\/\/.*\.crawlio\.app$/,
  /^https:\/\/crawlio\.app$/,
  /^chrome-extension:\/\//,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/localhost(:\d+)?$/,
];

async function startPortalServer(port: number): Promise<void> {
  const app = createMcpExpressApp({ host: "127.0.0.1" });

  // CORS — explicit origin allowlist (cloudflared does NOT handle CORS for proxied traffic)
  app.use((req: IncomingMessage & { method?: string }, res: ServerResponse & { status: (code: number) => ServerResponse & { end: () => void } }, next: () => void) => {
    const origin = req.headers.origin;
    if (origin) {
      const allowed = ALLOWED_ORIGINS.some(o => o.test(origin));
      if (allowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
      }
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Rate limiting — 120 requests per minute per IP
  app.use(rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // --- SSE transport (deprecated, included for backward compatibility) ---
  const sseTransports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req: IncomingMessage, res: ServerResponse) => {
    // CRITICAL: Disable Cloudflare proxy buffering for SSE
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Cache-Control", "no-cache");
    const transport = new SSEServerTransport("/message", res);
    sseTransports.set(transport.sessionId, transport);

    // SSE keepalive — prevent Cloudflare proxy timeout (100s idle limit)
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 25_000);

    res.on("close", () => {
      clearInterval(keepalive);
      sseTransports.delete(transport.sessionId);
    });
    const sseServer = createMcpServer();
    await sseServer.connect(transport);
  });

  app.post("/message", async (req: IncomingMessage & { query?: Record<string, string> }, res: ServerResponse & { status: (code: number) => { json: (body: unknown) => void } }) => {
    const sessionId = req.query?.sessionId as string;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "Unknown session" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  // --- Streamable HTTP transport (current MCP standard) ---
  app.post("/mcp", async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // --- Health endpoint ---
  app.get("/health", (_req: IncomingMessage, res: ServerResponse & { json: (body: unknown) => void }) => {
    res.json({
      status: "ok",
      version: PKG_VERSION,
      mode: codeMode ? "code" : "full",
      transport: "portal",
      bridgeConnected: bridge.isConnected,
      toolCount: tools.length,
      uptime: process.uptime(),
    });
  });

  app.listen(port, "127.0.0.1", () => {
    console.error(`[MCP] Portal server listening on http://127.0.0.1:${port}`);
    console.error(`[MCP]   SSE:        GET  /sse + POST /message`);
    console.error(`[MCP]   Streamable: POST /mcp`);
    console.error(`[MCP]   Health:     GET  /health`);
  });
}

main().catch((e) => {
  lastFatalReason = `main: ${e instanceof Error ? e.message : String(e)}`;
  console.error("[MCP] Fatal:", e);
  process.exit(1);
});

// Prevent broken-pipe crashes: when Claude Code disconnects, writes to stdout/stderr
// throw EPIPE. Without these handlers, EPIPE becomes an uncaughtException → process.exit.
process.stdout.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") return; // expected on disconnect
  console.error("[MCP] stdout error:", err.message);
});
process.stderr.on("error", () => {}); // stderr errors are unrecoverable — swallow silently

// Crash diagnostics — log then crash for true exceptions (corrupted state).
process.on("uncaughtException", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  // EPIPE on stdout/stderr is normal during MCP disconnect — don't crash
  if (code === "EPIPE") return;
  // A WS-bridge port collision must NOT take down the stdio server — that was the disconnect
  // bug (EADDRINUSE from listen() → here → exit). The bridge now walks the port range itself
  // (websocket-bridge.ts); this is defense-in-depth for any bind error that still escapes:
  // log and keep serving. Browser tools degrade cleanly via the bridge's isConnected guard.
  if (code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL") {
    console.error(`[MCP] non-fatal listen error (${code}) — bridge port issue, MCP stays up:`, err.message);
    return;
  }
  lastFatalReason = `uncaughtException: ${err.message}`;
  console.error("[MCP] CRASH — uncaughtException:", err.stack ?? err.message);
  process.exit(1);
});

// Unhandled rejections: log but do NOT crash — these are typically race conditions
// (WebSocket close during pending command, timeout after disconnect) that are transient.
process.on("unhandledRejection", (reason) => {
  console.error("[MCP] unhandledRejection (non-fatal):", reason instanceof Error ? reason.message : reason);
});

// Graceful shutdown — release port on exit
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.error(`[MCP] ${sig} received, shutting down`);
    await bridge.stop();
    process.exit(0);
  });
}
