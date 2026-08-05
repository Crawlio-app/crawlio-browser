/// <reference path="../env.d.ts" />
// Background service worker — WebSocket client + command dispatcher
import { EnrichmentAccumulator } from "./enrichment-store";
import type { CookieEntry, FrameworkDetection } from "../shared/types";
import { DEVICE_PROFILES } from "../shared/device-profiles";
import { buildEvalParams as buildEvalParamsPure } from "../shared/frame-context";
import { putCapture, putNetworkEntries, putConsoleLogs, getConsoleLogs, clearAll } from "./capture-store";
import { resetIcon, setDynamicIcon, clearBadge, setTooltip } from "./icon-generator";

import { setupContextMenus, handleContextMenuClick } from "./context-menus";
import type { NetworkEntryInternal } from "./sensors/network-sensor";
// Runtime extension — _startTime is deleted on loadingFinished/Failed, _seq is a monotonic counter
type NetworkMapEntry = Omit<NetworkEntryInternal, '_startTime'> & { _startTime?: number; _seq?: number };
import { STEALTH_SCRIPT } from "./injected/stealth";
import { FRAMEWORK_HOOK_SCRIPT } from "./injected/framework-hooks";
import { detectFrameworkInPage } from "./injected/framework-detector";
import { inspectDataLayer } from "./injected/datalayer-inspector";
import { captureDOMSnapshot } from "./injected/dom-snapshot";
import { TRACKER_VENDORS, TRACKING_HEURISTIC_PATTERNS } from "../shared/tracking-vendors";
import { injectSerpOverlay, removeSerpOverlay } from "./injected/serp-overlay";
import { SERP_OVERLAY_CSS } from "./injected/serp-overlay-styles";
import {
  addTabToSessionGroup, claimTabIntoSession, renameSessionGroup, finalizeSession,
  pruneClosedTab, SESSION_GROUP_DEFAULT_TITLE, type FinalizeStatus,
} from "./session-groups";
import { installAgentCursorInPage } from "./injected/agent-cursor";
import { BridgeRetryGate, SingletonConnection, closeFailedHandshake, safeWebSocketSend, planBridgeConnections, type BridgeProbe } from "./bridge-discipline";
import { DOMAIN_ENABLE_PARAMS, mergeDomainState, type DomainEnableResult } from "./domain-state";
import { randomNonce, verifyHandshakeProof, evaluateServerTrust, HANDSHAKE_MESSAGE_TYPES } from "../shared/bridge-handshake";
import { MAX_EVAL_EXPRESSION_LENGTH, isProblemCode, type ProblemCode } from "../shared/protocol";
import { planIdleRelease, resolveIdleReleaseMs, MIN_IDLE_RELEASE_MS, DEFAULT_IDLE_RELEASE_MS } from "./idle-release";

if (__DEV__) console.log("[Crawlio] v3 — browser capture via MCP loaded");

class PermissionError extends Error {
  permission_required = true;
  missing: { permissions?: string[]; origins?: string[] };
  suggestion: string;
  constructor(message: string, missing: { permissions?: string[]; origins?: string[] }, suggestion: string) {
    super(message);
    this.missing = missing;
    this.suggestion = suggestion;
  }
}

// Silent enrichment accumulator — URL-keyed, FIFO eviction at 200
const accumulator = new EnrichmentAccumulator();

const WS_HOST = "127.0.0.1";
const WS_PORT_START = 9333;
// Inclusive end of the probe range. Servers only ever bind 9333..9342, so probing
// past 9342 is 57 dead WebSocket attempts per cycle. MUST stay equal to
// src/shared/constants.ts WS_PORT_MAX (cannot import it here — constants.ts evaluates
// os.homedir()/path at module load and this file builds as a browser IIFE).
const WS_PORT_END = 9342;
const RECONNECT_BASE = 3000;
const RECONNECT_CAP = 30000;
const RECONNECT_ALARM = "crawlio-reconnect";
// While connected, re-elect the active bridge this often: probe 9333..9342 and follow
// whichever live session is most recently active (a new MCP aggregator child may have
// taken over). The 30s RECONNECT_ALARM is only the SW-restart safety net. Raised from 4s
// to 12s — re-election only re-points an existing connection, so it needn't be aggressive.
const NEW_BRIDGE_SCAN_INTERVAL = 12000;
const BRIDGE_RETRY_START_INTERVAL = 1500;
const WS_HANDSHAKE_TIMEOUT = 5000;
const NETWORK_WRITE_DEBOUNCE = 500;
// Session storage fallback caps — only applied when IDB write fails
const SESSION_NETWORK_CAP = 500;
const SESSION_CONSOLE_CAP = 1000;

// Native Messaging transport.
const NATIVE_HOST = "com.crawlio.agent";
const NATIVE_PING_TIMEOUT = 10000; // 10s
const nativeConnection = new SingletonConnection<chrome.runtime.Port>((port) => {
  try { port.disconnect(); } catch { /* already disconnected */ }
}, wireNativePort);

const NETWORK_PRESETS: Record<string, { downloadKbps: number; uploadKbps: number; latencyMs: number }> = {
  "offline":    { downloadKbps: 0, uploadKbps: 0, latencyMs: 0 },
  "slow-3g":    { downloadKbps: 500, uploadKbps: 500, latencyMs: 2000 },
  "fast-3g":    { downloadKbps: 1500, uploadKbps: 750, latencyMs: 560 },
  "4g":         { downloadKbps: 4000, uploadKbps: 3000, latencyMs: 170 },
  "wifi":       { downloadKbps: 30000, uploadKbps: 15000, latencyMs: 2 },
};

// --- SW Lifecycle Hardening ---
// Port-based keepalive: self-connecting port keeps SW alive while sessions are active.
const KEEPALIVE_PORT_NAME = "crawlio-keepalive";
const PERSIST_INTERVAL = 10000; // 10s between state snapshots
const STATE_STALENESS_MS = 60000; // discard restored state older than 1min
let persistTimer: ReturnType<typeof setInterval> | null = null;
let keepalivePort: chrome.runtime.Port | null = null;
let apiKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
let newBridgeScanTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive() {
  if (keepalivePort) return; // already active
  try {
    keepalivePort = chrome.runtime.connect({ name: KEEPALIVE_PORT_NAME });
  } catch { /* extension context invalidated */
    keepalivePort = null;
    return; // Extension context invalid
  }
  keepalivePort.onDisconnect.addListener(() => {
    keepalivePort = null;
    // Must read lastError to clear it — Chrome logs "Unchecked runtime.lastError" if unread
    const _err = chrome.runtime.lastError;
    // Yield to Chrome's event loop before reconnecting — synchronous reconnect
    // inside onDisconnect is fragile (context may be invalidating).
    if (shouldStayAlive()) setTimeout(startKeepalive, 100);
  });
  // API keepalive: lightweight Chrome API call every 25s resets Chrome's 30s inactivity timer
  if (!apiKeepaliveTimer) {
    apiKeepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25_000);
  }
  startNewBridgeScan();
}

function stopKeepalive() {
  if (keepalivePort) {
    keepalivePort.disconnect();
    keepalivePort = null;
  }
  if (apiKeepaliveTimer) { clearInterval(apiKeepaliveTimer); apiKeepaliveTimer = null; }
  if (persistTimer) { clearInterval(persistTimer); persistTimer = null; }
  stopNewBridgeScan();
}

function shouldStayAlive(): boolean {
  return debuggerAttachedTabId !== null || getActiveAgentSessionCount() > 0 || accumulator.count() > 0 || networkCapturing || wsBridges.size > 0 || nativeConnection.current !== null;
}

// New-bridge fast discovery (see NEW_BRIDGE_SCAN_INTERVAL). Lives on the keepalive
// lifecycle so it only runs while connected and never burns cycles when the SW is idle.
function startNewBridgeScan(): void {
  if (newBridgeScanTimer) return;
  newBridgeScanTimer = setInterval(() => { rescanForNewBridges().catch(() => {}); }, NEW_BRIDGE_SCAN_INTERVAL);
}

function stopNewBridgeScan(): void {
  if (newBridgeScanTimer) {
    clearInterval(newBridgeScanTimer);
    newBridgeScanTimer = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === KEEPALIVE_PORT_NAME) {
    // Keep the port open — this prevents SW from sleeping
    port.onDisconnect.addListener(() => {
      // Must consume lastError to prevent "Unchecked runtime.lastError" console warning
      const _err = chrome.runtime.lastError;
    });
  }
});

async function persistState() {
  await accumulator.ensureQuota();
  const domainState = debuggerAttachedTabId !== null ? tabDomainState.get(debuggerAttachedTabId) ?? null : null;
  // Persist recording state (minus non-serializable fields: timeoutHandle, networkSnapshotKeys Set)
  const recordingState = activeRecording ? {
    sessionId: activeRecording.sessionId,
    startedAt: activeRecording.startedAt,
    _startedAtMs: activeRecording._startedAtMs,
    tabId: activeRecording.tabId,
    initialUrl: activeRecording.initialUrl,
    initialFramework: activeRecording.initialFramework,
    maxDurationSec: activeRecording.maxDurationSec,
    maxInteractions: activeRecording.maxInteractions,
    pages: activeRecording.pages,
    currentPageUrl: activeRecording.currentPageUrl,
    totalInteractions: activeRecording.totalInteractions,
    networkSnapshotKeys: Array.from(activeRecording.networkSnapshotKeys),
    consoleSnapshotIndex: activeRecording.consoleSnapshotIndex,
  } : null;
  try {
    await chrome.storage.session.set({
      "crawlio:sw-state": {
        debuggerAttachedTabId,
        accumulatorData: accumulator.getAll(),
        networkCapturing,
        domainState,
        wasEverConnected,
        recordingState,
        timestamp: Date.now(),
      },
    });
  } catch (err) {
    // Callers treat persistState as fire-and-forget; a quota/context failure here means
    // connections and recordings will NOT survive the next SW restart — say so.
    console.warn("[Crawlio] State persist failed — state may not survive SW restart:", err);
    throw err;
  }
}

async function restoreState() {
  const data = await chrome.storage.session.get("crawlio:sw-state");
  const state = data["crawlio:sw-state"];
  if (!state || Date.now() - state.timestamp > STATE_STALENESS_MS) return;

  // Restore wasEverConnected so SW restart retries indefinitely
  if (state.wasEverConnected) wasEverConnected = true;

  for (const enrichment of state.accumulatorData || []) {
    accumulator.upsert(enrichment.url, enrichment);
  }

  // SW restart recovery: debugger is lost on SW termination, but the tab may still exist.
  // Try to re-attach if the previous session had an active debugger.
  if (state.debuggerAttachedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(state.debuggerAttachedTabId);
      if (tab?.url?.startsWith("http") && !tab.discarded) {
        // Tab still exists — attempt re-attach + re-enable domains
        await ensureDebugger(state.debuggerAttachedTabId, true);
        // Restore connectedTab state so MCP tools work
        await chrome.storage.session.set({ "crawlio:connectedTab": {
          tabId: tab.id!, url: tab.url || "", title: tab.title || "Untitled",
          favIconUrl: tab.favIconUrl, windowId: tab.windowId,
        }});
        writeStatus({ capturing: false, activeTabId: tab.id! });
        if (__DEV__) console.log(`[Crawlio] SW recovery: re-attached to tab ${state.debuggerAttachedTabId}`);
      } else {
        // Tab is not HTTP — clear stale state
        await chrome.storage.session.remove("crawlio:connectedTab");
        writeStatus({ capturing: false, activeTabId: null });
      }
    } catch {
      // Tab was closed or re-attach failed — clear stale state
      // Access lastError to suppress Chrome's "Unchecked runtime.lastError" warning
      void chrome.runtime.lastError;
      await chrome.storage.session.remove("crawlio:connectedTab");
      writeStatus({ capturing: false, activeTabId: null });
    }
  } else if (state.networkCapturing) {
    // Had capturing state but no debugger — clear stale UI
    await chrome.storage.session.remove("crawlio:connectedTab");
    writeStatus({ capturing: false, activeTabId: null });
  }

  // Restore active recording if one was in progress
  if (state.recordingState) {
    const rs = state.recordingState;
    const startedAt = typeof rs._startedAtMs === 'number' ? rs._startedAtMs : 0;
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = (rs.maxDurationSec * 1000) - elapsedMs;

    if (remainingMs <= 0) {
      // Recording already exceeded max duration — auto-stop immediately
      // Reconstruct just enough state for stopRecordingInternal to finalize
      activeRecording = {
        ...rs,
        timeoutHandle: setTimeout(() => {}, 0), // dummy, cleared immediately
        networkSnapshotKeys: new Set(rs.networkSnapshotKeys || []),
      };
      autoStopRecording("max_duration");
    } else if (debuggerAttachedTabId === rs.tabId) {
      // Tab re-attached successfully — restore recording with new timeout
      activeRecording = {
        ...rs,
        timeoutHandle: setTimeout(() => autoStopRecording("max_duration"), remainingMs),
        networkSnapshotKeys: new Set(rs.networkSnapshotKeys || []),
      };
      showRecordingIndicator(rs.tabId);
      if (__DEV__) console.log(`[Crawlio] SW recovery: restored recording ${rs.sessionId}, ${Math.round(remainingMs / 1000)}s remaining`);
    } else {
      // Tab gone or re-attach failed — auto-stop as disconnected
      activeRecording = {
        ...rs,
        timeoutHandle: setTimeout(() => {}, 0),
        networkSnapshotKeys: new Set(rs.networkSnapshotKeys || []),
      };
      autoStopRecording("tab_disconnected");
    }
  }

  if (accumulator.count() > 0) {
    startKeepalive();
    startPersistTimer();
  }
}

function startPersistTimer() {
  if (persistTimer) return;
  persistTimer = setInterval(() => { persistState().catch(() => {}); }, PERSIST_INTERVAL);
}

// Restore state on SW startup (before any other async work)
restoreState().catch(() => {});

// --- Message Port Lifecycle ---
const activePorts = new Map<number, chrome.runtime.Port>(); // tabId → port

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "crawlio-content") return;
  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  activePorts.set(tabId, port);

  port.onDisconnect.addListener(() => {
    activePorts.delete(tabId);
    if (chrome.runtime.lastError) {
      if (__DEV__) console.warn(`[Crawlio] Port disconnected for tab ${tabId}:`, chrome.runtime.lastError.message);
    }
  });

});

// --- CDP Error Classification ---
enum CDPError {
  Disconnected = "disconnected",       // "not connected to DevTools", "Debugger is not attached", "detached"
  TargetClosed = "target_closed",      // "Cannot attach to this target", "no tab"
  TargetCrashed = "target_crashed",    // "tab crashed", "crashed"
  NotFound = "not_found",             // "not found", "no node"
  InvalidParam = "invalid_param",      // "invalid", "missing", "Another debugger"
  InternalError = "internal_error",    // "internal", "inspector error"
  Timeout = "timeout",                 // "timed out", "timeout"
  Unknown = "unknown",
}

// Map a thrown error to the wire-level problem code. sendCDPCommand attaches its own
// classification to the errors it throws; the rest is derived from the refusals raised here.
// In-flight CDP commands — guards idle release against detaching mid-command.
let cdpCommandsInFlight = 0;

function classifyProblem(e: unknown, msg: string): ProblemCode {
  const attached = (e as { cdpError?: unknown }).cdpError;
  if (isProblemCode(attached)) return attached;
  if (msg === OPT_OUT_ERROR) return "opt_out";
  if (/non-HTTP pages|No HTTP tab available/i.test(msg)) return "restricted_page";
  // CDPError's values are the first eight ProblemCodes, but validate rather than cast:
  // an enum member added on one side must not put an unknown code on the wire.
  const classified: string = classifyCDPError(e);
  return isProblemCode(classified) ? classified : "unknown";
}

function classifyCDPError(error: unknown): CDPError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("not attached") || lower.includes("not connected") || lower.includes("detached") || lower.includes("disconnected")) return CDPError.Disconnected;
  if (lower.includes("target closed") || lower.includes("cannot attach") || lower.includes("no tab")) return CDPError.TargetClosed;
  if (lower.includes("target_crashed") || lower.includes("tab crashed") || lower.includes("crashed")) return CDPError.TargetCrashed;
  // DOM queries
  if (lower.includes("not found") || lower.includes("no node") || lower.includes("could not find")) return CDPError.NotFound;
  if (lower.includes("invalid") || lower.includes("missing") || lower.includes("another debugger")) return CDPError.InvalidParam;
  if (lower.includes("internal") || lower.includes("inspector error")) return CDPError.InternalError;
  if (lower.includes("timeout") || lower.includes("timed out")) return CDPError.Timeout;
  return CDPError.Unknown;
}

// Recovery cases for CDP patterns: disconnect→re-attach→retry, "already attached" swallow,
// "detached while handling" skip.
async function sendCDPCommand<T>(
  target: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
  maxRetries = 2,
  timeoutMs = 10000,
  _isRecovery = false
): Promise<T> {
  const retryableErrors = new Set([CDPError.Disconnected, CDPError.Timeout]);

  // lastCommandTime only advances on COMPLETION, so a command running longer than the idle
  // window would look like silence and have its debugger detached out from under it.
  // Count what is in flight and treat that as activity.
  cdpCommandsInFlight++;
  try {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        chrome.debugger.sendCommand(target, method, params),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("CDP command timeout")), timeoutMs);
        }),
      ]);
      clearTimeout(timeoutId);
      lastCommandTime = Date.now();
      return result as T;
    } catch (error) {
      clearTimeout(timeoutId);
      const classified = classifyCDPError(error);
      const msg = error instanceof Error ? error.message : String(error);

      // Case 1: Detached while handling — mid-flight, skip retry
      if (classified === CDPError.Disconnected && /detached while handling/i.test(msg)) {
        throw Object.assign(new Error(`CDP ${method} failed: detached mid-flight`), { cdpError: classified, original: error });
      }

      // Case 2: Disconnected + tabId — re-attach with backoff
      if (classified === CDPError.Disconnected && target.tabId && !_isRecovery) {
        const RECOVERY_TIMEOUTS = [1000, 3000, 5000];
        let recovered = false;
        for (const rTimeout of RECOVERY_TIMEOUTS) {
          try {
            await chrome.debugger.detach(target).catch(() => {});
            // Recovery re-attaches a tab that is already tracked; routing through
            // attachDebugger() would see it in attachedTabs and return without actually
            // re-establishing the dead CDP session.
            // eslint-disable-next-line no-restricted-syntax
            await chrome.debugger.attach(target, "1.3");
            // Guard against onDetach race clearing tabDomainState
            const prevDomains = tabDomainState.get(target.tabId!);
            if (prevDomains) {
              // d.domain is already the full CDP method ("Page.enable") — replay verbatim,
              // restoring the params the original enable needed.
              for (const d of [...prevDomains.required, ...prevDomains.optional].filter(d => d.success)) {
                await sendCDPCommand(target, d.domain, DOMAIN_ENABLE_PARAMS[d.domain] ?? {}, 0, rTimeout).catch(() => {});
              }
            } else {
              // Fallback: always re-enable core domains even if state was cleared
              await sendCDPCommand(target, "Page.enable", {}, 0, rTimeout);
              await sendCDPCommand(target, "Runtime.enable", {}, 0, rTimeout);
            }
            recovered = true;
            break;
          } catch {
            // Wait before next recovery attempt — page may still be loading
            await new Promise(r => setTimeout(r, rTimeout));
          }
        }
        if (recovered) {
          return await sendCDPCommand<T>(target, method, params, 0, timeoutMs, true);
        }
        throw Object.assign(new Error(`CDP ${method} failed: recovery failed after ${RECOVERY_TIMEOUTS.length} attempts`), { cdpError: classified, original: error });
      }

      // Case 3: "Another debugger already attached" — throw so callers know
      if (classified === CDPError.InvalidParam && /already attached/i.test(msg)) {
        throw Object.assign(
          new Error("Another debugger is already attached to this tab. Close DevTools and retry."),
          { cdpError: classified, original: error }
        );
      }

      // Case 4: Normal retry with backoff
      if (!retryableErrors.has(classified) || attempt === maxRetries) {
        throw Object.assign(new Error(`CDP ${method} failed: ${classified}`), { cdpError: classified, original: error });
      }

      // Exponential backoff: 500ms, 1000ms, 2000ms
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  throw new Error("unreachable");
  } finally {
    cdpCommandsInFlight--;
  }
}

// --- CDP Frame Traversal ---
interface FrameInfo {
  id: string;
  parentId?: string;
  url: string;
  name: string;
  securityOrigin: string;
  children: FrameInfo[];
}

const frameTrees = new Map<number, Map<string, FrameInfo>>(); // tabId → frameId → FrameInfo
const frameContexts = new Map<number, Map<string, number>>(); // tabId → frameId → contextId

function getOrCreateFrameMap(tabId: number): Map<string, FrameInfo> {
  let map = frameTrees.get(tabId);
  if (!map) { map = new Map(); frameTrees.set(tabId, map); }
  return map;
}

function getOrCreateContextMap(tabId: number): Map<string, number> {
  let map = frameContexts.get(tabId);
  if (!map) { map = new Map(); frameContexts.set(tabId, map); }
  return map;
}

async function populateFrameTree(tabId: number): Promise<void> {
  try {
    const result = await sendCDPCommand<any>(
      { tabId }, "Page.getFrameTree", {}, 1
    );
    const frameTree = result?.frameTree;
    if (!frameTree?.frame?.id) return;

    const map = getOrCreateFrameMap(tabId);
    map.clear();

    // BFS traversal (stack-based approach)
    const queue: Array<{ node: any; parentId?: string }> = [{ node: frameTree }];
    while (queue.length > 0) {
      const { node, parentId } = queue.shift()!;
      const frame = node.frame;
      if (!frame?.id) continue;

      const info: FrameInfo = {
        id: frame.id,
        parentId,
        url: frame.url || "",
        name: frame.name || "",
        securityOrigin: frame.securityOrigin || "",
        children: [],
      };
      map.set(frame.id, info);

      // Link to parent
      if (parentId) {
        const parent = map.get(parentId);
        if (parent) parent.children.push(info);
      }

      // Enqueue children
      if (Array.isArray(node.childFrames)) {
        for (const child of node.childFrames) {
          queue.push({ node: child, parentId: frame.id });
        }
      }
    }
  } catch { /* best effort — frame tree may not be available yet */ }
}

async function getFrameContextId(tabId: number, frameId: string): Promise<number | undefined> {
  return getOrCreateContextMap(tabId).get(frameId);
}

// Execute JS expression in a specific frame's execution context
async function executeInFrame(
  tabId: number,
  frameId: string,
  expression: string
): Promise<unknown> {
  const contextId = await getFrameContextId(tabId, frameId);
  const params: Record<string, unknown> = {
    expression,
    returnByValue: true,
  };
  if (contextId !== undefined) {
    params.contextId = contextId;
  }
  const result = await sendCDPCommand<any>(
    { tabId },
    "Runtime.evaluate",
    params
  );
  return result?.result?.value;
}

// Build a tree-shaped FrameInfo[] from the flat map (root frames only)
function getFrameTree(tabId: number): FrameInfo[] {
  const map = frameTrees.get(tabId);
  if (!map) return [];
  // Root frames have no parentId
  return Array.from(map.values()).filter(f => !f.parentId);
}

// Single-bridge election: the extension attaches to at most ONE server at a time —
// the elected active bridge (see electActiveBridge). wsBridges is kept as a Map so the
// existing wsBridges.size / wsBridges.has(port) call-sites stay valid, but it holds AT
// MOST ONE socket (the elected one). activeBridgePort is that port (or null when none).
const wsBridges = new Map<number, WebSocket>();
let activeBridgePort: number | null = null;
// Sockets we are deliberately abandoning during a cutover / dropping for a failed
// identity handshake. onclose checks this so a planned close does NOT trigger the
// per-port reconnect. Keyed by the SOCKET (not the port) so a stale flag can never
// bleed onto a DIFFERENT socket that later reuses the same port, and it GCs itself.
const intentionalClose = new WeakSet<WebSocket>();
const connectingPorts = new Set<number>(); // ports with pending WebSocket handshake
// Per-port server-identity handshake state. `verified` flips true only when
// the server proves it holds the real bridge token under our trusted token.
const bridgeTrust = new Map<number, { nonce: string; verified: boolean }>();
// Per-port identity-handshake deadline. When a trusted token is held, a socket that
// does not prove its identity within WS_HANDSHAKE_TIMEOUT is dropped — so a silent
// rogue candidate can't linger and an unverified "active" bridge can't hold the slot.
const identityTimers = new Map<number, ReturnType<typeof setTimeout>>();
// The real bridge token, delivered ONLY through the authenticated native-messaging
// channel (set_crawlio_token). Null until provisioned — in which state discovery is
// trust-on-first-use exactly as before, so token provisioning is non-breaking.
let trustedBridgeToken: string | null = null;
// Hydrate the trusted token on service-worker startup (survives SW restarts).
chrome.storage.local.get("crawlio:bridgeToken").then(d => {
  const t = (d as Record<string, unknown>)["crawlio:bridgeToken"];
  if (typeof t === "string" && t) trustedBridgeToken = t;
}).catch(() => { /* storage unavailable — stay in TOFU mode */ });
let reconnectDelay = RECONNECT_BASE;
// Per-port reconnect backoff: a flapping server (accepts, then drops after open) must not
// produce a fixed-interval connect/close loop. Doubles per consecutive close, resets on open.
const portRetryDelays = new Map<number, number>();
let pendingDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

const tabDomainState = new Map<number, DomainEnableResult>();

// Tab-scoped keyboard state: pressed keys + modifier bitmask
interface KeyboardState {
  pressedKeys: Set<string>;
  modifiers: number;
}

const tabKeyboardState = new Map<number, KeyboardState>();

// AC-3: Site opt-out cache — key is `${tabId}:${url}`, value is boolean
const optOutCache = new Map<string, boolean>();
const OPT_OUT_ERROR = 'Site opted out of Crawlio capture via <meta name="crawlio-agent" content="disable">. Respect the site\'s preference.';

/**
 * Check if a site has opted out of Crawlio capture via meta tag.
 * Cached per tabId+URL, invalidated on navigation.
 * Fail-open: returns false if check errors (allow capture).
 */
async function checkSiteOptOut(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return false;
    const cacheKey = `${tabId}:${tab.url}`;
    const cached = optOutCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: '!!document.querySelector(\'meta[name="crawlio-agent"][content="disable"]\')',
        returnByValue: true,
      }
    ) as { result?: { value?: boolean } };

    const optedOut = result?.result?.value === true;
    if (optOutCache.size >= 500) {
      const oldest = optOutCache.keys().next().value;
      if (oldest !== undefined) optOutCache.delete(oldest);
    }
    optOutCache.set(cacheKey, optedOut);
    return optedOut;
  } catch {
    return false; // Fail-open
  }
}

function getKeyState(tabId: number): KeyboardState {
  let state = tabKeyboardState.get(tabId);
  if (!state) {
    state = { pressedKeys: new Set(), modifiers: 0 };
    tabKeyboardState.set(tabId, state);
  }
  return state;
}

// `debuggerAttachedTabId` = the *primary/foreground* tab (the one `connect_tab` targets
// and the capture pipeline is bound to). It is a fast cache of `crawlio:connectedTab`.
let debuggerAttachedTabId: number | null = null;
// Source of truth for *every* tab the debugger is currently attached to. Agent sessions
// attach background tabs here without disturbing the primary — enabling concurrent multi-tab
// control. The primary is always a member of this set (or null).
const attachedTabs = new Set<number>();
// Per-tab attach serialization — concurrent attaches to the same tab dedupe; attaches to
// different tabs run in parallel (replaces the old single global in-flight lock).
const attachLocks = new Map<number, Promise<void>>();

// Connection timing
let connectionStartTime: number | null = null; // Date.now() when connect_tab succeeds
let lastCommandTime: number | null = null; // Date.now() of last successful CDP command

// Promote a tab to primary/foreground. Only the genuine connect entry points call this
// (connect_tab, auto-connect, SW recovery) — session attaches never do, so they cannot
// steal the foreground capture pointer.
function markPrimaryTab(tabId: number): void {
  debuggerAttachedTabId = tabId;
  connectionStartTime = Date.now();
}

// Remove a tab from the attached set + per-tab CDP state. If it was the primary, the caller
// is responsible for the foreground-state reset (the large blocks gated on
// `=== debuggerAttachedTabId`); this only clears the membership + the pointer.
function forgetAttachedTab(tabId: number): void {
  attachedTabs.delete(tabId);
  tabDomainState.delete(tabId);
  if (debuggerAttachedTabId === tabId) debuggerAttachedTabId = null;
}

// Track which frame is "active" for implicit targeting by other MCP tools
let activeFrameId: string | null = null; // null = main frame

// Build Runtime.evaluate params with optional frame context injection
function buildEvalParams(
  tabId: number,
  expression: string,
  opts?: { returnByValue?: boolean; awaitPromise?: boolean; useFrameContext?: boolean }
): Record<string, unknown> {
  const ctxId = activeFrameId ? frameContexts.get(tabId)?.get(activeFrameId) : undefined;
  return buildEvalParamsPure(expression, activeFrameId, ctxId, opts);
}

// Network capture state
let networkCapturing = false;
let networkCaptureSeq = 0;

// AC-21: CSS coverage tracking
let cssCoverageActive = false;

// AC-22: JS code coverage tracking
let jsCoverageActive = false;
const networkEntries: Map<string, NetworkMapEntry> = new Map();

// Per-tab ARIA snapshot ref cache (ref string → backendDOMNodeId)
// backendDOMNodeId is per-renderer-process.
// Sending Tab A's ID to Tab B's CDP session misses or resolves wrong node.
// backendDOMNodeId === -1 means cursor-interactive element — resolve via refSelectorMap CSS selector
const tabAriaState = new Map<number, { refMap: Map<string, number>; refSelectorMap: Map<string, string>; counter: number; lastSnapshot?: string }>();

function getAriaState(tabId: number) {
  let state = tabAriaState.get(tabId);
  if (!state) {
    state = { refMap: new Map(), refSelectorMap: new Map(), counter: 0 };
    tabAriaState.set(tabId, state);
  }
  return state;
}

type AgentSessionState = "active" | "closed" | "error";
type AgentArtifactKind = "snapshot" | "screenshot" | "page" | "action";

interface AgentSessionArtifact {
  id: string;
  kind: AgentArtifactKind;
  createdAt: string;
  summary?: string;
  bytes?: number;
  data?: unknown;
}

interface AgentBrowserSession {
  id: string;
  tabId: number;
  windowId?: number;
  groupId?: number; // Chrome tabGroups id when this session owns a tab-group fleet
  url: string;
  title: string;
  name?: string;
  background: boolean;
  createdAt: string;
  updatedAt: string;
  status: AgentSessionState;
  actionCount: number;
  lastAction?: string;
  lastError?: string;
  artifacts: AgentSessionArtifact[];
}

interface AgentActionPayload {
  action?: string;
  type?: string;
  selector?: string;
  ref?: string;
  text?: string;
  value?: string;
  url?: string;
  expression?: string;
  key?: string;
  command?: string;
  direction?: string;
  amount?: number;
  clearFirst?: boolean;
  submit?: boolean;
  [key: string]: unknown;
}

const AGENT_SESSION_STORAGE_KEY = "crawlio:agentSessions";
const AGENT_SESSION_ARTIFACT_LIMIT = 40;
const agentSessions = new Map<string, AgentBrowserSession>();

function getActiveAgentSessionCount(): number {
  let count = 0;
  for (const session of agentSessions.values()) {
    if (session.status === "active") count++;
  }
  return count;
}

function newAgentSessionId(): string {
  return `as_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newAgentArtifactId(kind: AgentArtifactKind): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function artifactPublicView(artifact: AgentSessionArtifact, includeData = false): AgentSessionArtifact {
  if (includeData) return artifact;
  const { data: _data, ...metadata } = artifact;
  return metadata;
}

function sessionPublicView(session: AgentBrowserSession, includeArtifacts = false, includeData = false): Record<string, unknown> {
  return {
    id: session.id,
    tabId: session.tabId,
    windowId: session.windowId,
    groupId: session.groupId,
    url: session.url,
    title: session.title,
    name: session.name,
    background: session.background,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    actionCount: session.actionCount,
    lastAction: session.lastAction,
    lastError: session.lastError,
    artifactCount: session.artifacts.length,
    ...(includeArtifacts ? { artifacts: session.artifacts.map(a => artifactPublicView(a, includeData)) } : {}),
  };
}

async function hydrateAgentSessions(): Promise<void> {
  if (agentSessions.size > 0) return;
  try {
    const stored = await chrome.storage.session.get(AGENT_SESSION_STORAGE_KEY);
    const rows = stored[AGENT_SESSION_STORAGE_KEY];
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || typeof row.tabId !== "number") continue;
      agentSessions.set(row.id, {
        id: row.id,
        tabId: row.tabId,
        windowId: typeof row.windowId === "number" ? row.windowId : undefined,
        groupId: typeof row.groupId === "number" ? row.groupId : undefined,
        url: typeof row.url === "string" ? row.url : "",
        title: typeof row.title === "string" ? row.title : "",
        name: typeof row.name === "string" ? row.name : undefined,
        background: row.background !== false,
        createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : new Date().toISOString(),
        status: row.status === "closed" || row.status === "error" ? row.status : "active",
        actionCount: typeof row.actionCount === "number" ? row.actionCount : 0,
        lastAction: typeof row.lastAction === "string" ? row.lastAction : undefined,
        lastError: typeof row.lastError === "string" ? row.lastError : undefined,
        artifacts: Array.isArray(row.artifacts) ? row.artifacts.slice(-AGENT_SESSION_ARTIFACT_LIMIT) : [],
      });
    }
  } catch {
    // Session hydration is best-effort; active callers still get live tab checks.
  }
}

async function persistAgentSessions(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [AGENT_SESSION_STORAGE_KEY]: Array.from(agentSessions.values()),
    });
  } catch {
    // Artifact payloads are bounded, but storage can still fail on browser pressure.
  }
}

function recordAgentArtifact(session: AgentBrowserSession, artifact: AgentSessionArtifact): void {
  session.artifacts.push(artifact);
  if (session.artifacts.length > AGENT_SESSION_ARTIFACT_LIMIT) {
    session.artifacts.splice(0, session.artifacts.length - AGENT_SESSION_ARTIFACT_LIMIT);
  }
  session.updatedAt = new Date().toISOString();
}

async function waitForAgentTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    const timeoutHandle = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function refreshAgentSession(session: AgentBrowserSession): Promise<AgentBrowserSession> {
  try {
    const tab = await chrome.tabs.get(session.tabId);
    session.windowId = tab.windowId;
    session.url = tab.url ?? session.url;
    session.title = tab.title ?? session.title;
    session.updatedAt = new Date().toISOString();
  } catch (err) {
    session.status = "closed";
    session.lastError = err instanceof Error ? err.message : String(err);
    session.updatedAt = new Date().toISOString();
  }
  return session;
}

async function getAgentSession(sessionId: string, requireActive = true): Promise<AgentBrowserSession> {
  await hydrateAgentSessions();
  const session = agentSessions.get(sessionId);
  if (!session) throw new Error(`agent session '${sessionId}' not found`);
  await refreshAgentSession(session);
  if (requireActive && session.status === "closed") {
    throw new Error(`agent session '${sessionId}' is ${session.status}`);
  }
  return session;
}

function getAgentRefTarget(tabId: number, ref?: string): { selector?: string; backendNodeId?: number } {
  if (!ref) return {};
  const state = tabAriaState.get(tabId);
  if (!state) throw new Error("No refs available for this agent session. Run agent_session_snapshot first.");
  const backendNodeId = state.refMap.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(`Element ref '${ref}' not found. Run agent_session_snapshot to refresh.`);
  }
  if (backendNodeId === -1) {
    const selector = state.refSelectorMap.get(ref);
    if (!selector) throw new Error(`Element ref '${ref}' has no selector. Use a CSS selector target.`);
    return { selector };
  }
  return { backendNodeId };
}

const AGENT_ACTION_RUNNER_SOURCE = String.raw`
async function agentActionRunner(payload, suppliedTarget) {
  const action = String(payload.action || payload.type || "").toLowerCase();
  const selector = typeof payload.selector === "string" ? payload.selector : "";
  const target = suppliedTarget || (selector ? document.querySelector(selector) : null);
  const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
  const describe = (el) => el ? {
    tagName: el.tagName,
    id: el.id || undefined,
    name: el.getAttribute?.("name") || undefined,
    role: el.getAttribute?.("role") || undefined,
    text: (el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim().slice(0, 160),
    value: "value" in el ? el.value : undefined,
  } : null;
  const dispatchMouse = (el, type) => {
    const rect = el.getBoundingClientRect();
    const base = { ...eventInit, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: type === "mouseup" ? 0 : 1 };
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent(type.replace("mouse", "pointer"), { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent(type, base));
  };
  const dispatchInput = (el) => {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setEditableText = (el, text, clearFirst) => {
    el.focus?.({ preventScroll: true });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = clearFirst ? 0 : (el.selectionStart ?? el.value.length);
      const end = clearFirst ? el.value.length : (el.selectionEnd ?? el.value.length);
      el.setRangeText(text, start, end, "end");
      dispatchInput(el);
      return;
    }
    if (el.isContentEditable) {
      if (clearFirst) el.textContent = "";
      const node = document.createTextNode(text);
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(node);
        range.setStartAfter(node);
        range.setEndAfter(node);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        el.appendChild(node);
      }
      dispatchInput(el);
      return;
    }
    throw new Error("target is not editable");
  };
  try {
    if (action === "evaluate") {
      if (typeof payload.expression !== "string" || payload.expression.length === 0) throw new Error("expression is required");
      return { ok: true, action, result: (0, eval)(payload.expression), url: location.href, title: document.title };
    }
    if (action === "scroll") {
      const amount = Number(payload.amount ?? 600);
      const direction = String(payload.direction || "down").toLowerCase();
      const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
      const scroller = target || document.scrollingElement || document.documentElement;
      scroller.scrollBy?.({ left: dx, top: dy, behavior: "instant" });
      if (!scroller.scrollBy) window.scrollBy(dx, dy);
      return { ok: true, action, target: describe(target), scrollX: window.scrollX, scrollY: window.scrollY, url: location.href, title: document.title };
    }
    if (action === "move_mouse" || action === "movemouse" || action === "cursor") {
      var mmx, mmy;
      if (typeof payload.x === "number" && typeof payload.y === "number") { mmx = payload.x; mmy = payload.y; }
      else if (target) { var mr = target.getBoundingClientRect(); mmx = mr.left + mr.width / 2; mmy = mr.top + mr.height / 2; }
      else throw new Error("move_mouse requires x/y or selector/ref");
      if (window.__crawlioAgentCursor) { try { await window.__crawlioAgentCursor.moveTo(mmx, mmy, { animate: true }); } catch (e) {} }
      return { ok: true, action: "move_mouse", x: mmx, y: mmy, target: describe(target), url: location.href, title: document.title };
    }
    if (!target) throw new Error(selector ? "target_not_found" : "selector_or_ref_required");
    target.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
    if (window.__crawlioAgentCursor) { try { await window.__crawlioAgentCursor.moveToElement(target, { durationMs: 320 }); } catch (e) {} }
    if (action === "click") {
      if (target.disabled || target.getAttribute?.("aria-disabled") === "true") throw new Error("target_disabled");
      target.focus?.({ preventScroll: true });
      dispatchMouse(target, "mouseover");
      dispatchMouse(target, "mousemove");
      dispatchMouse(target, "mousedown");
      dispatchMouse(target, "mouseup");
      target.click?.();
      return { ok: true, action, target: describe(target), url: location.href, title: document.title };
    }
    if (action === "hover") {
      dispatchMouse(target, "mouseover");
      dispatchMouse(target, "mousemove");
      return { ok: true, action, target: describe(target), url: location.href, title: document.title };
    }
    if (action === "inserttext" || action === "type" || action === "fill") {
      const text = String(payload.text ?? payload.value ?? "");
      setEditableText(target, text, payload.clearFirst === true);
      if (payload.submit === true) {
        target.dispatchEvent(new KeyboardEvent("keydown", { ...eventInit, key: "Enter", code: "Enter" }));
        target.dispatchEvent(new KeyboardEvent("keyup", { ...eventInit, key: "Enter", code: "Enter" }));
        target.form?.requestSubmit?.();
      }
      return { ok: true, action, target: describe(target), url: location.href, title: document.title };
    }
    if (action === "select") {
      if (!(target instanceof HTMLSelectElement)) throw new Error("target is not a select element");
      const value = String(payload.value ?? payload.text ?? "");
      const option = Array.from(target.options).find((o) => o.value === value || o.text === value);
      if (!option) throw new Error("option_not_found");
      target.value = option.value;
      dispatchInput(target);
      return { ok: true, action, target: describe(target), url: location.href, title: document.title };
    }
    if (action === "key" || action === "press" || action === "command") {
      const key = String(payload.key || payload.command || "");
      if (!key) throw new Error("key_or_command_required");
      target.focus?.({ preventScroll: true });
      if (/^selectall$/i.test(key) && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        target.select();
        return { ok: true, action, key, target: describe(target), url: location.href, title: document.title };
      }
      if (/^submit$/i.test(key)) {
        target.form?.requestSubmit?.();
        return { ok: true, action, key, target: describe(target), url: location.href, title: document.title };
      }
      target.dispatchEvent(new KeyboardEvent("keydown", { ...eventInit, key, code: key }));
      target.dispatchEvent(new KeyboardEvent("keyup", { ...eventInit, key, code: key }));
      return { ok: true, action, key, target: describe(target), url: location.href, title: document.title };
    }
    throw new Error("unsupported_agent_action");
  } catch (err) {
    return { ok: false, action, error: err && err.message ? err.message : String(err), target: describe(target), url: location.href, title: document.title };
  }
}
`;

async function runAgentDomAction(tabId: number, payload: AgentActionPayload): Promise<Record<string, unknown>> {
  await ensureDebugger(tabId);
  await ensureAgentCursor(tabId); // so the in-page runner can move the visible cursor to the target
  let actionPayload = { ...payload };
  let backendNodeId: number | undefined;
  if (!actionPayload.selector && actionPayload.ref) {
    const refTarget = getAgentRefTarget(tabId, actionPayload.ref);
    if (refTarget.selector) actionPayload = { ...actionPayload, selector: refTarget.selector };
    backendNodeId = refTarget.backendNodeId;
  }

  let result: { result?: { value?: Record<string, unknown> }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (backendNodeId !== undefined) {
    const resolved = await sendCDPCommand<{ object: { objectId?: string } }>(
      { tabId }, "DOM.resolveNode", { backendNodeId }, 0, 5000
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`Element ref '${payload.ref}' is stale. Run agent_session_snapshot to refresh.`);
    result = await sendCDPCommand(
      { tabId },
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function(payload) { return (${AGENT_ACTION_RUNNER_SOURCE})(payload, this); }`,
        arguments: [{ value: actionPayload }],
        returnByValue: true,
        awaitPromise: true,
      },
      0,
      15000,
    );
  } else {
    const expression = `(${AGENT_ACTION_RUNNER_SOURCE})(${JSON.stringify(actionPayload)}, null)`;
    result = await sendCDPCommand(
      { tabId },
      "Runtime.evaluate",
      buildEvalParamsPure(expression, null, undefined, { returnByValue: true, awaitPromise: true }),
      0,
      15000,
    );
  }

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "agent DOM action failed");
  }
  const value = result.result?.value ?? {};
  if (value.ok === false) {
    throw new Error(typeof value.error === "string" ? value.error : "agent DOM action failed");
  }
  return value;
}

async function getAgentPageSummary(tabId: number): Promise<Record<string, unknown>> {
  await ensureDebugger(tabId);
  const expression = `(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    activeElement: document.activeElement ? {
      tagName: document.activeElement.tagName,
      id: document.activeElement.id || undefined,
      name: document.activeElement.getAttribute("name") || undefined,
      role: document.activeElement.getAttribute("role") || undefined
    } : null,
    textSample: (document.body?.innerText || "").slice(0, 5000),
    links: Array.from(document.links).slice(0, 50).map(a => ({ text: (a.innerText || a.textContent || "").trim().slice(0, 120), href: a.href })),
    forms: Array.from(document.forms).slice(0, 20).map((f, index) => ({ index, id: f.id || undefined, name: f.getAttribute("name") || undefined, action: f.action || undefined, method: f.method || undefined }))
  }))()`;
  const result = await sendCDPCommand<{ result?: { value?: Record<string, unknown> }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    { tabId },
    "Runtime.evaluate",
    buildEvalParamsPure(expression, null, undefined, { returnByValue: true, awaitPromise: true }),
    0,
    10000,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "agent page summary failed");
  }
  return result.result?.value ?? {};
}

async function createAgentSession(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  await hydrateAgentSessions();
  const existingTabId = typeof command.tabId === "number" ? command.tabId : undefined;
  const rawUrl = typeof command.url === "string" ? command.url : undefined;
  let tab: chrome.tabs.Tab;

  if (existingTabId !== undefined) {
    tab = await chrome.tabs.get(existingTabId);
    if (!tab.url?.startsWith("http")) throw new Error(`Tab ${existingTabId} is not HTTP/HTTPS: ${tab.url}`);
  } else {
    if (!rawUrl) throw new Error("url or tabId is required");
    tab = await chrome.tabs.create({ url: rawUrl, active: command.active === true });
    if (!tab.id) throw new Error("Chrome did not return a tab id");
    await waitForAgentTabLoad(tab.id);
    tab = await chrome.tabs.get(tab.id);
  }

  if (!tab.id) throw new Error("agent session target tab has no id");
  await ensureDebugger(tab.id);
  await waitForPageLoad(tab.id, 15000);

  const viewport = command.viewport as { width?: unknown; height?: unknown; deviceScaleFactor?: unknown; mobile?: unknown } | undefined;
  if (viewport && typeof viewport.width === "number" && typeof viewport.height === "number") {
    await sendCDPCommand(
      { tabId: tab.id },
      "Emulation.setDeviceMetricsOverride",
      {
        width: Math.max(1, Math.min(10000, Math.floor(viewport.width))),
        height: Math.max(1, Math.min(10000, Math.floor(viewport.height))),
        deviceScaleFactor: typeof viewport.deviceScaleFactor === "number" ? viewport.deviceScaleFactor : 1,
        mobile: viewport.mobile === true,
      },
      0,
      5000,
    );
  }

  const now = new Date().toISOString();
  const session: AgentBrowserSession = {
    id: typeof command.sessionId === "string" && command.sessionId ? command.sessionId : newAgentSessionId(),
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? rawUrl ?? "",
    title: tab.title ?? "",
    name: typeof command.name === "string" ? command.name : undefined,
    background: command.background !== false,
    createdAt: now,
    updatedAt: now,
    status: "active",
    actionCount: 0,
    artifacts: [],
  };
  agentSessions.set(session.id, session);
  await persistAgentSessions();
  startKeepalive();
  return sessionPublicView(session);
}

async function runAgentSessionAction(session: AgentBrowserSession, payload: AgentActionPayload): Promise<Record<string, unknown>> {
  const action = String(payload.action || payload.type || "").toLowerCase();
  const startedAt = Date.now();
  let data: Record<string, unknown>;
  try {
    if (action === "navigate") {
      if (typeof payload.url !== "string") throw new Error("url is required for navigate");
      await chrome.tabs.update(session.tabId, { url: payload.url, active: false });
      await waitForAgentTabLoad(session.tabId);
      await ensureDebugger(session.tabId);
      await waitForPageLoad(session.tabId, 15000);
      data = { ok: true, action, url: payload.url };
    } else {
      data = await runAgentDomAction(session.tabId, payload);
    }
    await refreshAgentSession(session);
    session.status = "active";
    session.lastError = undefined;
    session.lastAction = action || "unknown";
    session.actionCount++;
    recordAgentArtifact(session, {
      id: newAgentArtifactId("action"),
      kind: "action",
      createdAt: new Date().toISOString(),
      summary: `${session.lastAction} ok`,
      data: { input: payload, result: data, durationMs: Date.now() - startedAt },
    });
    await persistAgentSessions();
    return {
      ok: true,
      ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
      session: sessionPublicView(session), result: data, durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    await refreshAgentSession(session);
    session.status = "error";
    session.lastAction = action || "unknown";
    session.lastError = err instanceof Error ? err.message : String(err);
    recordAgentArtifact(session, {
      id: newAgentArtifactId("action"),
      kind: "action",
      createdAt: new Date().toISOString(),
      summary: `${session.lastAction} failed`,
      data: { input: payload, error: session.lastError, durationMs: Date.now() - startedAt },
    });
    await persistAgentSessions();
    throw err;
  }
}

async function captureAgentSessionSnapshot(session: AgentBrowserSession, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mode = typeof command.mode === "string" ? command.mode : "aria";
  const includeData = command.includeData !== false;
  const capturedAt = new Date().toISOString();
  const response: Record<string, unknown> = {
    session: sessionPublicView(session),
    mode,
    capturedAt,
  };

  if (mode === "aria" || mode === "all") {
    const result = await generateAriaSnapshot(session.tabId, {
      interactive: command.interactive === true,
      compact: command.compact === true,
      maxDepth: typeof command.maxDepth === "number" ? Math.max(0, Math.min(command.maxDepth, 50)) : undefined,
      selector: typeof command.selector === "string" ? command.selector : undefined,
    });
    getAriaState(session.tabId).lastSnapshot = result.snapshot;
    response.aria = includeData ? result : { estimatedTokens: result.estimatedTokens, bytes: result.snapshot.length };
    recordAgentArtifact(session, {
      id: newAgentArtifactId("snapshot"),
      kind: "snapshot",
      createdAt: capturedAt,
      summary: `aria snapshot (${result.estimatedTokens} est tokens)`,
      bytes: result.snapshot.length,
      data: includeData ? result : undefined,
    });
  }

  if (mode === "screenshot" || mode === "all") {
    const data = await takeScreenshotHardened(session.tabId);
    const screenshot = { mimeType: "image/jpeg", data, bytes: data.length };
    response.screenshot = includeData ? screenshot : { mimeType: screenshot.mimeType, bytes: screenshot.bytes };
    recordAgentArtifact(session, {
      id: newAgentArtifactId("screenshot"),
      kind: "screenshot",
      createdAt: capturedAt,
      summary: "jpeg screenshot",
      bytes: data.length,
      data: includeData ? screenshot : undefined,
    });
  }

  if (mode === "page" || mode === "all") {
    const page = await getAgentPageSummary(session.tabId);
    response.page = includeData ? page : {
      url: page.url,
      title: page.title,
      readyState: page.readyState,
    };
    recordAgentArtifact(session, {
      id: newAgentArtifactId("page"),
      kind: "page",
      createdAt: capturedAt,
      summary: typeof page.title === "string" ? page.title : "page summary",
      data: includeData ? page : undefined,
    });
  }

  await refreshAgentSession(session);
  await persistAgentSessions();
  response.session = sessionPublicView(session);
  return response;
}

// fw-hardening: store main document response headers for header-based framework detection
let mainDocResponseHeaders: Record<string, string> = {};
let networkWriteTimer: ReturnType<typeof setTimeout> | null = null;

// AC-16: WebSocket monitoring
interface WebSocketMessage {
  direction: "sent" | "received";
  opcode: number;
  data: string;
  timestamp: string;
}
interface WebSocketConnection {
  requestId: string;
  url: string;
  initiator?: string;
  status: "connecting" | "open" | "closed" | "error";
  messages: WebSocketMessage[];
  createdAt: string;
  closedAt?: string;
  errorMessage?: string;
}
const wsConnections = new Map<string, WebSocketConnection>();
const WS_MAX_CONNECTIONS = 100;
const WS_MAX_MESSAGES_PER_CONNECTION = 200;

// Console capture state
let consoleLogs: any[] = [];

// --- Session Recording State ---
const RECORDING_INTERACTION_TOOLS = new Set([
  "browser_navigate", "browser_click", "browser_type", "browser_press_key",
  "browser_hover", "browser_select_option", "browser_scroll",
  "browser_double_click", "browser_drag", "browser_fill_form",
  "browser_evaluate", "browser_file_upload",
]);
const RECORDING_MAX_DURATION = 600;
const RECORDING_MAX_INTERACTIONS = 500;

interface ActiveRecording {
  sessionId: string;
  startedAt: string;
  _startedAtMs: number; // Date.now() at start — for SW restart timeout reconstruction
  tabId: number;
  initialUrl: string;
  initialFramework?: FrameworkDetection;
  maxDurationSec: number;
  maxInteractions: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  pages: Array<{
    url: string;
    title?: string;
    enteredAt: string;
    screenshot?: string;
    framework?: FrameworkDetection;
    console: any[];
    network: any[];
    interactions: Array<{
      timestamp: string;
      tool: string;
      args: Record<string, unknown>;
      result?: unknown;
      durationMs: number;
      pageUrl: string;
      source?: "user" | "mcp";
    }>;
  }>;
  currentPageUrl: string;
  totalInteractions: number;
  networkSnapshotKeys: Set<string>;
  consoleSnapshotIndex: number;
}

let activeRecording: ActiveRecording | null = null;
let lastAutoStoppedSession: any = null;
let lastAutoStoppedTimer: ReturnType<typeof setTimeout> | null = null;

function finalizeCurrentRecordingPage(): void {
  if (!activeRecording || activeRecording.pages.length === 0) return;
  const page = activeRecording.pages[activeRecording.pages.length - 1];
  // Compute network delta
  const allKeys = Array.from(networkEntries.keys());
  const newNetworkKeys = allKeys.filter(k => !activeRecording!.networkSnapshotKeys.has(k));
  page.network = newNetworkKeys.map(k => networkEntries.get(k)).filter(Boolean)
    .filter((e: any) => e.url && !e._startTime);
  // Compute console delta
  page.console = consoleLogs.slice(activeRecording.consoleSnapshotIndex);
}

function startNewRecordingPage(url: string, title?: string): void {
  if (!activeRecording) return;
  finalizeCurrentRecordingPage();
  activeRecording.currentPageUrl = url;
  activeRecording.networkSnapshotKeys = new Set(networkEntries.keys());
  activeRecording.consoleSnapshotIndex = consoleLogs.length;
  activeRecording.pages.push({
    url,
    title,
    enteredAt: new Date().toISOString(),
    console: [],
    network: [],
    interactions: [],
  });
}

function stopRecordingInternal(reason: "manual" | "max_duration" | "max_interactions" | "tab_closed" | "tab_disconnected"): any {
  if (!activeRecording) return null;
  finalizeCurrentRecordingPage();
  const now = new Date();
  const startTime = new Date(activeRecording.startedAt);
  const session = {
    id: activeRecording.sessionId,
    startedAt: activeRecording.startedAt,
    stoppedAt: now.toISOString(),
    duration: Math.round((now.getTime() - startTime.getTime()) / 1000),
    pages: activeRecording.pages,
    metadata: {
      tabId: activeRecording.tabId,
      initialUrl: activeRecording.initialUrl,
      framework: activeRecording.initialFramework,
      stopReason: reason,
    },
  };
  clearTimeout(activeRecording.timeoutHandle);
  activeRecording = null;
  return session;
}

function autoStopRecording(reason: "max_duration" | "max_interactions" | "tab_closed" | "tab_disconnected"): void {
  const session = stopRecordingInternal(reason);
  if (session) {
    if (lastAutoStoppedTimer) clearTimeout(lastAutoStoppedTimer);
    lastAutoStoppedSession = session;
    lastAutoStoppedTimer = setTimeout(() => {
      lastAutoStoppedSession = null;
      lastAutoStoppedTimer = null;
    }, 5 * 60 * 1000);
    removeRecordingIndicator(session.metadata.tabId);
    if (__DEV__) console.log(`[Crawlio] Recording auto-stopped: ${reason}, session ${session.id}`);
  }
}

// Recording visual indicator: badge + floating overlay
async function showRecordingIndicator(tabId: number): Promise<void> {
  // These are promise-style calls — a surrounding try/catch does NOT catch their async
  // rejection (e.g. "No tab with id" if the tab closed). Attach .catch explicitly.
  chrome.action.setBadgeText({ tabId, text: "REC" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#F44336" }).catch(() => {});

  try {
    await sendCDPCommand({ tabId }, "Runtime.evaluate", {
      expression: `(() => {
        if (document.getElementById('__crawlio_rec')) return;
        const el = document.createElement('div');
        el.id = '__crawlio_rec';
        el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#F44336;color:white;padding:4px 10px;border-radius:12px;font:12px/1 sans-serif;pointer-events:none;opacity:0.85;';
        el.textContent = '\\u25CF REC';
        document.body.appendChild(el);
      })()`,
      returnByValue: true,
    }, 0);
  } catch { /* page may not be ready */ }
}

function removeRecordingIndicator(tabId: number): void {
  // Restore connected-tab badge (green dot) if still connected
  if (debuggerAttachedTabId === tabId) {
    setDynamicIcon("active", tabId);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  } else {
    resetIcon(tabId);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }

  // Remove floating overlay
  try {
    sendCDPCommand({ tabId }, "Runtime.evaluate", {
      expression: `(() => { const el = document.getElementById('__crawlio_rec'); if (el) el.remove(); })()`,
      returnByValue: true,
    }, 0).catch(() => {});
  } catch { /* tab may be gone */ }
}

// --- CDP Interaction Capture (Phase 1: manual browser events) ---
const INTERACTION_BINDING_NAME = "__crawlio_interaction";
const interactionCaptureActive = new Set<number>();

const INTERACTION_CAPTURE_SCRIPT = `(() => {
  if (window.__crawlio_capture_active) return;
  window.__crawlio_capture_active = true;

  function getSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\\s+/);
      for (const cls of classes) {
        try { if (document.querySelectorAll('.' + CSS.escape(cls)).length === 1) return '.' + CSS.escape(cls); }
        catch { continue; }
      }
    }
    const path = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      const tag = cur.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      path.unshift(siblings.length === 1 ? tag : tag + ':nth-child(' + (siblings.indexOf(cur) + 1) + ')');
      cur = parent;
    }
    return path.join(' > ') || el.tagName.toLowerCase();
  }

  document.addEventListener('click', function(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    try {
      window.${INTERACTION_BINDING_NAME}(JSON.stringify({
        type: 'user_click', selector: getSelector(t),
        text: (t.textContent || '').trim().slice(0, 100),
        x: e.clientX, y: e.clientY, url: location.href
      }));
    } catch {}
  }, true);

  document.addEventListener('input', function(e) {
    const t = e.target;
    if (!t || !('value' in t)) return;
    clearTimeout(t.__crawlio_db);
    t.__crawlio_db = setTimeout(function() {
      try {
        window.${INTERACTION_BINDING_NAME}(JSON.stringify({
          type: 'user_type', selector: getSelector(t),
          text: t.value, url: location.href
        }));
      } catch {}
    }, 300);
  }, true);

  document.addEventListener('keydown', function(e) {
    if (['Enter', 'Tab', 'Escape'].includes(e.key)) {
      try {
        window.${INTERACTION_BINDING_NAME}(JSON.stringify({
          type: 'user_keypress', key: e.key, url: location.href
        }));
      } catch {}
    }
  }, true);
})()`;

async function setupInteractionCapture(tabId: number): Promise<void> {
  if (interactionCaptureActive.has(tabId)) return;
  try {
    await sendCDPCommand({ tabId }, "Runtime.addBinding", { name: INTERACTION_BINDING_NAME }, 0);
    await sendCDPCommand({ tabId }, "Runtime.evaluate", {
      expression: INTERACTION_CAPTURE_SCRIPT,
      returnByValue: true,
    }, 0);
    interactionCaptureActive.add(tabId);
  } catch {
    if (__DEV__) console.warn("[Crawlio] Failed to set up interaction capture");
  }
}

function teardownInteractionCapture(tabId: number): void {
  interactionCaptureActive.delete(tabId);
  try {
    sendCDPCommand({ tabId }, "Runtime.removeBinding", { name: INTERACTION_BINDING_NAME }, 0).catch(() => {});
  } catch { /* binding may already be removed */ }
}

const dialogCounts = new Map<number, number>();

// AC-6: Dialog queue
interface PendingDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  url: string;
  timestamp: string;
}
let pendingDialog: PendingDialog | null = null;
const dialogAutoMode: "accept" | "dismiss" | "queue" = "queue";
let dialogAutoTimeout: ReturnType<typeof setTimeout> | null = null;
let dialogSequenceId = 0; // monotonic ID to prevent stale timeout races

// --- SEO Intelligence Settings (Phase 6) ---
interface SeoIntelligenceSettings {
  enabled: boolean;   // master toggle — disables all auto-SERP behavior
  autoOverlay: boolean; // auto-inject SERP overlay on Google SERPs (intrusive — opt-in)
  autoBadge: boolean;   // auto-update badge/tooltip on SERP detection (non-intrusive)
}
const SEO_INTELLIGENCE_DEFAULTS: SeoIntelligenceSettings = { enabled: true, autoOverlay: false, autoBadge: true };
let seoIntelligenceSettings: SeoIntelligenceSettings = { ...SEO_INTELLIGENCE_DEFAULTS };

// --- Anti-Detection Stealth ---
let stealthEnabled = false; // default off — user/MCP must explicitly enable via set_stealth_mode
let stealthScriptId: string | null = null; // Page.addScriptToEvaluateOnNewDocument identifier for cleanup
// --- Pre-Load Framework Hooks ---
// Inject BEFORE frameworks load to capture initialization data (hydration, SSR payloads, renderer info)
// Same mechanism as STEALTH_SCRIPT — Page.addScriptToEvaluateOnNewDocument
let frameworkHookScriptId: string | null = null;

// --- File Chooser Interception ---
let pendingFileChooser: { mode: string; frameId?: string; backendNodeId?: number; timestamp: string } | null = null;

// --- Security State ---
interface SecurityState {
  securityState: "unknown" | "neutral" | "insecure" | "secure" | "info";
  certificate?: {
    subjectName: string;
    issuer: string;
    validFrom: number;
    validTo: number;
    protocol: string;
    keyExchange: string;
    cipher: string;
    certificateTransparencyCompliance: string;
  };
  mixedContent?: boolean;
  updatedAt: string;
}

let currentSecurityState: SecurityState | null = null;

// --- Service Worker Tracking (AC-19) ---
interface SWVersion {
  versionId: string;
  scriptURL: string;
  runningStatus: "stopped" | "starting" | "running";
  status: "new" | "installing" | "installed" | "activating" | "activated" | "redundant";
}
interface SWRegistration {
  registrationId: string;
  scopeURL: string;
  isDeleted: boolean;
  versions: SWVersion[];
}
const swRegistrations = new Map<string, SWRegistration>();

// --- CDP Fetch Domain Interception ---
interface InterceptRule {
  urlPattern: string;
  action: "block" | "modify" | "mock";
  modifyHeaders?: Record<string, string>;
  mockResponse?: { status: number; headers: Record<string, string>; body: string };
}

const interceptRules = new Map<number, InterceptRule[]>(); // tabId -> rules

// --- CDP Target Domain Session Tracking (AC-24) ---
interface TargetSession {
  targetId: string;
  sessionId: string;
  type: string;
  title: string;
  url: string;
}
const targetSessions = new Map<string, TargetSession>();
const browserContexts = new Set<string>();

// Storage bus helper — writes to chrome.storage.session
function storageWrite(key: string, data: any) {
  chrome.storage.session.set({ [key]: data }).catch((err) => {
    if (__DEV__) console.error(`[Background] storageWrite "${key}" failed:`, err);
    void chrome.runtime.lastError;
  });
}

const statusCache = { mcpConnected: false, capturing: false, activeTabId: null as number | null, activeTabUrl: "", lastCaptureAt: null as string | null };
function writeStatus(patch: Record<string, any>) {
  Object.assign(statusCache, patch);
  storageWrite("crawlio:status", { ...statusCache });
}

// --- Permission Broker (PF-2: runtime permission model) ---
const OPTIONAL_PERMISSIONS: chrome.permissions.Permissions = {
  // nativeMessaging activates the rogue-server defense: it lets the extension be handed
  // the real bridge token over Chrome's authenticated native channel (connectNative →
  // set_crawlio_token). WITHOUT it the extension is permanently trust-on-first-use and a rogue
  // local server can win the bridge election and drive CDP. It is requested through the
  // permission broker (popup), SEPARATELY from the already-held tabs grant — so denying it never
  // revokes tabs — and on grant the permissions.onAdded listener connects the token provisioner.
  permissions: ["tabs", "nativeMessaging"],
  origins: ["http://127.0.0.1/*"],
};

async function hasAllPermissions(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains(OPTIONAL_PERMISSIONS, resolve);
  });
}

async function getMissingPermissions(): Promise<chrome.permissions.Permissions> {
  const has = await hasAllPermissions();
  if (has) return { permissions: [], origins: [] };
  const missing: { permissions: string[]; origins: string[] } = { permissions: [], origins: [] };
  for (const perm of OPTIONAL_PERMISSIONS.permissions || []) {
    const hasPerm = await new Promise<boolean>((resolve) => {
      chrome.permissions.contains({ permissions: [perm] }, resolve);
    });
    if (!hasPerm) missing.permissions.push(perm);
  }
  for (const origin of OPTIONAL_PERMISSIONS.origins || []) {
    const hasOrigin = await new Promise<boolean>((resolve) => {
      chrome.permissions.contains({ origins: [origin] }, resolve);
    });
    if (!hasOrigin) missing.origins.push(origin);
  }
  return missing;
}

async function ensureTabPermission(commandType: string): Promise<void> {
  // Only check for "tabs" permission — connect_tab/disconnect_tab need chrome.tabs API,
  // NOT the http://127.0.0.1/* origin (that's for healthCheck fetch, handled separately)
  const hasTab = await new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ permissions: ["tabs"] }, resolve);
  });
  if (!hasTab) {
    throw new PermissionError(
      `Permission required for "${commandType}". Click the Crawlio icon to grant permissions.`,
      { permissions: ["tabs"], origins: [] },
      "Click the Crawlio extension icon and grant the requested permissions.",
    );
  }
}

// Generic optional-permission gate (history, downloads, …).
async function ensureOptionalPermission(commandType: string, permission: string): Promise<void> {
  const has = await new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ permissions: [permission] }, (granted) => resolve(granted === true));
  });
  if (!has) {
    throw new PermissionError(
      `Permission "${permission}" required for "${commandType}". Click the Crawlio icon to grant permissions.`,
      { permissions: [permission], origins: [] },
      "Click the Crawlio extension icon and grant the requested permissions.",
    );
  }
}

// Open welcome tab on first install + re-create context menus (Chrome clears on update)
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
  setupContextMenus().catch(() => {});
});

// Deferred-update manager — stash the pending version and reload only when idle, so we never
// reload the service worker mid-automation.
chrome.runtime.onUpdateAvailable.addListener((details) => {
  chrome.storage.session.set({ [PENDING_UPDATE_KEY]: details?.version ?? "pending" }).catch(() => {});
  maybeApplyPendingUpdate();
});

// Context menus: setup on SW startup (idempotent) + click dispatch
setupContextMenus().catch(() => {});

// Wire download monitoring if the optional `downloads` permission is already granted.
wireDownloadListeners();

// Load saved SEO intelligence settings (Phase 6)
chrome.storage.session.get("crawlio:seoIntelligence").then((result) => {
  if (result["crawlio:seoIntelligence"]) {
    seoIntelligenceSettings = { ...SEO_INTELLIGENCE_DEFAULTS, ...result["crawlio:seoIntelligence"] };
  }
}).catch(() => {});

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  handleContextMenuClick(info, tab, {
    capturePageFn: (tabId) => {
      if (debuggerAttachedTabId === tabId) {
        handleCommand({ type: "capture_page", id: "context-menu" }).catch(() => {});
      }
    },
    extractTablesFn: (tabId) => {
      // Store request — table detection requires MCP orchestration (detect_tables + extract_table)
      chrome.storage.session.set({ "crawlio:extract-tables": { tabId, requestedAt: new Date().toISOString() } });
    },
    analyzeSelectionFn: (text, tabId) => {
      chrome.storage.session.set({ "crawlio:selection": { text, tabId, capturedAt: new Date().toISOString() } });
    },
    startRecordingFn: (tabId) => {
      if (debuggerAttachedTabId === tabId && !activeRecording) {
        handleCommand({ type: "start_recording", id: "context-menu" }).catch(() => {});
      }
    },
    seoCheckFn: (tabId) => {
      chrome.storage.session.set({ "crawlio:seo-check": { tabId, requestedAt: new Date().toISOString() } });
    },
  });
});

chrome.permissions.onAdded.addListener((perms) => {
  if (perms.permissions?.includes("nativeMessaging")) {
    connectNative().then((connected) => {
      if (connected) console.log("[Crawlio] Native messaging connected after permission grant");
    });
  }
  // Clear permission broker badge when tabs permission is granted
  if (perms.permissions?.includes("tabs")) {
    chrome.action.setBadgeText({ text: "" });
    chrome.storage.session.remove("crawlio:pendingPermissions");
  }
  // Create context menus when contextMenus permission is granted at runtime
  if (perms.permissions?.includes("contextMenus")) {
    setupContextMenus().catch(() => {});
  }
  // Start download monitoring as soon as the permission is granted at runtime.
  if (perms.permissions?.includes("downloads")) {
    wireDownloadListeners();
  }
});
chrome.permissions.onRemoved.addListener((perms) => {
  if (perms.permissions?.includes("nativeMessaging")) {
    disconnectNative();
    requestBridgeDiscovery();
  }
});
// --- Data Sanitizer (PF-5) ---
const SENSITIVE_KEY_PATTERNS = /password|token|secret|api[_-]?key|auth(?:orization|_token|_key|_secret)|credential|bearer/i;

const SENSITIVE_VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /^[A-Fa-f0-9]{32,}$/, // Hex credential (32+ chars)
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // Base64 (40+ chars)
  /^sk-[A-Za-z0-9]{20,}/, // OpenAI key
  /^ghp_[A-Za-z0-9]{20,}/, // GitHub PAT
  /^xoxb-[A-Za-z0-9-]+/, // Slack bot token
  /^AKIA[0-9A-Z]{16}/, // AWS access key ID
  /^ASIA[0-9A-Z]{16}/, // AWS temporary access key ID
];

const MAX_STRING_LENGTH = 1000;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth limit]";

  if (typeof value === "string") {
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) return "[REDACTED]";
    }
    if (value.length > MAX_STRING_LENGTH) {
      return value.slice(0, MAX_STRING_LENGTH) + `... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERNS.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = sanitizeValue(val, depth + 1);
      }
    }
    return sanitized;
  }

  return value;
}

// Batched network storage write (500ms debounce) — IDB primary, session storage fallback
function flushNetworkToStorage() {
  if (networkWriteTimer) clearTimeout(networkWriteTimer);
  networkWriteTimer = setTimeout(async () => {
    // Entries keyed by requestId always have it; filter ensures loading finished (_startTime deleted)
    const entries = Array.from(networkEntries.values()).filter(
      (e): e is NetworkMapEntry & { requestId: string } => !!e.url && !e._startTime && !!e.requestId
    ).map(e => {
      if (e.requestHeaders) e.requestHeaders = sanitizeValue(e.requestHeaders) as Record<string, string>;
      if (e.requestBody) e.requestBody = sanitizeValue(e.requestBody) as string;
      return e;
    });
    try {
      await putNetworkEntries(entries);
    } catch { /* IDB write failed — fall back to session storage */
      storageWrite("crawlio:network", entries.slice(-SESSION_NETWORK_CAP));
    }
    networkWriteTimer = null;
  }, NETWORK_WRITE_DEBOUNCE);
}

// Batched console storage write (500ms debounce) — IDB primary, session storage fallback
let consoleWriteTimer: ReturnType<typeof setTimeout> | null = null;
let consoleWriteIndex = 0;
function flushConsoleToStorage() {
  if (consoleWriteTimer) clearTimeout(consoleWriteTimer);
  consoleWriteTimer = setTimeout(async () => {
    const newEntries = consoleLogs.slice(consoleWriteIndex);
    if (newEntries.length === 0) { consoleWriteTimer = null; return; }
    try {
      await putConsoleLogs(newEntries);
      consoleWriteIndex = consoleLogs.length;
    } catch { /* IDB write failed — fall back to session storage */
      storageWrite("crawlio:console", consoleLogs.slice(-SESSION_CONSOLE_CAP));
      consoleWriteIndex = consoleLogs.length;
    }
    consoleWriteTimer = null;
  }, NETWORK_WRITE_DEBOUNCE);
}

// H6: Double-setTimeout yield between CDP operations
const CDP_YIELD = () => new Promise<void>(r => setTimeout(() => setTimeout(r, 20), 20));

// Module-level mutex for probe-and-connect lifecycle
const bridgeRetryGate = new BridgeRetryGate(BRIDGE_RETRY_START_INTERVAL);
let bridgeDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;
let bridgeDiscoveryRunning = false;

// Multi-instance discovery: scan port range, connect to all live servers.
let consecutiveProbeFailures = 0;
const MAX_PROBE_RETRIES = 3;
let wasEverConnected = false;
let userDisconnected = false;

function requestBridgeDiscovery(): void {
  if (userDisconnected) return;
  const delay = bridgeRetryGate.reserve();
  if (delay > 0) {
    if (!bridgeDiscoveryTimer) {
      bridgeDiscoveryTimer = setTimeout(() => {
        bridgeDiscoveryTimer = null;
        requestBridgeDiscovery();
      }, delay);
    }
    return;
  }
  if (bridgeDiscoveryRunning) return;
  bridgeDiscoveryRunning = true;
  discoverAndConnectAll()
    .catch(() => {})
    .finally(() => { bridgeDiscoveryRunning = false; });
}

// Probe a port's /health. On a live crawlio-mcp server, returns its port + activity
// timestamp; null on any failure or non-crawlio body. lastActivityAt is read
// DEFENSIVELY — it is undefined/0 until the server ships it (see SHARED CONTRACT), so a
// pre-rollout fleet probes as all-zero and election falls back to lowest-port.
// NOTE: /health never discloses a token — the only trusted token source is the
// native channel (set_crawlio_token), so we no longer read body.token here.
async function probePort(port: number): Promise<{ port: number; lastActivityAt: number } | null> {
  try {
    const res = await fetch(`http://${WS_HOST}:${port}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.service === "crawlio-mcp") {
      return { port, lastActivityAt: typeof body.lastActivityAt === "number" ? body.lastActivityAt : 0 };
    }
    return null;
  } catch { /* fetch failed — server unreachable */
    return null;
  }
}

// --- Native Messaging Transport ---

async function handleIncomingMessage(msg: Record<string, unknown>, source: "native" | "ws"): Promise<object | null> {
  if (msg.type === "set_crawlio_port") {
    chrome.storage.local.set({ "crawlio:port": msg.port });
    if (__DEV__) console.log(`[Crawlio] Cached Crawlio port: ${msg.port}`);
    return null;
  }
  // Trusted token provisioning — ONLY honored over the native-messaging channel,
  // which Chrome authenticates via the host manifest. Honoring it over the WS would
  // let a rogue server provision its OWN token and then pass the handshake, which is
  // the exact attack the token is meant to stop.
  if (msg.type === "set_crawlio_token") {
    if (source !== "native") {
      console.warn("[Crawlio] Ignoring set_crawlio_token from a non-native channel");
      return null;
    }
    if (typeof msg.token === "string" && msg.token) {
      const changed = trustedBridgeToken !== msg.token;
      trustedBridgeToken = msg.token;
      chrome.storage.local.set({ "crawlio:bridgeToken": msg.token });
      if (changed) {
        // The trusted token changed (first provision out of TOFU, or the native host
        // re-elected a different server). Every open socket's prior verdict was made under
        // a DIFFERENT token (or TOFU), so re-prove each under the new token: whichever
        // server actually holds it re-verifies; the rest fail and are dropped/refused.
        // Without this, a socket that was "active" under TOFU would stay unverified and get
        // its commands refused the instant a token arrives.
        for (const p of [...wsBridges.keys()]) rechallengeBridge(p);
        requestBridgeDiscovery(); // pull in the holder of the new token if not already connected
      }
      if (__DEV__) console.log("[Crawlio] Trusted bridge token provisioned via native channel");
    }
    return null;
  }
  return await handleCommandWithRecording(msg);
}

function sendToTransport(msg: object): void {
  // Commands/responses ALWAYS go over the WS bridge. The native-messaging port is a
  // token-PROVISIONING side channel — the host only delivers the trusted bridge
  // token, it does NOT relay CDP commands — so routing here would black-hole every command.
  // Single-bridge: route only to the elected active bridge (never broadcast — that was the
  // "N bridges hear every reply" storm). wsBridges holds at most this one socket.
  if (activeBridgePort !== null) {
    const socket = wsBridges.get(activeBridgePort);
    if (socket) safeWebSocketSend(socket, JSON.stringify(msg));
  }
}

async function connectNative(): Promise<boolean> {
  try {
    const hasPermission = await chrome.permissions.contains({
      permissions: ["nativeMessaging"],
    });
    if (!hasPermission) return false;
  } catch { /* permissions API unavailable */
    return false;
  }

  const port = await nativeConnection.connect(() => new Promise((resolve) => {
    let candidatePort: chrome.runtime.Port | null = null;
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST);
      candidatePort = port;
      let settled = false;
      const finish = (value: chrome.runtime.Port | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        port.onMessage.removeListener(onFirstMessage);
        port.onDisconnect.removeListener(onHandshakeDisconnect);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        finish(null);
        try { port.disconnect(); } catch { /* already disconnected */ }
      }, NATIVE_PING_TIMEOUT);

      const onFirstMessage = (msg: Record<string, unknown>) => {
        if (msg?.type === "pong") {
          finish(port);
        }
      };

      const onHandshakeDisconnect = () => finish(null);

      port.onMessage.addListener(onFirstMessage);
      port.onDisconnect.addListener(onHandshakeDisconnect);

      port.postMessage({ type: "ping" });
    } catch { /* connectNative or handshake failed */
      try { candidatePort?.disconnect(); } catch { /* already disconnected */ }
      resolve(null);
    }
  }));
  return port !== null;
}

function disconnectNative(): void {
  nativeConnection.reset();
}

function wireNativePort(port: chrome.runtime.Port): void {
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    handleIncomingMessage(msg, "native").then((response) => {
      if (response) sendToTransport(response);
    }).catch((e) => {
      if (__DEV__) console.error("[Crawlio] Native message error:", e);
    });
  });
  port.onDisconnect.addListener(() => {
    if (!nativeConnection.clearIfCurrent(port)) return;
    const err = chrome.runtime.lastError?.message || "";
    if (err.includes("native messaging host not found")) {
      console.log("[Crawlio] Native host not found, using WebSocket");
    }
    requestBridgeDiscovery();
    // If no transport comes back, release orphaned debugger attachments after the grace period.
    if (wsBridges.size === 0) scheduleDebuggerRelease();
  });
}

function updateBridgeStatus() {
  // The native port is a token side-channel, not a command transport — only a live WS
  // bridge counts as "connected".
  const connected = wsBridges.size > 0;
  writeStatus({ mcpConnected: connected });
  chrome.storage.session.set({
    "crawlio:bridgeConnected": connected,
    "crawlio:bridgeCount": wsBridges.size,
  });
}

function connectToPort(port: number) {
  if (wsBridges.has(port) || connectingPorts.has(port)) return;
  connectingPorts.add(port);

  // The native-provisioned token is the SOLE token source. It's null in
  // trust-on-first-use mode, in which case we connect without a token query param.
  const token = trustedBridgeToken;
  const wsUrl = token ? `ws://${WS_HOST}:${port}?token=${token}` : `ws://${WS_HOST}:${port}`;
  const socket = new WebSocket(wsUrl);
  let wasOpen = false;
  const handshakeTimer = setTimeout(() => {
    if (!wasOpen) {
      connectingPorts.delete(port);
      closeFailedHandshake(socket, "handshake-timeout");
    }
  }, WS_HANDSHAKE_TIMEOUT);

  socket.onopen = () => {
    clearTimeout(handshakeTimer);
    wasOpen = true;
    connectingPorts.delete(port);
    wsBridges.set(port, socket);

    // Promote-or-candidate (single active bridge, no rogue cutover-DoS).
    // This socket becomes the ACTIVE bridge (the one commands route to) right away UNLESS
    // a trusted token is held AND a different bridge is already live — then we keep the
    // incumbent and treat this one as a CANDIDATE that must prove its identity before it
    // can take over (promotion happens in the handshake-verified branch). In TOFU there is
    // nothing to verify, so the elected most-active bridge promotes immediately (the
    // unchanged single-bridge behavior).
    const incumbent = activeBridgePort;
    const incumbentSocket = incumbent !== null && incumbent !== port ? wsBridges.get(incumbent) : undefined;
    const hasLiveIncumbent = !!incumbentSocket && incumbentSocket.readyState === WebSocket.OPEN;
    const stayCandidate = trustedBridgeToken !== null && hasLiveIncumbent;
    if (!stayCandidate) {
      activeBridgePort = port; // become the active bridge
      if (hasLiveIncumbent) closeIncumbent(incumbent!, socket); // close the old one AFTER we're open
    }

    wasEverConnected = true;
    reconnectDelay = RECONNECT_BASE;
    portRetryDelays.delete(port); // successful open resets this port's backoff
    if (pendingDisconnectTimer) { clearTimeout(pendingDisconnectTimer); pendingDisconnectTimer = null; }
    cancelDebuggerRelease(); // host is back — cancel any pending orphan-debugger release
    if (__DEV__) console.log(`[Crawlio] Connected to MCP server on :${port}${stayCandidate ? " (candidate — awaiting identity proof)" : ""}`);
    updateBridgeStatus();
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    persistState().catch(() => {});
    startKeepalive();
    safeWebSocketSend(socket, JSON.stringify({
        type: "connected",
        extensionId: chrome.runtime.id,
      }));

    // Challenge the server to prove it holds the real bridge token. The verdict
    // gates command execution AND (for a candidate) promotion to the active bridge. With
    // no trusted token this is trust-on-first-use (unchanged).
    const handshakeNonce = randomNonce();
    bridgeTrust.set(port, { nonce: handshakeNonce, verified: false });
    safeWebSocketSend(socket, JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce: handshakeNonce }));

    // When a trusted token is held, require proof within the handshake window or drop this
    // socket: a silent rogue candidate must not linger, and an unverified "active" bridge
    // must not keep the slot. The real server answers in ~1ms, so this never trips a legit
    // bridge. Cleared on a verified handshake / onclose.
    if (trustedBridgeToken !== null) armIdentityTimer(port, socket);

    // Permission broker: check once (not per-connection)
    if (wsBridges.size === 1) {
      hasAllPermissions().then((granted) => {
        if (!granted) {
          getMissingPermissions().then((missing) => {
            chrome.storage.session.set({ "crawlio:pendingPermissions": missing });
            chrome.action.setBadgeText({ text: "!" });
            chrome.action.setBadgeBackgroundColor({ color: "#F97316" });
          });
        }
      });
    }
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (!msg || typeof msg !== "object" || !msg.type) return;

      // Server-identity handshake response. The proof is bound to the port WE
      // dialed, so a proof relayed from a server on another port fails here.
      if (msg.type === HANDSHAKE_MESSAGE_TYPES.handshake) {
        const trust = bridgeTrust.get(port);
        if (trust && trustedBridgeToken) {
          trust.verified = await verifyHandshakeProof(trustedBridgeToken, trust.nonce, port, msg.proof);
          const t = identityTimers.get(port);
          if (t) { clearTimeout(t); identityTimers.delete(port); }
          if (trust.verified) {
            // Proven holder of the trusted token. If this is a CANDIDATE (not yet the active
            // bridge), promote it now and close the old incumbent — only a proven
            // token holder can win this cutover.
            if (activeBridgePort !== port) promoteVerifiedBridge(port, socket);
          } else {
            console.warn(`[Crawlio] Server on :${port} failed identity handshake — disconnecting (possible rogue server)`);
            intentionalClose.add(socket); // failed proof — drop without a per-port reconnect loop
            try { socket.close(); } catch { /* already closing */ }
          }
        }
        return;
      }

      // When a trusted token is provisioned, refuse a server that has not
      // proven its identity. With no provisioning this is trust-on-first-use
      // ("tofu-allow"), i.e. unchanged behavior.
      const decision = evaluateServerTrust(trustedBridgeToken !== null, bridgeTrust.get(port)?.verified === true);
      if (decision === "refuse") return;

      const response = await handleIncomingMessage(msg, "ws");
      // Route response back through THIS socket (per-connection routing)
      if (response && socket.readyState === WebSocket.OPEN) {
        safeWebSocketSend(socket, JSON.stringify(response));
      }
    } catch (e) {
      if (__DEV__) console.error("[Crawlio] Command error:", e);
    }
  };

  socket.onclose = () => {
    clearTimeout(handshakeTimer);
    // Only clear per-port bookkeeping if THIS socket is still the one tracked for `port`.
    // closeIncumbent() removes a socket from the map BEFORE closing it, which unblocks a
    // re-dial of the same port — so a replacement socket may have fully opened (with its
    // own trust nonce + identity timer) before this zombie's onclose lands. Wiping the
    // replacement's handshake state here would leave it permanently unverified: refused
    // in token mode, yet never dropped (its identity timer was also cleared).
    const wasTracked = wsBridges.get(port) === socket;
    if (wasTracked) {
      const idTimer = identityTimers.get(port);
      if (idTimer) { clearTimeout(idTimer); identityTimers.delete(port); }
      wsBridges.delete(port);
      bridgeTrust.delete(port); // drop handshake state for this port
    }
    // A never-opened socket still owns the connectingPorts slot it reserved at dial time;
    // an opened one released it in onopen, so a present entry belongs to a newer dial.
    if (!wasOpen) connectingPorts.delete(port);

    // If the socket that just died is the ACTIVE bridge, forget the pointer so the next
    // discovery re-elects — whether the close was planned or not (a failed-identity drop of
    // the active rogue must not leave activeBridgePort dangling at a dead socket).
    if (activeBridgePort === port) activeBridgePort = null;

    const wasIntentional = intentionalClose.has(socket);
    if (wasIntentional) intentionalClose.delete(socket);

    // Planned close (cutover away / failed-identity drop): do NOT schedule the per-port
    // reconnect — we deliberately abandoned this socket.
    if (wasIntentional) {
      updateBridgeStatus();
      return;
    }

    // User explicitly disconnected — STOP_BRIDGE already wrote the status
    if (userDisconnected) return;

    updateBridgeStatus();

    // Safety-net alarm — survives SW restart, catches lost setTimeout timers
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });

    // Delay bridgeConnected:false — suppress popup flicker during reconnection
    if (wsBridges.size === 0 && !pendingDisconnectTimer) {
      pendingDisconnectTimer = setTimeout(() => {
        pendingDisconnectTimer = null;
        if (wsBridges.size === 0) {
          chrome.storage.session.set({ "crawlio:bridgeConnected": false });
        }
      }, 5000);
    }

    // Dead-man release: if the server stays gone, drop orphaned debugger attachments + the
    // "being debugged" banner after a grace period (skipped while a recording is in progress).
    if (wsBridges.size === 0) scheduleDebuggerRelease();

    // Only retry this port if it was a genuine disconnect (was open).
    // Failed connection attempts are handled by the alarm-based discovery.
    if (wasOpen) {
      const retryDelay = portRetryDelays.get(port) ?? RECONNECT_BASE;
      portRetryDelays.set(port, Math.min(retryDelay * 2, RECONNECT_CAP));
      setTimeout(() => {
        if (!userDisconnected) {
          probePort(port).then(probe => { if (probe) connectToPort(port); });
        }
      }, retryDelay);
    }
  };

  socket.onerror = () => closeFailedHandshake(socket, "socket-error");
}

async function discoverAndConnectAll() {
  // Ensure reconnect alarm exists so we always retry, even if this probe fails
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });

  // Connect the native-messaging TOKEN PROVISIONER, best-effort. It is NOT a command
  // transport — it only hands us the trusted bridge token over Chrome's authenticated channel
  // (set_crawlio_token, which arrives shortly after and re-challenges the active bridge) so the
  // WS handshake can refuse rogue servers. Commands always flow over the WS bridge, so we
  // ALWAYS proceed to WS discovery below, whether or not the token channel connected.
  await connectNative().catch(() => false);

  // Scan port range in parallel for crawlio-mcp servers, then attach to exactly ONE —
  // the most-recently-active live bridge (single-bridge election). This replaces the old
  // "connect to every responder" loop that made every server hear every reply.
  const probePromises: Promise<{ port: number; lastActivityAt: number } | null>[] = [];
  for (let port = WS_PORT_START; port <= WS_PORT_END; port++) {
    probePromises.push(probePort(port));
  }
  const results = await Promise.allSettled(probePromises);

  const live: BridgeProbe[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) live.push(result.value);
  }

  connectPlannedBridges(live);

  if (live.length === 0 && wsBridges.size === 0) {
    consecutiveProbeFailures++;
    if (wasEverConnected || consecutiveProbeFailures <= MAX_PROBE_RETRIES) {
      setTimeout(requestBridgeDiscovery, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP);
    }
  } else {
    consecutiveProbeFailures = 0;
  }
}

// Arm the identity-handshake deadline for `socket` on `port`: if it hasn't proven it holds
// the trusted token within the window, drop it (flagged intentional so onclose skips the
// reconnect). Only meaningful while a trusted token is held.
function armIdentityTimer(port: number, socket: WebSocket): void {
  const prev = identityTimers.get(port);
  if (prev) clearTimeout(prev);
  identityTimers.set(port, setTimeout(() => {
    identityTimers.delete(port);
    if (bridgeTrust.get(port)?.verified !== true) {
      intentionalClose.add(socket);
      closeFailedHandshake(socket, "identity-unverified");
    }
  }, WS_HANDSHAKE_TIMEOUT));
}

// Close the socket we're abandoning during a promotion/cutover. Flag it by SOCKET
// so its onclose skips the per-port reconnect, drop it from the map immediately so routing
// can't pick it, and clear its handshake bookkeeping. Never closes `keep` (the socket we're
// switching TO).
function closeIncumbent(previousPort: number, keep: WebSocket): void {
  const old = wsBridges.get(previousPort);
  if (old && old !== keep) {
    intentionalClose.add(old);
    wsBridges.delete(previousPort);
    const t = identityTimers.get(previousPort);
    if (t) { clearTimeout(t); identityTimers.delete(previousPort); }
    bridgeTrust.delete(previousPort);
    try { old.close(1000, "rebridge"); } catch { /* already closing */ }
  }
}

// Promote a verified candidate to THE active bridge: point routing at it, THEN close the
// previous incumbent (close-after-open, so no in-flight send falls into a routing gap).
// Called only after the candidate proved it holds the trusted token.
function promoteVerifiedBridge(port: number, socket: WebSocket): void {
  const previous = activeBridgePort;
  if (previous === port) return;
  activeBridgePort = port;
  if (previous !== null) closeIncumbent(previous, socket);
  updateBridgeStatus();
  if (__DEV__) console.log(`[Crawlio] Promoted verified bridge :${port} (was :${previous ?? "none"})`);
}

// Re-issue the identity challenge to an already-open socket. Used when the trusted token
// changes (set_crawlio_token): the socket's earlier verdict was made under a DIFFERENT
// token (or under TOFU), so it must re-prove under the new one — whichever server actually
// holds the new token re-verifies and the rest get dropped/refused.
function rechallengeBridge(port: number): void {
  const socket = wsBridges.get(port);
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const nonce = randomNonce();
  bridgeTrust.set(port, { nonce, verified: false });
  safeWebSocketSend(socket, JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce }));
  if (trustedBridgeToken !== null) armIdentityTimer(port, socket);
}

// Open sockets to the bridge(s) the connection plan selects: a single elected bridge in
// TOFU, or every live candidate when a trusted token is held but none is verified yet (so
// the handshake can find the real server even if a rogue forges max activity). Routing stays
// single (sendToTransport → activeBridgePort), so opening several sockets never re-creates
// the reply storm. Promotion + teardown happen in connectToPort's onopen/onmessage.
function connectPlannedBridges(live: BridgeProbe[]): void {
  const ports = planBridgeConnections(live, {
    hasToken: trustedBridgeToken !== null,
    activePort: activeBridgePort,
    activeIsOpen: activeBridgePort !== null && wsBridges.get(activeBridgePort)?.readyState === WebSocket.OPEN,
    activeVerified: activeBridgePort !== null && bridgeTrust.get(activeBridgePort)?.verified === true,
  });
  for (const port of ports) connectToPort(port); // connectToPort no-ops for already-connected/connecting ports
}

// Steady-state RE-ELECTION: probe the whole range (we need every live server's activity,
// not just unheld ports) and re-elect the active bridge, so the extension FOLLOWS whichever
// session is currently being driven. Unlike discoverAndConnectAll it never touches native
// messaging or the disconnected backoff. connectPlannedBridges no-ops when the plan resolves
// to the already-active bridge, so a quiet fleet costs only the probes — and when a trusted
// token is held with a verified incumbent it connects to NOTHING (a forged-activity rogue
// can't trigger a cutover).
async function rescanForNewBridges(): Promise<void> {
  if (userDisconnected || wsBridges.size === 0) return;
  const probePromises: Promise<{ port: number; lastActivityAt: number } | null>[] = [];
  for (let port = WS_PORT_START; port <= WS_PORT_END; port++) {
    probePromises.push(probePort(port));
  }
  const results = await Promise.allSettled(probePromises);
  const live: BridgeProbe[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) live.push(result.value);
  }
  connectPlannedBridges(live);
}

async function getAnyActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tab = await getAnyActiveTab();
  if (!tab.url?.startsWith("http")) throw new Error("Cannot capture non-HTTP pages (chrome://, about:, etc.)");
  return tab;
}

// Tab-scoped targeting — uses explicitly connected tab, falls back to auto-connect
async function getConnectedTab(): Promise<chrome.tabs.Tab> {
  // 1. Try explicit connection first
  const data = await chrome.storage.session.get("crawlio:connectedTab");
  const conn = data["crawlio:connectedTab"];

  if (conn?.tabId) {
    try {
      const tab = await chrome.tabs.get(conn.tabId);
      if (tab.url?.startsWith("http") && !tab.discarded) {
        // Ensure debugger is attached (may have been lost on SW restart)
        await ensureDebugger(tab.id!, true);
        return tab;
      }
    } catch {
      // Tab closed or invalid — fall through to auto-connect
    }
    await chrome.storage.session.remove("crawlio:connectedTab");
  }

  // 2. Auto-connect to active tab (lazy connect)
  await ensureTabPermission("auto_connect");
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab.url?.startsWith("http")) {
    throw new Error("No HTTP tab available — open a web page first");
  }

  // Attach debugger + persist (primary/foreground tab)
  await ensureDebugger(activeTab.id, true);
  await chrome.storage.session.set({ "crawlio:connectedTab": {
    tabId: activeTab.id, url: activeTab.url || "", title: activeTab.title || "Untitled",
    favIconUrl: activeTab.favIconUrl, windowId: activeTab.windowId,
  }});

  // Start network capture + initial snapshot (matches connect_tab behavior)
  startNetworkCapture(activeTab.id).catch(() => {});
  handleCommand({ type: "capture_page", id: "auto-connect" }).catch(() => {});
  setDynamicIcon("active", activeTab.id);
  if (__DEV__) console.log(`[Crawlio] Auto-connected to active tab ${activeTab.id}: ${activeTab.url}`);

  return activeTab;
}

// SW-resilient debugger tab resolution.
// Many CDP tools need `debuggerAttachedTabId` but this in-memory variable is lost when
// the MV3 service worker goes dormant. This helper auto-recovers from session storage
// and re-attaches the debugger, so tools work across SW restarts.
// Falls back to lazy auto-connect if no persisted connection exists.
async function requireDebuggerTab(): Promise<number> {
  // Fast path — debugger still attached in this SW lifecycle
  if (debuggerAttachedTabId !== null) return debuggerAttachedTabId;

  // Recovery path — read persisted connection from session storage
  const data = await chrome.storage.session.get("crawlio:connectedTab");
  const conn = data["crawlio:connectedTab"];
  if (conn?.tabId) {
    try {
      const tab = await chrome.tabs.get(conn.tabId);
      if (tab.url?.startsWith("http") && !tab.discarded) {
        await ensureDebugger(conn.tabId, true);
        if (__DEV__) console.log(`[Crawlio] requireDebuggerTab: recovered debugger for tab ${conn.tabId}`);
        return conn.tabId;
      }
    } catch { /* tab gone — fall through */ }
    await chrome.storage.session.remove("crawlio:connectedTab");
  }

  // Lazy fallback — auto-connect to active tab
  const tab = await getConnectedTab();
  return tab.id!;
}

// Ensure the tab is focused and active before input dispatch — UNLESS it was connected in
// background mode (connect_tab({background:true})), where we must never steal the user's active
// tab/window (harness invariant). CDP input still reaches a background tab: browser_scroll and
// agent-sessions already drive non-focused tabs successfully.
async function ensureTabFocused(tabId: number): Promise<void> {
  try {
    const stored = (await chrome.storage.session.get("crawlio:connectedTab"))["crawlio:connectedTab"] as { tabId?: number; background?: boolean } | undefined;
    if (stored?.tabId === tabId && stored.background === true) return; // background connect — no focus-steal
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
    }
  } catch {
    // Best-effort — don't block interaction if focus fails
  }
}

// CDP-based script execution — uses the already-attached debugger session
// (Runtime.evaluate) which is gated solely by the "debugger" permission.
// "permission:debugger" is listed as an independent entry.
// CDP sendCommand is an unrestricted passthrough — no cross-check to scripting.
async function cdpExecuteFunction<T>(tabId: number, func: (...fnArgs: any[]) => unknown, args?: any[], useFrameContext = false): Promise<T | null> {
  const argStr = args ? args.map(a => JSON.stringify(a)).join(",") : "";
  const expression = `(${func.toString()})(${argStr})`;
  try {
    const result = await sendCDPCommand<any>(
      { tabId }, "Runtime.evaluate",
      buildEvalParams(tabId, expression, { returnByValue: true, useFrameContext }), 0
    );
    if (result?.exceptionDetails) return null;
    return result?.result?.value as T;
  } catch { /* CDP evaluate failed — page may have navigated */
    return null;
  }
}

// --- Visible agent cursor (so a human can see where automation is acting) ---
// Tracks which tabs have the cursor controller installed (cosmetic; survives nothing on SW
// restart, re-injected lazily on next use).
const agentCursorInjectedTabs = new Set<number>();
const AGENT_CURSOR_INSTALL_SRC = `(${installAgentCursorInPage.toString()})()`;

// Inject the cursor controller into a tab's page (best-effort — the cursor is purely visual,
// so failures never propagate). Persists across in-session navigations via add-on-new-document.
async function ensureAgentCursor(tabId: number): Promise<void> {
  if (agentCursorInjectedTabs.has(tabId)) return;
  try {
    await sendCDPCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: AGENT_CURSOR_INSTALL_SRC }, 0, 5000);
  } catch { /* persistence is best-effort */ }
  try {
    await sendCDPCommand({ tabId }, "Runtime.evaluate", { expression: AGENT_CURSOR_INSTALL_SRC }, 0, 5000);
    agentCursorInjectedTabs.add(tabId);
  } catch { /* cursor is cosmetic — never block the caller */ }
}

// --- Phase 2: download monitoring (lazy — uses the optional `downloads` permission) ---
interface DownloadRow {
  id: number;
  url?: string;
  filename?: string;
  state?: string;
  error?: string;
  bytesReceived?: number;
  totalBytes?: number;
  mime?: string;
  startTime?: string;
  updatedAt: string;
}
const downloadsById = new Map<number, DownloadRow>();
const DOWNLOAD_LIMIT = 200;
let downloadListenersWired = false;

// Normalize Chrome's download state into the status vocabulary this API reports.
function downloadStatus(state?: string, error?: string): string {
  if (state === "complete") return "complete";
  if (state === "interrupted") return error === "USER_CANCELED" ? "canceled" : "failed";
  if (state === "in_progress") return "in_progress";
  return state ?? "unknown";
}

function upsertDownload(row: Partial<DownloadRow> & { id: number }): void {
  const existing = downloadsById.get(row.id) ?? { id: row.id, updatedAt: "" };
  downloadsById.delete(row.id); // re-insert to keep Map ordered by recency for FIFO eviction
  downloadsById.set(row.id, { ...existing, ...row, updatedAt: new Date().toISOString() });
  while (downloadsById.size > DOWNLOAD_LIMIT) {
    const oldest = downloadsById.keys().next().value;
    if (oldest === undefined) break;
    downloadsById.delete(oldest);
  }
}

// Register download listeners once, only if the optional permission is present.
function wireDownloadListeners(): void {
  if (downloadListenersWired || typeof chrome.downloads === "undefined") return;
  downloadListenersWired = true;
  chrome.downloads.onCreated.addListener((d) => {
    upsertDownload({
      id: d.id, url: d.url, filename: d.filename, state: d.state, error: d.error,
      bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, mime: d.mime, startTime: d.startTime,
    });
  });
  chrome.downloads.onChanged.addListener((delta) => {
    const row: Partial<DownloadRow> & { id: number } = { id: delta.id };
    if (delta.state) row.state = delta.state.current;
    if (delta.filename) row.filename = delta.filename.current;
    if (delta.error) row.error = delta.error.current;
    if (delta.totalBytes && typeof delta.totalBytes.current === "number") row.totalBytes = delta.totalBytes.current;
    upsertDownload(row);
  });
}

// --- Phase 4: dead-man debugger release (clear the orphaned "being debugged" banner) ---
let debuggerReleaseTimer: ReturnType<typeof setTimeout> | null = null;
const DEBUGGER_RELEASE_GRACE_MS = 30000;

// Detach the debugger from every attached tab and mark active sessions interrupted. Used when
// the MCP server (our "host") has been gone long enough that the attachments are orphaned.
async function releaseAllDebuggers(reason: string): Promise<void> {
  for (const tabId of [...attachedTabs]) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* may already be detached */ }
    forgetAttachedTab(tabId);
  }
  for (const session of agentSessions.values()) {
    if (session.status === "active") {
      session.status = "error";
      session.lastError = reason;
      session.updatedAt = new Date().toISOString();
    }
  }
  persistAgentSessions().catch(() => {});
  networkCapturing = false;
  connectionStartTime = null;
  lastCommandTime = null;
  stopIdleReleaseAlarm();
  writeStatus({ capturing: false, activeTabId: null });
  if (__DEV__) console.log(`[Crawlio] ${reason}`);
}

function scheduleDebuggerRelease(): void {
  if (debuggerReleaseTimer || activeRecording) return; // recording legitimately holds the debugger
  if (attachedTabs.size === 0 && getActiveAgentSessionCount() === 0) return; // nothing to release
  debuggerReleaseTimer = setTimeout(() => {
    debuggerReleaseTimer = null;
    if (wsBridges.size === 0 && !activeRecording) {
      releaseAllDebuggers("MCP server gone — released orphaned debugger attachments").catch(() => {});
    }
  }, DEBUGGER_RELEASE_GRACE_MS);
}

function cancelDebuggerRelease(): void {
  if (debuggerReleaseTimer) { clearTimeout(debuggerReleaseTimer); debuggerReleaseTimer = null; }
}

// --- Idle debugger release ---
// Chrome shows a "being debugged" banner while attached. After a configured quiet period we
// detach so the banner clears; the next command re-attaches through ensureDebugger, which
// restores the session (see resumeAfterIdleRelease). Opt-in: absent config = never fires.
const IDLE_RELEASE_ALARM = "crawlio-idle-release";
const IDLE_RELEASE_KEY = "crawlio:idleReleased";
const IDLE_RELEASE_CONFIG_KEY = "crawlio:idleReleaseMs";

async function getIdleReleaseMs(): Promise<number> {
  try {
    const data = await chrome.storage.local.get(IDLE_RELEASE_CONFIG_KEY);
    return resolveIdleReleaseMs(data[IDLE_RELEASE_CONFIG_KEY]);
  } catch {
    return 0;
  }
}

// Only armed when the feature is configured on — otherwise this would wake the service
// worker every 30s to decide it has nothing to do.
async function startIdleReleaseAlarm(): Promise<void> {
  if (await getIdleReleaseMs() > 0) chrome.alarms.create(IDLE_RELEASE_ALARM, { periodInMinutes: 0.5 });
}

function stopIdleReleaseAlarm(): void {
  chrome.alarms.clear(IDLE_RELEASE_ALARM);
}

// Detach quietly, preserving everything a later re-attach needs. Unlike releaseAllDebuggers
// this must NOT mark agent sessions as errored, must NOT clear captured buffers, and must
// NOT drop "crawlio:connectedTab" — that key is what lets the next command find its way back.
async function idleReleaseDebuggers(): Promise<void> {
  const released: Array<{ tabId: number; url: string | null; wasPrimary: boolean }> = [];
  for (const tabId of [...attachedTabs]) {
    let url: string | null = null;
    const wasPrimary = debuggerAttachedTabId === tabId;
    try { url = (await chrome.tabs.get(tabId)).url ?? null; } catch { /* tab may be gone */ }
    try { await chrome.debugger.detach({ tabId }); } catch { /* may already be detached */ }
    forgetAttachedTab(tabId);
    // A programmatic detach does not fire chrome.debugger.onDetach, so its cleanup is ours.
    agentCursorInjectedTabs.delete(tabId);
    released.push({ tabId, url, wasPrimary });
  }
  // Keyed by CDP target/session id, not tab id, and every session just died with its
  // debugger. Left behind, the next attach_to_target command fails on a raw CDP error.
  targetSessions.clear();
  browserContexts.clear();
  // These identify scripts registered on the (now dead) session — leaving them set would make
  // the re-attach path believe stealth and the framework hooks are still installed.
  stealthScriptId = null;
  frameworkHookScriptId = null;
  currentSecurityState = null;
  networkCapturing = false;
  await chrome.storage.session.set({ [IDLE_RELEASE_KEY]: { tabs: released, at: Date.now() } });
  // Snapshot immediately: the periodic persist still claims a live attachment, and a
  // service-worker restart inside that window would restore it and bring the banner back
  // without the user having asked for anything.
  await persistState().catch(() => {});
  writeStatus({ capturing: false });
  stopIdleReleaseAlarm();
  if (__DEV__) console.log(`[Crawlio] Idle — released ${released.length} debugger attachment(s)`);
}

// Re-arm a tab that was idle-released, on the next attach. Restores the injected scripts and
// optional domains that only startNetworkCapture installs, without wiping captured history.
async function resumeAfterIdleRelease(tabId: number): Promise<void> {
  let record: { tabs?: Array<{ tabId: number; url: string | null; wasPrimary?: boolean }> } | undefined;
  try {
    const data = await chrome.storage.session.get(IDLE_RELEASE_KEY);
    record = data[IDLE_RELEASE_KEY];
  } catch { /* session storage unavailable */ }
  const entry = record?.tabs?.find(t => t.tabId === tabId);
  if (!entry) return;

  // Navigation while detached means we missed the events that invalidate ARIA refs.
  try {
    const current = (await chrome.tabs.get(tabId)).url ?? null;
    if (current !== entry.url) tabAriaState.delete(tabId);
  } catch { /* tab may be gone */ }

  try {
    // Only the tab that held the foreground capture reclaims it — a background session
    // attach must not promote itself just because it happened to trigger the resume.
    const started = await startNetworkCapture(tabId, { preserveBuffers: true, makePrimary: entry.wasPrimary });
    if (!started) throw new Error("capture already owned by another tab");
  } catch (err) {
    // Drop the domain record so the NEXT command misses ensureDebugger's fast path and
    // retries this. Without that the tab stays attached with domain state, every later
    // call returns early, and the resume never runs again — leaving stealth and the
    // framework hooks off for the rest of the session while the caller believes they are on.
    tabDomainState.delete(tabId);
    console.warn("[Crawlio] Idle resume failed to restore the session; will retry:", err);
    return;
  }

  // Drop only this tab's record. A release detaches every attached tab, so clearing the
  // whole key here would strand the others — they would re-attach later without their
  // capture restarted or their stale ARIA refs dropped.
  const remaining = (record?.tabs ?? []).filter(t => t.tabId !== tabId);
  if (remaining.length > 0) {
    await chrome.storage.session.set({ [IDLE_RELEASE_KEY]: { ...record, tabs: remaining } });
  } else {
    await chrome.storage.session.remove(IDLE_RELEASE_KEY);
  }
}

async function maybeIdleRelease(): Promise<void> {
  const idleMs = await getIdleReleaseMs();
  const decision = planIdleRelease({
    now: Date.now(),
    lastCommandTime,
    idleMs,
    attachedTabCount: attachedTabs.size,
    activeAgentSessions: getActiveAgentSessionCount(),
    recording: activeRecording !== null,
    pendingDialog: pendingDialog !== null || pendingFileChooser !== null,
    interceptRuleCount: interceptRules.size,
    coverageActive: cssCoverageActive || jsCoverageActive,
    framePinned: activeFrameId !== null,
    commandsInFlight: cdpCommandsInFlight,
  });
  if (decision.action === "release") await idleReleaseDebuggers();
  // Nothing left to release, or the feature was turned off since the alarm was armed —
  // either way stop waking the worker every 30s to decide there is nothing to do. Any
  // later attach re-arms it.
  else if (decision.reason === "disabled" || decision.reason === "nothing-attached") stopIdleReleaseAlarm();
}

// --- Phase 4: deferred-update manager (never reload mid-automation) ---
const PENDING_UPDATE_KEY = "crawlio:pendingUpdateVersion";

function isExtensionIdle(): boolean {
  return getActiveAgentSessionCount() === 0 && !activeRecording && !networkCapturing && attachedTabs.size === 0;
}

// Apply a deferred extension update only when no automation is in flight.
async function maybeApplyPendingUpdate(): Promise<void> {
  try {
    const data = await chrome.storage.session.get(PENDING_UPDATE_KEY);
    if (!data[PENDING_UPDATE_KEY]) return;
    if (isExtensionIdle()) {
      if (__DEV__) console.log("[Crawlio] Applying deferred extension update (idle)");
      chrome.runtime.reload();
    }
  } catch { /* best effort */ }
}

// Navigation wait before capture
async function waitForPageLoad(tabId: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await sendCDPCommand<any>(
        { tabId }, "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true }, 0
      );
      if (result?.result?.value === "complete") return;
    } catch { /* CDP unreachable — stop polling */
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  try {
    await sendCDPCommand({ tabId }, "Page.stopLoading", {}, 0);
  } catch { /* best effort */ }
}

// Wait for DOM mutations to settle after interactions (MutationObserver-based)
async function waitForStableDOM(tabId: number, minStableMs = 1000, maxWaitMs = 3000): Promise<void> {
  try {
    const stableDomExpr = `new Promise((resolve) => {
          let timer;
          const maxTimer = setTimeout(() => { if (observer) observer.disconnect(); resolve(true); }, ${maxWaitMs});
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { observer.disconnect(); clearTimeout(maxTimer); resolve(true); }, ${minStableMs});
          });
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(() => { observer.disconnect(); clearTimeout(maxTimer); resolve(true); }, ${minStableMs});
        })`;
    await sendCDPCommand<{ result: { value: boolean } }>(
      { tabId },
      "Runtime.evaluate",
      buildEvalParams(tabId, stableDomExpr, { awaitPromise: true }),
      0,
      maxWaitMs + 1000
    );
  } catch {
    // Never throws — settling is best-effort
  }
}

// Adaptive screenshot with quality cascade
const MAX_BASE64_CHARS = 1398100; // 1.4MB 

async function takeScreenshotHardened(tabId: number): Promise<string> {
  // Fast path: if target tab is active, use captureVisibleTab (no debugger needed)
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active && tab.windowId) {
      const [activeInWindow] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (activeInWindow?.id === tabId) {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "jpeg",
          quality: 85,
        });
        // captureVisibleTab returns data URL — extract base64
        const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
        if (base64.length <= MAX_BASE64_CHARS) {
          return base64;
        }
        // Too large — fall through to CDP path with quality cascade
      }
    }
  } catch {
    // captureVisibleTab failed (restricted page, permission denied, etc.)
    // Fall through to CDP path
  }

  // CDP fallback: quality cascade for background tabs or oversized captures
  await ensureDebugger(tabId);

  // Get viewport clip from cssVisualViewport
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  try {
    const metrics = await sendCDPCommand<any>({ tabId }, "Page.getLayoutMetrics", {}, 1);
    const vp = metrics?.cssVisualViewport;
    if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
      clip = { x: vp.pageX || 0, y: vp.pageY || 0, width: vp.clientWidth, height: vp.clientHeight, scale: 1 };
    }
  } catch { /* proceed without clip */ }

  // Quality cascade: 85% → 10%, step down 5%
  for (let quality = 85; quality >= 10; quality -= 5) {
    try {
      const result = await sendCDPCommand<{ data: string }>(
        { tabId },
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality,
          ...(clip ? { clip, captureBeyondViewport: false } : {}),
        },
        1
      );
      if (result.data.length <= MAX_BASE64_CHARS) {
        return result.data;
      }
    } catch {
      break; // CDP error, return whatever we have
    }
  }

  // Final attempt at minimum quality without clip
  const result = await sendCDPCommand<{ data: string }>(
    { tabId },
    "Page.captureScreenshot",
    { format: "jpeg", quality: 10 },
    1
  );
  return result.data;
}

// Zoom factor from visualViewport for coordinate correction
async function getZoomFactor(tabId: number): Promise<number> {
  try {
    const result = await sendCDPCommand<{ result: { value: number } }>(
      { tabId },
      "Runtime.evaluate",
      buildEvalParams(tabId, "window.visualViewport?.scale ?? 1"),
      0,
      3000
    );
    return result?.result?.value ?? 1;
  } catch { /* CDP unavailable — assume default zoom */
    return 1;
  }
}

// --- Browser interaction helpers ---

// Key name → {code, keyCode, text?} mapping for Input.dispatchKeyEvent
// text field matches chromedriver: Enter→"\r", Tab→"\t", Space→" " (non-printable keys need explicit text)
const KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9, text: "\t" },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  F1: { code: "F1", keyCode: 112 },
  F2: { code: "F2", keyCode: 113 },
  F3: { code: "F3", keyCode: 114 },
  F4: { code: "F4", keyCode: 115 },
  F5: { code: "F5", keyCode: 116 },
  F6: { code: "F6", keyCode: 117 },
  F7: { code: "F7", keyCode: 118 },
  F8: { code: "F8", keyCode: 119 },
  F9: { code: "F9", keyCode: 120 },
  F10: { code: "F10", keyCode: 121 },
  F11: { code: "F11", keyCode: 122 },
  F12: { code: "F12", keyCode: 123 },
  // Modifier keys (for compound key support: Control+A, Shift+Tab, etc.)
  Control: { code: "ControlLeft", keyCode: 17 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Meta: { code: "MetaLeft", keyCode: 91 },
};

// Modifier bitfield: Alt=1, Ctrl=2, Meta=4, Shift=8
interface MouseOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: number;
}

function buildModifiers(opts: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }): number {
  return (opts.alt ? 1 : 0) | (opts.ctrl ? 2 : 0) | (opts.meta ? 4 : 0) | (opts.shift ? 8 : 0);
}

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
function modifierBit(key: string): number {
  switch (key) {
    case "Alt": return 1;
    case "Control": return 2;
    case "Meta": return 4;
    case "Shift": return 8;
    default: return 0;
  }
}

// Resolve a single ASCII character to key definition; returns null for non-mappable (emoji, CJK)
function resolveCharKey(char: string): { key: string; code: string; keyCode: number; text: string } | null {
  if (char.length > 1) return null; // Multi-codepoint: non-mappable
  const code = char.charCodeAt(0);
  if (code > 127) return null; // Non-ASCII: use insertText
  return {
    key: char,
    code: `Key${char.toUpperCase()}`,
    keyCode: char.toUpperCase().charCodeAt(0),
    text: char,
  };
}

// 3-event click sequence with zoom correction
async function dispatchClick(tabId: number, x: number, y: number, options: MouseOptions = {}): Promise<void> {
  const { button = "left", clickCount = 1, modifiers = 0 } = options;
  const state = getKeyState(tabId);
  const effectiveMods = state.modifiers | modifiers;
  const zoom = await getZoomFactor(tabId);
  const zx = Math.round(x * zoom);
  const zy = Math.round(y * zoom);
  await ensureDebugger(tabId);
  await sendCDPCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: zx, y: zy, button: "none", clickCount: 0, modifiers: effectiveMods,
  }, 0);
  await sendCDPCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: zx, y: zy, button, clickCount, modifiers: effectiveMods,
  }, 0);
  await sendCDPCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: zx, y: zy, button, clickCount, modifiers: effectiveMods,
  }, 0);
}

// Default: atomic Input.insertText — no double-character bug on SPAs.
// When slowly=true: per-character keyDown/char/keyUp.
async function dispatchType(tabId: number, text: string, modifiers = 0, slowly = false): Promise<void> {
  await ensureDebugger(tabId);
  if (!slowly) {
    // Atomic insert — single CDP call, no duplicate events on SPAs
    await sendCDPCommand({ tabId }, "Input.insertText", { text }, 0);
    return;
  }
  // Per-character mode: keyDown/keyUp per char (for testing key handlers)
  const state = getKeyState(tabId);
  for (const char of text) {
    const mapped = KEY_MAP[char] ? { ...KEY_MAP[char], key: char, text: char } : resolveCharKey(char);
    if (mapped) {
      const autoRepeat = state.pressedKeys.has(mapped.code);
      await sendCDPCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: mapped.text ? "keyDown" : "rawKeyDown",
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        text: mapped.text,
        unmodifiedText: mapped.text,
        autoRepeat,
        modifiers: state.modifiers | modifiers,
      }, 0);
      await sendCDPCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        modifiers: state.modifiers | modifiers,
      }, 0);
    } else {
      await sendCDPCommand({ tabId }, "Input.insertText", { text: char }, 0);
    }
  }
}

// CDP key press: compound keys (Control+A), persistent state tracking
async function dispatchKey(tabId: number, key: string, modifiers = 0): Promise<void> {
  await ensureDebugger(tabId);
  const state = getKeyState(tabId);

  // Handle compound keys like "Control+A"; literal "+" is a single key, not a separator
  const parts = key === "+" ? [key] : (key.includes("+") ? key.split("+") : [key]);

  // Escape bypass: Chrome's PreHandleKeyboardEvent intercepts Escape at the browser level
  // before page JS ever sees it. Dispatch synthetic KeyboardEvent via Runtime.evaluate instead.
  // Only for standalone Escape (no modifiers like Ctrl+Escape which are OS shortcuts).
  if (parts.length === 1 && parts[0] === "Escape" && modifiers === 0) {
    await sendCDPCommand({ tabId }, "Runtime.evaluate", {
      expression: `(() => {
        const target = document.activeElement || document.body;
        const kd = new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true, composed: true
        });
        const prevented = !target.dispatchEvent(kd);
        target.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
          bubbles: true, cancelable: true, composed: true
        }));
        if (!prevented) {
          const open = document.querySelector(':popover-open:not([popover="manual"])');
          if (open) open.hidePopover();
        }
      })()`,
      returnByValue: true,
    }, 0);
    return;
  }

  // keyDown for all parts
  for (const part of parts) {
    const keyMapEntry = KEY_MAP[part] || KEY_MAP[part.toLowerCase()];
    const resolved = keyMapEntry
      ? { code: keyMapEntry.code, keyCode: keyMapEntry.keyCode, text: keyMapEntry.text ?? (part.length === 1 ? part : undefined) }
      : resolveCharKey(part);
    if (!resolved) continue;
    const autoRepeat = state.pressedKeys.has(resolved.code);
    state.pressedKeys.add(resolved.code);
    state.modifiers |= modifierBit(part);

    const eventText = resolved.text;
    await sendCDPCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: eventText ? "keyDown" : "rawKeyDown",
      key: part,
      code: resolved.code,
      windowsVirtualKeyCode: resolved.keyCode,
      text: eventText,
      unmodifiedText: eventText,
      autoRepeat,
      modifiers: state.modifiers | modifiers,
    }, 0);
  }

  // keyUp in reverse order
  for (const part of [...parts].reverse()) {
    const keyMapEntry = KEY_MAP[part] || KEY_MAP[part.toLowerCase()];
    const resolved = keyMapEntry
      ? { code: keyMapEntry.code, keyCode: keyMapEntry.keyCode }
      : resolveCharKey(part);
    if (!resolved) continue;
    state.pressedKeys.delete(resolved.code);
    state.modifiers &= ~modifierBit(part);

    await sendCDPCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: part,
      code: resolved.code,
      windowsVirtualKeyCode: resolved.keyCode,
      modifiers: state.modifiers | modifiers,
    }, 0);
  }
}

// --- CDP Element Waiting (AC-1) ---

type WaitState = "attached" | "visible" | "hidden" | "detached";

interface WaitForSelectorOptions {
  selector: string;
  state?: WaitState;     // default: "visible"
  timeout?: number;       // default: 30000ms
  pollInterval?: number;  // default: 100ms
}

async function waitForSelector(
  tabId: number,
  options: WaitForSelectorOptions
): Promise<{ found: boolean; timedOut?: boolean }> {
  await ensureDebugger(tabId);
  const state = options.state ?? "visible";
  const timeout = Math.max(options.timeout ?? 30000, 100); // min 100ms to avoid race condition
  const poll = options.pollInterval ?? 100;

  // MutationObserver + polling hybrid: observer catches DOM mutations, polling catches CSS changes
  const script = `
    new Promise((resolve) => {
      const TIMEOUT = ${Math.min(timeout, 60000)};
      const POLL = ${Math.min(Math.max(poll, 50), 5000)};
      const selector = ${JSON.stringify(options.selector)};
      const state = ${JSON.stringify(state)};

      function isOpacityZero(style) {
        const v = parseFloat(style.opacity);
        return !isNaN(v) && v === 0;
      }

      function checkElement() {
        let el;
        try { el = document.querySelector(selector); }
        catch (e) { return { found: false, error: "Invalid selector: " + e.message }; }
        switch (state) {
          case "attached":
            return el ? { found: true } : null;
          case "visible": {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const vis = rect.width > 0 && rect.height > 0
              && style.display !== "none"
              && style.visibility !== "hidden"
              && !isOpacityZero(style);
            return vis ? { found: true } : null;
          }
          case "hidden": {
            if (!el) return { found: true };
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return (r.width === 0 || r.height === 0
              || s.display === "none"
              || s.visibility === "hidden"
              || isOpacityZero(s)) ? { found: true } : null;
          }
          case "detached":
            return !el ? { found: true } : null;
          default:
            return null;
        }
      }

      // Immediate check
      const immediate = checkElement();
      if (immediate) { resolve(immediate); return; }

      // Observer + polling hybrid with resolved guard to prevent double-cleanup
      let resolved = false;
      let timer, observer, pollTimer;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearInterval(pollTimer);
        if (observer) observer.disconnect();
      };

      timer = setTimeout(() => {
        cleanup();
        resolve({ found: false, timedOut: true });
      }, TIMEOUT);

      observer = new MutationObserver(() => {
        const result = checkElement();
        if (result) { cleanup(); resolve(result); }
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["style", "class", "hidden", "disabled"]
      });

      // Polling fallback for CSS changes MutationObserver can't detect (e.g. CSS animations)
      pollTimer = setInterval(() => {
        const result = checkElement();
        if (result) { cleanup(); resolve(result); }
      }, POLL);
    })
  `;

  const result = await sendCDPCommand<{ result: { value?: { found: boolean; timedOut?: boolean } } }>(
    { tabId }, "Runtime.evaluate",
    buildEvalParams(tabId, script, { awaitPromise: true }),
    0, // no retry — the script handles its own timeout
    timeout + 5000, // CDP timeout slightly longer than script timeout
  );

  return result?.result?.value ?? { found: false, timedOut: true };
}

// --- CDP Element Visibility Pipeline (AH-4) ---

// Resolve CSS selector to CDP remote object ID
// AC-2: Uses activeFrameId's contextId when set for implicit frame targeting
// Parse text selector syntax: "text=Continue" or "button >> text=Continue"
function resolveTextSelector(selector: string): string {
  // ">> text=X" suffix: "button >> text=Continue" → find button containing text
  const pipeMatch = selector.match(/^(.+?)\s*>>\s*text=(.+)$/);
  if (pipeMatch) {
    const base = pipeMatch[1].trim();
    const text = pipeMatch[2].trim();
    // XPath can't be used with querySelector, so we use a JS expression selector
    // We'll encode this as a special marker that resolveElement will handle
    return `__text_selector__${JSON.stringify({ base, text })}`;
  }
  // Bare "text=X": find any element containing text
  const bareMatch = selector.match(/^text=(.+)$/);
  if (bareMatch) {
    const text = bareMatch[1].trim();
    return `__text_selector__${JSON.stringify({ base: "*", text })}`;
  }
  return selector;
}

async function resolveElement(tabId: number, selector: string): Promise<string> {
  await ensureDebugger(tabId);

  // Handle text selectors
  if (selector.startsWith("__text_selector__")) {
    const { base, text } = JSON.parse(selector.slice("__text_selector__".length));
    const expr = `(() => {
      const candidates = document.querySelectorAll(${JSON.stringify(base)});
      const needle = ${JSON.stringify(text)}.toLowerCase();
      for (const el of candidates) {
        const content = (el.textContent || '').trim().toLowerCase();
        if (content === needle || content.includes(needle)) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') return el;
        }
      }
      return null;
    })()`;
    const result = await sendCDPCommand<{ result: { objectId?: string } }>(
      { tabId }, "Runtime.evaluate",
      buildEvalParams(tabId, expr, { returnByValue: false })
    );
    if (!result.result.objectId) throw new Error(`Element not found with text "${text}" (base: ${base})`);
    return result.result.objectId;
  }

  // Standard CSS selector — find first visible match when multiple exist
  const expr = `(() => {
    const all = document.querySelectorAll(${JSON.stringify(selector)});
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }
    return all[0];
  })()`;
  const result = await sendCDPCommand<{ result: { objectId?: string } }>(
    { tabId }, "Runtime.evaluate",
    buildEvalParams(tabId, expr, { returnByValue: false })
  );
  if (!result.result.objectId) throw new Error(`Element not found: ${selector}`);
  return result.result.objectId;
}

// AC-26: Parse hex color to CDP RGBA format
function parseOverlayColor(color?: string): { r: number; g: number; b: number; a: number } {
  if (!color) return { r: 111, g: 168, b: 220, a: 0.66 };
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16) || 0;
  const g = parseInt(hex.substring(2, 4), 16) || 0;
  const b = parseInt(hex.substring(4, 6), 16) || 0;
  const a = hex.length >= 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 0.66;
  return { r, g, b, a };
}

// Resolve CSS selector → DOM nodeId via DOM.getDocument + DOM.querySelector
// Error: "Could not find node with given id" if nodeId invalid
async function resolveNodeId(tabId: number, selector: string): Promise<number> {
  await ensureDebugger(tabId);
  const doc = await sendCDPCommand<{ root: { nodeId: number } }>(
    { tabId }, "DOM.getDocument", {}
  );
  const node = await sendCDPCommand<{ nodeId: number }>(
    { tabId }, "DOM.querySelector",
    { nodeId: doc.root.nodeId, selector }
  );
  if (!node?.nodeId) throw new Error(`Element not found: ${selector}`);
  return node.nodeId;
}

// Check element visibility via CDP Runtime.callFunctionOn
async function isElementVisible(tabId: number, objectId: string): Promise<boolean> {
  const result = await sendCDPCommand<{ result: { value: boolean } }>(
    { tabId }, "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() {
        const style = window.getComputedStyle(this);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        let el = this;
        while (el) {
          if (parseFloat(window.getComputedStyle(el).opacity) === 0) return false;
          el = el.parentElement;
        }
        const rect = this.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }`,
      returnByValue: true,
    }
  );
  return result.result.value;
}

// Scroll element into view — CDP native with JS fallback
async function scrollElementIntoView(tabId: number, objectId: string): Promise<void> {
  try {
    await sendCDPCommand({ tabId }, "DOM.scrollIntoViewIfNeeded", { objectId });
  } catch {
    // Fallback: JS scrollIntoView
    await sendCDPCommand({ tabId }, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'end', inline: 'nearest' }); }`,
    });
  }
}

// Get element center via CDP DOM.getBoxModel (content quad center)
async function getElementCenter(tabId: number, objectId: string): Promise<{ x: number; y: number }> {
  const boxModel = await sendCDPCommand<{ model: { content: number[] } }>(
    { tabId }, "DOM.getBoxModel", { objectId }
  );
  const quad = boxModel.model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  return { x: Math.round(x), y: Math.round(y) };
}

// Full pre-interaction pipeline: visibility check → scroll → re-check → center coords
async function prepareElementForInteraction(tabId: number, selector: string): Promise<{ objectId: string; x: number; y: number }> {
  const objectId = await resolveElement(tabId, selector);

  if (!await isElementVisible(tabId, objectId)) {
    await scrollElementIntoView(tabId, objectId);
    if (!await isElementVisible(tabId, objectId)) {
      throw new Error(`Element not visible after scroll: ${selector}`);
    }
  }

  const coords = await getElementCenter(tabId, objectId);
  return { objectId, ...coords };
}

// AH-5: Check element freshness via isConnected
async function isElementFresh(tabId: number, objectId: string): Promise<boolean> {
  try {
    const result = await sendCDPCommand<{ result: { value: boolean } }>(
      { tabId },
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() { return this.isConnected; }`,
        returnByValue: true,
      }
    );
    return result.result.value === true;
  } catch { /* element may be garbage-collected or page navigated */
    return false;
  }
}

// AH-5: Stale element wrapper — resolve + freshness check + retry on stale detection
async function withFreshElement<T>(
  tabId: number,
  selector: string,
  fn: (prepared: { objectId: string; x: number; y: number }) => Promise<T>,
  maxRetries = 1
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prepared = await prepareElementForInteraction(tabId, selector);

    if (await isElementFresh(tabId, prepared.objectId)) {
      try {
        return await fn(prepared);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt < maxRetries && (msg.includes("not found") || msg.includes("stale") || msg.includes("Could not find"))) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        throw error;
      }
    }

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Element stale after ${maxRetries} retries: ${selector}`);
}

// Injected JS: Focus element
function focusElementInPage(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  const doc = el.ownerDocument || document;
  const prev = doc.activeElement;
  if (el !== prev && prev) (prev as HTMLElement).blur?.();
  (el as HTMLElement).focus();
  // Verify focus (walks shadow DOM chain — pattern)
  let active: Element | null = doc.activeElement;
  let shadow = (active as any)?.shadowRoot;
  while (shadow) {
    active = shadow.activeElement;
    if (el === active) break;
    shadow = (active as any)?.shadowRoot;
  }
  if (el !== active && !el.contains(active))
    throw new Error(`Cannot focus element: ${selector}`);
  return true;
}

// Injected JS: Select option by value
function selectOptionInPage(selector: string, value: string): { previousValue: string; newValue: string } {
  const el = document.querySelector(selector) as HTMLSelectElement | null;
  if (!el) throw new Error(`Element not found: ${selector}`);
  if (el.tagName !== "SELECT") throw new Error(`Element is not a <select>: ${selector}`);
  const prev = el.value;
  el.value = value;
  // Verify option exists
  if (el.value !== value) throw new Error(`Option value "${value}" not found in ${selector}`);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { previousValue: prev, newValue: el.value };
}

// --- Crawlio direct HTTP (port cached via MCP push) ---
async function crawlioFetch(path: string, options?: RequestInit): Promise<Response> {
  const data = await chrome.storage.local.get("crawlio:port");
  const port = data["crawlio:port"];
  if (!port) throw new Error("Crawlio macOS app is not running. Open it and try again.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port from storage");
  const doFetch = (p: number) => fetch(`http://127.0.0.1:${p}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  try {
    return await doFetch(port);
  } catch {
    // Network error — port may be stale after Crawlio restart. Ask MCP to refresh.
    sendToTransport({ type: "refresh_port" });
    await new Promise(r => setTimeout(r, 300));
    const fresh = await chrome.storage.local.get("crawlio:port");
    const newPort = fresh["crawlio:port"];
    if (newPort && newPort !== port) return doFetch(newPort);
    throw new Error("Crawlio macOS app is not running. Open it and try again.");
  }
}

/**
 * Fetch enrichment data from Crawlio macOS app for a given URL.
 * Falls back to this when accumulator is empty (extension reloaded, data flushed).
 * Mirrors read-back pattern.
 */
async function crawlioEnrichmentFetchBack(url: string): Promise<{
  capture: Record<string, any>;
  network: any[];
  console: any[];
} | null> {
  try {
    const encoded = encodeURIComponent(url);
    const resp = await crawlioFetch(`/enrichment?url=${encoded}`);
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data || !data.url) return null;

    return {
      capture: {
        url: data.url,
        title: data.title || "",
        framework: data.framework || null,
        capturedAt: data.capturedAt || new Date().toISOString(),
        screenshot: data.screenshot || null,
        domSnapshot: data.domSnapshotJSON || null,
        consoleLogs: data.consoleLogs || [],
      },
      network: data.networkRequests || [],
      console: data.consoleLogs || [],
    };
  } catch { /* IDB or storage read failed */
    return null;
  }
}

/**
 * POST framework detection to Crawlio macOS app.
 * Fire-and-forget — best-effort, never blocks capture flow.
 */
async function dispatchFrameworkTelemetry(url: string, framework: FrameworkDetection): Promise<void> {
  try {
    await crawlioFetch("/enrichment/framework", {
      method: "POST",
      body: JSON.stringify({
        url,
        framework: {
          framework: framework.framework,
          subtype: framework.subtype || null,
          confidence: framework.confidence,
          signals: framework.signals,
          version: framework.version || null,
          ssrMode: framework.ssrMode || null,
          detectionSource: "dynamic",
        },
      }),
    });
  } catch {
    // Fire-and-forget — Crawlio app may not be running
  }
}

// --- CDP Cookie Capture ---

const SENSITIVE_COOKIE_PATTERNS = ["session", "csrf", "token", "auth", "jwt", "sid", "ssid"];

function isSensitiveCookie(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_COOKIE_PATTERNS.some(p => lower.includes(p));
}

async function captureCookies(tabId: number, pageUrl: string): Promise<CookieEntry[]> {
  const result = await sendCDPCommand<{ cookies: any[] }>(
    { tabId },
    "Network.getCookies",
    { urls: [pageUrl] }
  );
  if (!result?.cookies) return [];
  return result.cookies.map((c: any) => ({
    name: c.name,
    value: isSensitiveCookie(c.name) ? "[REDACTED]" : c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite || "Lax",
    size: c.size,
  }));
}

function getStorageId(url: string, storageType: "local" | "session"): { securityOrigin: string; isLocalStorage: boolean } {
  const origin = new URL(url).origin;
  return { securityOrigin: origin, isLocalStorage: storageType === "local" };
}

function getSecurityOrigin(url: string): string {
  try {
    const origin = new URL(url).origin;
    if (!origin || origin === "null") throw new Error("Non-HTTP origin");
    return origin;
  } catch {
    throw new Error(`Cannot derive securityOrigin from URL: "${url}". Ensure a tab with an HTTP/HTTPS URL is connected.`);
  }
}

async function handleCommandWithRecording(command: any): Promise<any> {
  const { type, id } = command;

  // Handle recording-specific commands
  switch (type) {
    case "start_recording": {
      if (activeRecording) {
        // Idempotent: if recording is already active on the same tab, return current state
        if (activeRecording.tabId === debuggerAttachedTabId) {
          return { type: "response", id, success: true, data: {
            sessionId: activeRecording.sessionId,
            startedAt: activeRecording.startedAt,
            tabId: activeRecording.tabId,
            url: activeRecording.currentPageUrl,
            alreadyActive: true,
          }};
        }
        return { type: "response", id, success: false, error: "Recording already active. Stop the current recording first." };
      }
      const tabId = await requireDebuggerTab();
      let tabUrl = "";
      let tabTitle = "";
      try {
        const tab = await chrome.tabs.get(tabId);
        tabUrl = tab.url || "";
        tabTitle = tab.title || "";
      } catch {
        return { type: "response", id, success: false, error: "Connected tab no longer exists." };
      }

      // Ensure network capture is active
      if (!networkCapturing) {
        await startNetworkCapture(tabId);
      }

      const maxDurationSec = Math.min(Math.max(command.maxDurationSec ?? RECORDING_MAX_DURATION, 10), RECORDING_MAX_DURATION);
      const maxInteractions = Math.min(Math.max(command.maxInteractions ?? RECORDING_MAX_INTERACTIONS, 1), RECORDING_MAX_INTERACTIONS);
      const sessionId = crypto.randomUUID();
      const startedAt = new Date().toISOString();

      activeRecording = {
        sessionId,
        startedAt,
        _startedAtMs: Date.now(),
        tabId,
        initialUrl: tabUrl,
        maxDurationSec,
        maxInteractions,
        timeoutHandle: setTimeout(() => autoStopRecording("max_duration"), maxDurationSec * 1000),
        pages: [{
          url: tabUrl,
          title: tabTitle,
          enteredAt: startedAt,
          console: [],
          network: [],
          interactions: [],
        }],
        currentPageUrl: tabUrl,
        totalInteractions: 0,
        networkSnapshotKeys: new Set(networkEntries.keys()),
        consoleSnapshotIndex: consoleLogs.length,
      };

      showRecordingIndicator(tabId);
      setupInteractionCapture(tabId).catch(() => {});

      return { type: "response", id, success: true, data: { sessionId, startedAt, tabId, url: tabUrl } };
    }

    case "stop_recording": {
      if (!activeRecording) {
        // Check for auto-stopped session
        if (lastAutoStoppedSession) {
          const session = lastAutoStoppedSession;
          lastAutoStoppedSession = null;
          if (lastAutoStoppedTimer) { clearTimeout(lastAutoStoppedTimer); lastAutoStoppedTimer = null; }
          return { type: "response", id, success: true, data: session };
        }
        return { type: "response", id, success: false, error: "No active recording to stop." };
      }
      const recTabId = activeRecording.tabId;
      const session = stopRecordingInternal("manual");
      removeRecordingIndicator(recTabId);
      teardownInteractionCapture(recTabId);
      return { type: "response", id, success: true, data: session };
    }

    case "get_recording_status": {
      if (!activeRecording) {
        return { type: "response", id, success: true, data: { active: false } };
      }
      const now = Date.now();
      const startMs = new Date(activeRecording.startedAt).getTime();
      return { type: "response", id, success: true, data: {
        active: true,
        sessionId: activeRecording.sessionId,
        durationSec: Math.round((now - startMs) / 1000),
        pageCount: activeRecording.pages.length,
        interactionCount: activeRecording.totalInteractions,
        currentPageUrl: activeRecording.currentPageUrl,
      }};
    }
  }

  // Intercept interaction tools when recording is active
  if (activeRecording && RECORDING_INTERACTION_TOOLS.has(type) && !command._internal) {
    const startTime = Date.now();
    const result = await handleCommand(command);
    const durationMs = Date.now() - startTime;

    const pageUrl = result?.data?.url || activeRecording.currentPageUrl;

    // Detect page transition from browser_navigate
    if (type === "browser_navigate" && result?.success && result.data?.url
        && result.data.url !== activeRecording.currentPageUrl) {
      startNewRecordingPage(result.data.url, result.data.title);
    }

    // Record the interaction (cap payload at 100KB)
    const { type: _, id: _id, ...args } = command;
    let interactionResult = result?.data;
    if (interactionResult != null) {
      try {
        const serialized = JSON.stringify(interactionResult);
        if (serialized.length > 100_000) {
          interactionResult = { _truncated: true, originalSize: serialized.length, type: typeof interactionResult };
        }
      } catch { /* non-serializable — keep as-is */ }
    }
    const currentPage = activeRecording.pages[activeRecording.pages.length - 1];
    currentPage.interactions.push({
      timestamp: new Date().toISOString(),
      tool: type,
      args,
      result: interactionResult,
      durationMs,
      pageUrl,
      source: "mcp",
    });
    activeRecording.totalInteractions++;

    // Auto-stop if max interactions reached
    if (activeRecording.totalInteractions >= activeRecording.maxInteractions) {
      autoStopRecording("max_interactions");
    }

    return result;
  }

  return handleCommand(command);
}

// Lightweight WS command validation (defense-in-depth)
const BLOCKED_URL_SCHEMES = /^(file|chrome|chrome-extension|about|data|javascript):/i;
const MAX_EXPRESSION_LENGTH = 100_000; // 100KB
const MAX_SELECTOR_LENGTH = 1000;

function validateCommand(command: any): string | null {
  // Validate URL fields
  for (const key of ["url", "targetUrl"]) {
    if (typeof command[key] === "string" && BLOCKED_URL_SCHEMES.test(command[key])) {
      return `Blocked URL scheme in ${key}. Only http: and https: URLs are allowed.`;
    }
  }
  // Validate expression length
  if (typeof command.expression === "string" && command.expression.length > MAX_EXPRESSION_LENGTH) {
    return `Expression exceeds ${MAX_EXPRESSION_LENGTH} character limit.`;
  }
  // Validate selector length
  if (typeof command.selector === "string" && command.selector.length > MAX_SELECTOR_LENGTH) {
    return `Selector exceeds ${MAX_SELECTOR_LENGTH} character limit.`;
  }
  return null;
}

async function handleCommand(command: any): Promise<any> {
  const { type, id } = command;

  // Validate command fields before processing
  const validationError = validateCommand(command);
  if (validationError) {
    return { type: "response", id, success: false, error: validationError };
  }

  try {
    switch (type) {
      case "ping":
        return { type: "pong", id };

      case "check_permissions": {
        // Per-FEATURE permission broker: check EXACTLY the permissions the calling tool declares
        // it needs — never the whole OPTIONAL_PERMISSIONS set. `nativeMessaging` is optional
        // because only the native-messaging transport needs it, so users who never use that
        // transport are never asked for it. It must NEVER be part of a functional tool gate:
        // bundling it via hasAllPermissions() made every browser tool (browser_snapshot /
        // browser_wait_for / switch_tab …) intermittently demand a permission it does not use.
        // Default to ["tabs"] for the current CDP browser primitives when the caller doesn't specify;
        // future skills pass their own (e.g. clipboardRead) — the extension acquires exactly what's needed.
        const requested = (Array.isArray(command.permissions) && command.permissions.length > 0)
          ? (command.permissions as string[])
          : ["tabs"];
        const permissions: Record<string, boolean> = {};
        const missingPerms: string[] = [];
        for (const p of requested) {
          const ok = await new Promise<boolean>((resolve) => {
            chrome.permissions.contains({ permissions: [p] }, (g) => resolve(g === true));
          });
          permissions[p] = ok;
          if (!ok) missingPerms.push(p);
        }
        return { type: "response", id, success: true, data: {
          granted: missingPerms.length === 0,
          permissions,
          missing: { permissions: missingPerms, origins: [] },
          required: ["debugger", "storage"],
          optional: OPTIONAL_PERMISSIONS.permissions || [],
          optionalOrigins: OPTIONAL_PERMISSIONS.origins || [],
        }};
      }

      case "request_permissions": {
        const reqGranted = await hasAllPermissions();
        if (reqGranted) {
          return { type: "response", id, success: true, data: { granted: true, missing: { permissions: [], origins: [] } } };
        }
        const reqMissing = await getMissingPermissions();
        await chrome.storage.session.set({ "crawlio:pendingPermissions": reqMissing });
        return { type: "response", id, success: true, data: {
          granted: false,
          missing: reqMissing,
          instruction: "Click the Crawlio extension icon and grant the requested permissions.",
        }};
      }

      case "connect_tab": {
        await ensureTabPermission(type);
        const targetUrl = command.url as string | undefined;
        const targetTabId = command.tabId as number | undefined;
        const background = command.background === true;
        let tab: chrome.tabs.Tab;

        if (targetTabId) {
          try { tab = await chrome.tabs.get(targetTabId); }
          catch { throw new Error(`Tab ${targetTabId} not found`); }
          if (!tab.url?.startsWith("http")) throw new Error(`Tab is not HTTP: ${tab.url}`);
          if (tab.discarded) throw new Error(`Tab ${targetTabId} is discarded — activate it first`);
        } else if (targetUrl) {
          // Convert exact URL to Chrome match pattern for tabs.query
          const parsedUrl = new URL(targetUrl);
          const matchPattern = `${parsedUrl.protocol}//${parsedUrl.host}/*`;
          const existing = await chrome.tabs.query({ url: matchPattern });
          // Prefer tab with exact URL match, fall back to first tab on host
          const exactMatch = existing.find(t => {
            if (!t.url) return false;
            try { return new URL(t.url).href === new URL(targetUrl).href; } catch { return false; }
          });
          // Only fall back to host-match when input URL has no specific path
          const inputHasPath = parsedUrl.pathname.length > 1;
          const matched = exactMatch ?? (inputHasPath ? undefined : existing[0]);
          if (matched?.id) {
            tab = matched;
            // Background connect: don't steal the user's active tab/window (harness invariant).
            if (!background) await chrome.tabs.update(tab.id!, { active: true });
          } else {
            tab = await chrome.tabs.create({ url: targetUrl, active: !background });
            await new Promise<void>((resolve) => {
              let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
              const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
                if (tabId === tab.id && info.status === "complete") {
                  clearTimeout(timeoutHandle);
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              timeoutHandle = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
            });
            tab = await chrome.tabs.get(tab.id!);
          }
        } else {
          tab = await getActiveTab();
        }

        await chrome.storage.session.set({ "crawlio:connectedTab": {
          tabId: tab.id!, url: tab.url || "", title: tab.title || "Untitled",
          favIconUrl: tab.favIconUrl, windowId: tab.windowId, background,
        }});

        await startNetworkCapture(tab.id!);
        // The connection is already live at this point; a session-storage failure only
        // costs state across a service-worker restart and must not fail the command.
        await persistState().catch(() => {});
        handleCommand({ type: "capture_page", id: "auto-connect" }).catch(() => {});
        setDynamicIcon("active", tab.id!);

        const domainResult = tabDomainState.get(tab.id!) ?? null;
        return { type: "response", id, success: true, data: {
          action: "connect_tab", tabId: tab.id, url: tab.url, title: tab.title,
          windowId: tab.windowId, capturing: true, domainState: domainResult,
        }};
      }

      case "disconnect_tab": {
        const data = await chrome.storage.session.get("crawlio:connectedTab");
        const conn = data["crawlio:connectedTab"];
        const detachTabId = (conn?.tabId && debuggerAttachedTabId === conn.tabId) ? conn.tabId : null;
        if (detachTabId !== null) {
          try { await chrome.debugger.detach({ tabId: detachTabId }); } catch { /* may already be detached */ }
          // Explicit cleanup — onDetach may not fire since we clear debuggerAttachedTabId
          attachedTabs.delete(detachTabId);
          frameTrees.delete(detachTabId);
          frameContexts.delete(detachTabId);
          dialogCounts.delete(detachTabId);
          interceptRules.delete(detachTabId);
          tabDomainState.delete(detachTabId);
        }
        stopIdleReleaseAlarm();
        chrome.storage.session.remove(IDLE_RELEASE_KEY);
        debuggerAttachedTabId = null;
        activeFrameId = null;
        stealthScriptId = null;
        frameworkHookScriptId = null;
        currentSecurityState = null;
        connectionStartTime = null;
        lastCommandTime = null;
        networkCapturing = false;
        cssCoverageActive = false;
        jsCoverageActive = false;
        consoleLogs = [];
        mainDocResponseHeaders = {};
        networkEntries.clear();
        wsConnections.clear();
        swRegistrations.clear();
        targetSessions.clear();
        browserContexts.clear();
        pendingDialog = null;
        pendingFileChooser = null;
        if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
        await chrome.storage.session.remove("crawlio:connectedTab");
        try { await clearAll(); } catch { /* IDB clear failed, logged */ }
        writeStatus({ capturing: false, activeTabId: null });
        persistState().catch(() => {});
        if (!shouldStayAlive()) stopKeepalive();
        resetIcon();
        // Auto-stop recording on disconnect
        if (activeRecording) {
          autoStopRecording("tab_disconnected");
        }
        return { type: "response", id, success: true, data: { action: "disconnect_tab", disconnected: true }};
      }

      case "list_tabs": {
        await ensureTabPermission(type);
        const allTabs = await chrome.tabs.query({});
        const connData = await chrome.storage.session.get("crawlio:connectedTab");
        const connectedTabId = connData["crawlio:connectedTab"]?.tabId ?? null;
        const tabs = allTabs
          .filter(t => t.url?.startsWith("http"))
          .map(t => ({
            tabId: t.id, url: t.url, title: t.title,
            windowId: t.windowId, active: t.active,
            connected: t.id === connectedTabId,
          }));
        return { type: "response", id, success: true, data: { tabs, connectedTabId }};
      }

      case "get_user_tabs": {
        await ensureTabPermission(type);
        const allTabs = await chrome.tabs.query({});
        const connData = await chrome.storage.session.get("crawlio:connectedTab");
        const connectedTabId = connData["crawlio:connectedTab"]?.tabId ?? null;
        const tabs = allTabs
          .map(t => ({
            tabId: t.id, url: t.url, title: t.title,
            windowId: t.windowId, active: t.active,
            groupId: typeof t.groupId === "number" && t.groupId >= 0 ? t.groupId : undefined,
            lastAccessed: t.lastAccessed,
            connected: t.id === connectedTabId,
          }))
          .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
          .slice(0, 1000);
        return { type: "response", id, success: true, data: { tabs, count: tabs.length, connectedTabId } };
      }

      case "get_user_history": {
        await ensureOptionalPermission(type, "history");
        const text = typeof command.query === "string" ? command.query : "";
        const limit = Math.max(1, Math.min(typeof command.limit === "number" ? command.limit : 100, 1000));
        const parseTime = (v: unknown): number | undefined => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; }
          return undefined;
        };
        const startTime = parseTime(command.from) ?? 0; // 0 = full history (capped by maxResults)
        const endTime = parseTime(command.to);
        const items = await chrome.history.search({
          text, maxResults: limit, startTime,
          ...(endTime !== undefined ? { endTime } : {}),
        });
        const history = items.map(h => ({
          url: h.url,
          title: h.title || undefined,
          lastVisitTime: typeof h.lastVisitTime === "number" ? new Date(h.lastVisitTime).toISOString() : undefined,
          visitCount: h.visitCount,
        }));
        return { type: "response", id, success: true, data: { history, count: history.length } };
      }

      case "get_downloads": {
        await ensureOptionalPermission(type, "downloads");
        wireDownloadListeners(); // in case the permission was just granted this session
        const limit = Math.max(1, Math.min(typeof command.limit === "number" ? command.limit : 50, DOWNLOAD_LIMIT));
        const downloads = Array.from(downloadsById.values())
          .map(d => ({
            id: d.id, url: d.url, filename: d.filename,
            status: downloadStatus(d.state, d.error),
            bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
            mime: d.mime, error: d.error, startTime: d.startTime, updatedAt: d.updatedAt,
          }))
          .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
          .slice(0, limit);
        return { type: "response", id, success: true, data: { downloads, count: downloads.length } };
      }

      case "get_connection_status": {
        const connData = await chrome.storage.session.get("crawlio:connectedTab");
        const statusData = await chrome.storage.session.get("crawlio:status");
        const conn = connData["crawlio:connectedTab"];
        const status = statusData["crawlio:status"] || {};
        const domainResult = debuggerAttachedTabId !== null ? tabDomainState.get(debuggerAttachedTabId) ?? null : null;
        const now = Date.now();
        return { type: "response", id, success: true, data: {
          connected: !!conn?.tabId,
          connectedTab: conn || null,
          mcpConnected: wsBridges.size > 0, // native is a token side-channel, not a transport
          capturing: networkCapturing,
          debuggerAttached: debuggerAttachedTabId !== null,
          debuggerTabId: debuggerAttachedTabId,
          lastCaptureAt: status.lastCaptureAt || null,
          domainState: domainResult,
          connectionAge: connectionStartTime !== null ? now - connectionStartTime : null,
          lastCommandAge: lastCommandTime !== null ? now - lastCommandTime : null,
          pendingCaptures: {
            network: networkCapturing,
            console: consoleLogs.length > 0,
          },
        }};
      }

      // Force reconnect — detach and reattach debugger, re-enable all CDP domains
      case "reconnect_tab": {
        await ensureTabPermission(type);
        const connData = await chrome.storage.session.get("crawlio:connectedTab");
        const conn = connData["crawlio:connectedTab"];
        if (!conn?.tabId) throw new Error("No tab connected — use connect_tab first");
        const tabId = conn.tabId;

        // Verify tab still exists
        try { await chrome.tabs.get(tabId); } catch { throw new Error(`Tab ${tabId} no longer exists`); }

        // Detach (ignore errors — may already be detached)
        try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
        attachedTabs.delete(tabId);
        debuggerAttachedTabId = null;
        connectionStartTime = null;
        lastCommandTime = null;
        // Clear per-tab Maps (stale from old session — clean old before new)
        frameTrees.delete(tabId);
        frameContexts.delete(tabId);
        dialogCounts.delete(tabId);
        interceptRules.delete(tabId);
        tabDomainState.delete(tabId);
        // Full state reset matching disconnect_tab
        activeFrameId = null;
        stealthScriptId = null;
        frameworkHookScriptId = null;
        currentSecurityState = null;
        networkCapturing = false;
        cssCoverageActive = false;
        jsCoverageActive = false;
        consoleLogs = [];
        mainDocResponseHeaders = {};
        networkEntries.clear();
        wsConnections.clear();
        swRegistrations.clear();
        targetSessions.clear();
        browserContexts.clear();
        pendingDialog = null;
        pendingFileChooser = null;
        if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }

        // Short delay before reattach
        await new Promise(r => setTimeout(r, 100));

        // Reattach + re-enable domains
        const domainResult = await ensureDebugger(tabId, true);

        // Inject stealth if enabled
        if (stealthEnabled && stealthScriptId === null) {
          try {
            const scriptResult = await sendCDPCommand<{ identifier: string }>(
              { tabId }, "Page.addScriptToEvaluateOnNewDocument",
              { source: STEALTH_SCRIPT }, 0
            );
            stealthScriptId = scriptResult.identifier;
            await sendCDPCommand({ tabId }, "Runtime.evaluate",
              { expression: STEALTH_SCRIPT, returnByValue: true }, 0);
          } catch { /* stealth injection non-fatal — page still usable */ }
        }

        // Re-inject framework hooks on reconnect
        if (!frameworkHookScriptId) {
          try {
            const hookResult = await sendCDPCommand<{ identifier: string }>(
              { tabId }, "Page.addScriptToEvaluateOnNewDocument",
              { source: FRAMEWORK_HOOK_SCRIPT }, 0
            );
            frameworkHookScriptId = hookResult.identifier;
          } catch { /* hook registration non-fatal */ }
        }
        try {
          await sendCDPCommand({ tabId }, "Runtime.evaluate",
            { expression: FRAMEWORK_HOOK_SCRIPT, returnByValue: true }, 0, 3000);
        } catch { /* hook evaluation non-fatal — detection still works via globals */ }

        const tab = await chrome.tabs.get(tabId);
        return { type: "response", id, success: true, data: {
          action: "reconnect_tab",
          tabId,
          url: tab.url,
          title: tab.title,
          domainState: domainResult,
          connectionAge: connectionStartTime !== null ? Date.now() - connectionStartTime : 0,
        }};
      }

      // Tool capabilities based on current CDP connection state
      case "get_capabilities": {
        const connData = await chrome.storage.session.get("crawlio:connectedTab");
        const conn = connData["crawlio:connectedTab"];
        const isConnected = !!conn?.tabId && debuggerAttachedTabId !== null;
        const domainResult = isConnected ? tabDomainState.get(debuggerAttachedTabId!) ?? null : null;

        // Build domain lookup for quick checks
        const enabledDomains = new Set<string>();
        if (domainResult) {
          for (const d of domainResult.required) { if (d.success) enabledDomains.add(d.domain.replace(".enable", "")); }
          for (const d of domainResult.optional) { if (d.success) enabledDomains.add(d.domain.replace(".enable", "")); }
        }
        // Network capture enables additional domains
        if (networkCapturing) {
          enabledDomains.add("Network");
          enabledDomains.add("Log");
        }

        type ToolStatus = "available" | "fallback" | "unavailable";
        const tools: { name: string; status: ToolStatus; note?: string }[] = [];

        const addTool = (name: string, status: ToolStatus, note?: string) => {
          tools.push(note ? { name, status, note } : { name, status });
        };

        if (!isConnected) {
          // Connection/tab management tools always available
          const alwaysAvailable = ["connect_tab", "list_tabs", "get_connection_status", "get_capabilities",
            "agent_session_create", "agent_session_list", "agent_session_status", "agent_session_close",
            "agent_session_snapshot", "agent_session_action", "agent_session_batch", "agent_session_artifacts",
            "agent_session_create_tab", "agent_session_claim_tab", "agent_session_name", "agent_session_finalize",
            "get_user_tabs", "get_user_history", "get_downloads",
            "extract_site", "get_crawl_status", "get_enrichment", "get_crawled_urls", "enrich_url"];
          for (const name of alwaysAvailable) addTool(name, "available");
          // Everything else unavailable
          const cdpTools = ["disconnect_tab", "capture_page", "detect_framework", "start_network_capture",
            "stop_network_capture", "get_console_logs", "get_cookies", "get_dom_snapshot", "take_screenshot",
            "browser_navigate", "browser_click", "browser_type", "browser_press_key", "browser_hover",
            "browser_select_option", "browser_wait", "browser_wait_for", "browser_intercept",
            "get_frame_tree", "switch_to_frame", "switch_to_main_frame", "create_tab", "close_tab",
            "switch_tab", "set_cookie", "delete_cookies", "get_storage", "set_storage", "clear_storage",
            "get_dialog", "handle_dialog", "get_response_body", "set_viewport", "set_user_agent",
            "emulate_device", "print_to_pdf", "browser_scroll", "browser_double_click", "browser_drag",
            "browser_file_upload", "set_geolocation", "get_accessibility_tree", "get_performance_metrics",
            "get_websocket_connections", "get_websocket_messages", "set_stealth_mode", "emulate_network",
            "set_cache_disabled", "set_extra_headers", "get_security_state", "ignore_certificate_errors",
            "list_service_workers", "stop_service_worker", "bypass_service_worker", "set_outer_html",
            "set_attribute", "remove_attribute", "remove_node", "start_css_coverage", "stop_css_coverage",
            "get_computed_style", "force_pseudo_state", "start_js_coverage", "stop_js_coverage",
            "get_databases", "query_object_store", "clear_database", "get_targets", "attach_to_target",
            "create_browser_context", "get_dom_counters", "force_gc", "take_heap_snapshot",
            "highlight_element", "show_layout_shifts", "show_paint_rects", "reconnect_tab"];
          for (const name of cdpTools) addTool(name, "unavailable", "No tab connected");
        } else {
          // All connection/lifecycle tools
          addTool("connect_tab", "available");
          addTool("disconnect_tab", "available");
          addTool("reconnect_tab", "available");
          addTool("list_tabs", "available");
          addTool("get_connection_status", "available");
          addTool("get_capabilities", "available");
          for (const name of ["agent_session_create", "agent_session_list", "agent_session_status", "agent_session_close",
            "agent_session_snapshot", "agent_session_action", "agent_session_batch", "agent_session_artifacts"]) {
            addTool(name, "available", "Uses agent-owned tabs and semantic DOM actions without foreground activation");
          }
          for (const name of ["agent_session_create_tab", "agent_session_claim_tab", "agent_session_name", "agent_session_finalize"]) {
            addTool(name, "available", "Session tab-fleet management (spawn + CDP-drive background tabs via tabs+debugger); the Chrome tab-group chip is best-effort when the optional tabGroups permission is granted");
          }

          // Page/Runtime required — most tools depend on these
          const hasPage = enabledDomains.has("Page");
          const hasRuntime = enabledDomains.has("Runtime");
          const baseAvailable = hasPage && hasRuntime;

          // Core tools (need Page+Runtime)
          const coreTools = ["capture_page", "detect_framework", "get_dom_snapshot", "take_screenshot",
            "browser_navigate", "browser_click", "browser_type", "browser_press_key", "browser_hover",
            "browser_select_option", "browser_wait", "browser_wait_for", "browser_scroll",
            "browser_double_click", "browser_drag", "browser_file_upload", "set_geolocation",
            "get_accessibility_tree", "set_stealth_mode", "set_viewport", "set_user_agent",
            "emulate_device", "print_to_pdf", "set_outer_html", "set_attribute", "remove_attribute",
            "remove_node", "get_computed_style", "force_pseudo_state", "get_frame_tree",
            "switch_to_frame", "switch_to_main_frame", "get_dialog", "handle_dialog",
            "highlight_element", "show_layout_shifts", "show_paint_rects",
            "get_dom_counters", "force_gc", "take_heap_snapshot",
            "get_targets", "attach_to_target", "create_browser_context"];
          for (const name of coreTools) {
            addTool(name, baseAvailable ? "available" : "unavailable", baseAvailable ? undefined : "Page/Runtime domains not enabled");
          }

          // Tab management (no CDP needed)
          addTool("create_tab", "available");
          addTool("close_tab", "available");
          addTool("switch_tab", "available");

          // Network tools (need network capture active)
          const networkTools = ["start_network_capture", "stop_network_capture", "get_console_logs",
            "browser_intercept", "get_response_body", "emulate_network", "set_cache_disabled",
            "set_extra_headers", "get_websocket_connections", "get_websocket_messages",
            "get_security_state", "ignore_certificate_errors", "list_service_workers",
            "stop_service_worker", "bypass_service_worker"];
          for (const name of networkTools) addTool(name, baseAvailable ? "available" : "unavailable",
            baseAvailable ? undefined : "Page/Runtime domains not enabled");

          // Cookie tools — get_cookies has document.cookie fallback, set/delete require Network domain
          const hasNetwork = enabledDomains.has("Network");
          addTool("get_cookies", baseAvailable ? (hasNetwork ? "available" : "fallback") : "unavailable",
            !baseAvailable ? "Not connected" : !hasNetwork ? "Using document.cookie fallback (httpOnly cookies not visible)" : undefined);
          addTool("set_cookie", baseAvailable ? (hasNetwork ? "available" : "unavailable") : "unavailable",
            !baseAvailable ? "Not connected" : !hasNetwork ? "Requires Network domain — use start_network_capture first" : undefined);
          addTool("delete_cookies", baseAvailable ? (hasNetwork ? "available" : "unavailable") : "unavailable",
            !baseAvailable ? "Not connected" : !hasNetwork ? "Requires Network domain — use start_network_capture first" : undefined);

          // Storage tools (need DOMStorage, fallback to Runtime.evaluate)
          const hasDOMStorage = enabledDomains.has("DOMStorage");
          addTool("get_storage", baseAvailable ? (hasDOMStorage ? "available" : "fallback") : "unavailable",
            !baseAvailable ? "Not connected" : !hasDOMStorage ? "Using Runtime.evaluate fallback (DOMStorage not enabled)" : undefined);
          addTool("set_storage", baseAvailable ? (hasDOMStorage ? "available" : "unavailable") : "unavailable",
            !baseAvailable ? "Not connected" : !hasDOMStorage ? "DOMStorage domain not enabled — no fallback for writes" : undefined);
          addTool("clear_storage", baseAvailable ? (hasDOMStorage ? "available" : "unavailable") : "unavailable",
            !baseAvailable ? "Not connected" : !hasDOMStorage ? "DOMStorage domain not enabled — no fallback for clears" : undefined);

          // Performance (optional domain)
          const hasPerformance = enabledDomains.has("Performance");
          addTool("get_performance_metrics", baseAvailable ? (hasPerformance ? "available" : "fallback") : "unavailable",
            !baseAvailable ? "Not connected" : !hasPerformance ? "CDP Performance metrics unavailable, Web Vitals only" : undefined);

          // Coverage tools
          addTool("start_css_coverage", baseAvailable ? "available" : "unavailable");
          addTool("stop_css_coverage", baseAvailable ? "available" : "unavailable");
          addTool("start_js_coverage", baseAvailable ? "available" : "unavailable");
          addTool("stop_js_coverage", baseAvailable ? "available" : "unavailable");

          // IndexedDB tools
          addTool("get_databases", baseAvailable ? "available" : "unavailable");
          addTool("query_object_store", baseAvailable ? "available" : "unavailable");
          addTool("clear_database", baseAvailable ? "available" : "unavailable");

          // Crawlio server tools (always available)
          const crawlioTools = ["extract_site", "get_crawl_status", "get_enrichment", "get_crawled_urls", "enrich_url"];
          for (const name of crawlioTools) addTool(name, "available");
        }

        return { type: "response", id, success: true, data: {
          connected: isConnected,
          tools,
        }};
      }

      case "agent_session_create": {
        await ensureTabPermission(type);
        const data = await createAgentSession(command);
        return { type: "response", id, success: true, data };
      }

      case "agent_session_list": {
        await hydrateAgentSessions();
        const includeClosed = command.includeClosed === true;
        const sessions = await Promise.all(Array.from(agentSessions.values()).map(session => refreshAgentSession(session)));
        await persistAgentSessions();
        return {
          type: "response", id, success: true,
          data: {
            sessions: sessions
              .filter(session => includeClosed || session.status !== "closed")
              .map(session => sessionPublicView(session)),
            count: sessions.filter(session => includeClosed || session.status !== "closed").length,
          },
        };
      }

      case "agent_session_status": {
        const session = await getAgentSession(String(command.sessionId), false);
        const includePage = command.includePage === true && session.status !== "closed";
        return {
          type: "response", id, success: true,
          data: {
            session: sessionPublicView(session, command.includeArtifacts === true, command.includeData === true),
            ...(includePage ? { page: await getAgentPageSummary(session.tabId) } : {}),
          },
        };
      }

      case "agent_session_close": {
        const session = await getAgentSession(String(command.sessionId), false);
        const closeTab = command.closeTab !== false;
        let tabClosed = false;
        if (closeTab && session.status !== "closed") {
          try {
            await chrome.tabs.remove(session.tabId);
            tabClosed = true;
          } catch (err) {
            session.lastError = err instanceof Error ? err.message : String(err);
          }
        }
        session.status = "closed";
        session.updatedAt = new Date().toISOString();
        await persistAgentSessions();
        if (!shouldStayAlive()) stopKeepalive();
        maybeApplyPendingUpdate();
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), tabClosed } };
      }

      case "agent_session_snapshot": {
        const session = await getAgentSession(String(command.sessionId));
        if (await checkSiteOptOut(session.tabId)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const data = await captureAgentSessionSnapshot(session, command);
        return { type: "response", id, success: true, data };
      }

      case "agent_session_action": {
        const session = await getAgentSession(String(command.sessionId));
        if (await checkSiteOptOut(session.tabId)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const payload = {
          ...(typeof command.target === "object" && command.target !== null ? command.target as Record<string, unknown> : {}),
          ...command,
        } as AgentActionPayload;
        const data = await runAgentSessionAction(session, payload);
        return { type: "response", id, success: true, data };
      }

      case "agent_session_batch": {
        const session = await getAgentSession(String(command.sessionId));
        if (await checkSiteOptOut(session.tabId)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const actions = Array.isArray(command.actions) ? command.actions as AgentActionPayload[] : [];
        if (actions.length === 0) throw new Error("actions array is required");
        const continueOnError = command.continueOnError === true;
        const results: Array<Record<string, unknown>> = [];
        for (let index = 0; index < actions.length; index++) {
          try {
            results.push({ index, ...(await runAgentSessionAction(session, actions[index])) });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            results.push({ index, ok: false, error });
            if (!continueOnError) {
              return { type: "response", id, success: false, error, data: { session: sessionPublicView(session), results } };
            }
          }
        }
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), results } };
      }

      case "agent_session_artifacts": {
        const session = await getAgentSession(String(command.sessionId), false);
        const kind = typeof command.kind === "string" ? command.kind : undefined;
        const limit = Math.max(1, Math.min(typeof command.limit === "number" ? command.limit : 20, AGENT_SESSION_ARTIFACT_LIMIT));
        const artifacts = session.artifacts
          .filter(artifact => !kind || artifact.kind === kind)
          .slice(-limit)
          .map(artifact => artifactPublicView(artifact, command.includeData === true));
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), artifacts, count: artifacts.length } };
      }

      case "agent_session_create_tab": {
        await ensureTabPermission(type);
        const session = await getAgentSession(String(command.sessionId));
        const rawUrl = typeof command.url === "string" && command.url ? command.url : "about:blank";
        const tab = await chrome.tabs.create({ url: rawUrl, active: command.active === true, windowId: session.windowId });
        if (!tab.id) throw new Error("Chrome did not return a tab id");
        if (rawUrl.startsWith("http")) {
          await waitForAgentTabLoad(tab.id);
          await ensureDebugger(tab.id); // background session tab — never the foreground primary
        }
        // Ensure the session's original tab is in the group too, then add the new one.
        await addTabToSessionGroup(session.id, session.tabId, "agent", session.name ?? SESSION_GROUP_DEFAULT_TITLE);
        const group = await addTabToSessionGroup(session.id, tab.id, "agent", session.name ?? SESSION_GROUP_DEFAULT_TITLE);
        if (group.groupId >= 0) session.groupId = group.groupId;
        session.updatedAt = new Date().toISOString();
        await persistAgentSessions();
        startKeepalive();
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), tabId: tab.id, group } };
      }

      case "agent_session_claim_tab": {
        await ensureTabPermission(type);
        const session = await getAgentSession(String(command.sessionId));
        const claimTabId = command.tabId;
        if (typeof claimTabId !== "number" || !Number.isInteger(claimTabId) || claimTabId <= 0) {
          throw new Error("tabId must be a positive integer");
        }
        const tab = await chrome.tabs.get(claimTabId);
        if (!tab.url?.startsWith("http")) throw new Error(`Tab ${claimTabId} is not HTTP/HTTPS: ${tab.url}`);
        await addTabToSessionGroup(session.id, session.tabId, "agent", session.name ?? SESSION_GROUP_DEFAULT_TITLE);
        const group = await claimTabIntoSession(session.id, claimTabId);
        if (group.groupId >= 0) session.groupId = group.groupId;
        session.updatedAt = new Date().toISOString();
        await persistAgentSessions();
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), tabId: claimTabId, group } };
      }

      case "agent_session_name": {
        await ensureTabPermission(type);
        const session = await getAgentSession(String(command.sessionId), false);
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name) throw new Error("name is required");
        session.name = name;
        // Group the session's primary tab so the rename has a target group.
        await addTabToSessionGroup(session.id, session.tabId, "agent", name);
        const group = await renameSessionGroup(session.id, name);
        if (group && group.groupId >= 0) session.groupId = group.groupId;
        session.updatedAt = new Date().toISOString();
        await persistAgentSessions();
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), group } };
      }

      case "agent_session_finalize": {
        await ensureTabPermission(type);
        const session = await getAgentSession(String(command.sessionId), false);
        const keepRaw: unknown[] = Array.isArray(command.keep) ? command.keep : [];
        const keep = keepRaw.map((entry: unknown) => {
          const k = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
          return { tabId: Number(k.tabId), status: String(k.status) as FinalizeStatus };
        });
        const result = await finalizeSession(session.id, keep);
        session.groupId = undefined;
        session.status = "closed";
        session.updatedAt = new Date().toISOString();
        await persistAgentSessions();
        if (!shouldStayAlive()) stopKeepalive();
        maybeApplyPendingUpdate();
        return { type: "response", id, success: true, data: { session: sessionPublicView(session), result } };
      }

      case "get_active_tab": {
        const tab = await getConnectedTab();
        return {
          type: "response", id, success: true,
          data: { url: tab.url, title: tab.title, tabId: tab.id },
        };
      }

      case "detect_framework": {
        const tab = await getConnectedTab();
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        await CDP_YIELD();
        const result = await cdpExecuteFunction<FrameworkDetection>(tab.id!, detectFrameworkInPage, [mainDocResponseHeaders]);
        if (result && result.framework !== "Unknown" && tab.url) {
          dispatchFrameworkTelemetry(tab.url, result);
        }
        return { type: "response", id, success: true, data: result };
      }

      case "get_dom_snapshot": {
        const tab = await getConnectedTab();
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const maxDepth = command.maxDepth ?? 10;
        // Wait for page load before snapshot
        try {
          await ensureDebugger(tab.id!);
          await waitForPageLoad(tab.id!);
        } catch { /* proceed without wait */ }
        const result = await cdpExecuteFunction<any>(tab.id!, captureDOMSnapshot, [maxDepth]);
        return { type: "response", id, success: true, data: result };
      }

      case "start_network_capture": {
        const tab = await getConnectedTab();
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        await startNetworkCapture(tab.id!);
        return { type: "response", id, success: true, data: "started" };
      }

      case "stop_network_capture": {
        const entries = await stopNetworkCapture();
        return { type: "response", id, success: true, data: entries };
      }

      // AC-16: WebSocket monitoring — list connections
      case "get_websocket_connections": {
        await requireDebuggerTab();
        const statusFilter = command.status as string | undefined;
        const connections = Array.from(wsConnections.values())
          .filter(ws => !statusFilter || ws.status === statusFilter)
          .map(ws => ({
            requestId: ws.requestId,
            url: ws.url,
            status: ws.status,
            initiator: ws.initiator,
            messageCount: ws.messages.length,
            createdAt: ws.createdAt,
            closedAt: ws.closedAt,
            errorMessage: ws.errorMessage,
          }));
        return { type: "response", id, success: true, data: { connections }};
      }

      // AC-16: WebSocket monitoring — get messages
      case "get_websocket_messages": {
        await requireDebuggerTab();
        const limit = (command.limit as number) ?? 50;
        let messages: Array<WebSocketMessage & { requestId?: string; url?: string }> = [];

        if (command.requestId) {
          const ws = wsConnections.get(command.requestId as string);
          if (!ws) {
            return { type: "response", id, success: false, data: { error: `WebSocket not found: ${command.requestId}` }};
          }
          messages = ws.messages.map(m => ({ ...m }));
        } else {
          // All connections — merge and sort by timestamp
          for (const ws of wsConnections.values()) {
            for (const m of ws.messages) {
              messages.push({ ...m, requestId: ws.requestId, url: ws.url });
            }
          }
          messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }

        const directionFilter = command.direction as string | undefined;
        if (directionFilter) messages = messages.filter(m => m.direction === directionFilter);
        const total = messages.length;
        messages = messages.slice(-limit);

        return { type: "response", id, success: true, data: { messages, total, returned: messages.length }};
      }

      // 3 error paths: not found, evicted (0xc8 flag), no data
      case "get_response_body": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        let targetRequestId = command.requestId as string | undefined;

        // If no requestId, find by URL using existing networkEntries map
        if (!targetRequestId && command.url) {
          for (const [reqId, entry] of networkEntries) {
            if (entry.url === command.url) { targetRequestId = reqId; break; }
          }
        }

        if (!targetRequestId) {
          return { type: "response", id, success: false, data: { error: "No matching request found. Ensure network capture is active and the request was made during this session." }};
        }

        try {
          const result = await sendCDPCommand<{ body: string; base64Encoded: boolean }>({ tabId: tab.id! }, "Network.getResponseBody", {
            requestId: targetRequestId,
          });

          const MAX_BODY_SIZE = 50000; // 50KB cap for token efficiency
          let body = result.body;
          let truncated = false;

          if (!result.base64Encoded && body.length > MAX_BODY_SIZE) {
            body = body.substring(0, MAX_BODY_SIZE);
            truncated = true;
          }

          // Find mimeType for content-type aware response
          let mimeType: string | undefined;
          for (const entry of networkEntries.values()) {
            if (entry.requestId === targetRequestId) { mimeType = entry.mimeType; break; }
          }

          return { type: "response", id, success: true, data: {
            body,
            base64Encoded: result.base64Encoded,
            truncated,
            originalSize: result.body.length,
            mimeType,
          }};
        } catch (e) {
          return { type: "response", id, success: false, data: { error: `Failed to get response body: ${e}` }};
        }
      }

      case "replay_request": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        const targetUrl = command.url as string | undefined;
        if (!targetUrl) {
          return { type: "response", id, success: false, error: "url is required" };
        }

        // Block dangerous URL schemes (SSRF defense-in-depth)
        const BLOCKED_SCHEMES = /^(file|chrome|chrome-extension|about|data|javascript):/i;
        if (BLOCKED_SCHEMES.test(targetUrl)) {
          return { type: "response", id, success: false, error: `Blocked URL scheme. Only http: and https: URLs are allowed.` };
        }

        // Find the captured request by URL
        let captured: NetworkMapEntry | null = null;
        for (const entry of networkEntries.values()) {
          if (entry.url === targetUrl) { captured = entry; break; }
        }

        const method = (command.method as string) || captured?.method || "GET";
        const originalHeaders = captured?.requestHeaders || {};
        const overrideHeaders = (command.headers as Record<string, string>) || {};
        const mergedHeaders = { ...originalHeaders, ...overrideHeaders };
        const body = (command.body as string) ?? captured?.requestBody ?? undefined;
        const followRedirects = command.followRedirects !== false;

        // Build the fetch expression to run in page context
        const fetchOpts: Record<string, unknown> = {
          method,
          headers: mergedHeaders,
          redirect: followRedirects ? "follow" : "manual",
          credentials: "include",
        };
        if (body && method !== "GET" && method !== "HEAD") {
          fetchOpts.body = body;
        }

        const expression = `(async () => {
          const start = performance.now();
          try {
            const resp = await fetch(${JSON.stringify(targetUrl)}, ${JSON.stringify(fetchOpts)});
            const text = await resp.text();
            return JSON.stringify({
              status: resp.status,
              statusText: resp.statusText,
              headers: Object.fromEntries(resp.headers.entries()),
              body: text.substring(0, 10000),
              bodyTruncated: text.length > 10000,
              duration: Math.round(performance.now() - start),
            });
          } catch (e) {
            return JSON.stringify({ error: e.message || String(e) });
          }
        })()`;

        try {
          const result = await sendCDPCommand<{ result: { type: string; value?: string } }>({ tabId: tab.id! }, "Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          const val = result.result?.value;
          if (!val) {
            return { type: "response", id, success: false, error: "No response from page context" };
          }
          const parsed = JSON.parse(val);
          if (parsed.error) {
            return { type: "response", id, success: false, error: `Fetch failed: ${parsed.error}` };
          }
          return { type: "response", id, success: true, data: parsed };
        } catch (e) {
          return { type: "response", id, success: false, error: `replay_request failed: ${e}` };
        }
      }

      case "get_console_logs": {
        if (debuggerAttachedTabId && await checkSiteOptOut(debuggerAttachedTabId)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        // Prefer in-memory (live capture), fall back to IDB, then session storage
        let logs = [...consoleLogs];
        if (logs.length === 0) {
          try {
            logs = await getConsoleLogs();
          } catch { /* IDB read failed — fall back to session storage */
            const stored = await chrome.storage.session.get("crawlio:console");
            logs = stored["crawlio:console"] || [];
          }
        }
        consoleLogs = [];
        return { type: "response", id, success: true, data: logs };
      }

      // Our improvement: fallback to document.cookie via Runtime.evaluate
      case "get_cookies": {
        const tab = await getConnectedTab();
        if (!tab.url || !tab.url.startsWith("http")) {
          return { type: "response", id, success: true, data: [] };
        }
        await ensureDebugger(tab.id!);
        let cookies: CookieEntry[] = [];
        let cookieFetchFailed = false;
        try {
          cookies = await captureCookies(tab.id!, tab.url);
        } catch (e) {
          cookieFetchFailed = true;
          if (__DEV__) console.warn("[Crawlio] Network.getCookies failed, falling back to document.cookie:", e);
        }
        if (cookieFetchFailed) {
          try {
            const evalResult = await sendCDPCommand<{ result: { value: string } }>(
              { tabId: tab.id! },
              "Runtime.evaluate",
              buildEvalParams(tab.id!, "document.cookie")
            );
            const cookieStr = evalResult?.result?.value;
            if (cookieStr) {
              cookies = cookieStr.split(";").filter((s: string) => s.trim()).map((pair: string) => {
                const eqIdx = pair.indexOf("=");
                const name = eqIdx >= 0 ? pair.slice(0, eqIdx).trim() : pair.trim();
                const value = eqIdx >= 0 ? pair.slice(eqIdx + 1).trim() : "";
                return {
                  name,
                  value: isSensitiveCookie(name) ? "[REDACTED]" : value,
                  domain: new URL(tab.url!).hostname,
                  path: "/",
                  expires: -1,
                  httpOnly: false, // document.cookie cannot see httpOnly cookies
                  secure: false,
                  sameSite: "Lax" as const,
                  size: name.length + value.length,
                };
              });
            }
          } catch (fallbackErr) {
            if (__DEV__) console.warn("[Crawlio] document.cookie fallback also failed:", fallbackErr);
          }
        }
        const sanitizedCookies = cookies.map(c => ({
          ...c,
          value: sanitizeValue(c.value) as string,
        }));
        return { type: "response", id, success: true, data: { cookies: sanitizedCookies, fallbackUsed: cookieFetchFailed } };
      }

      case "set_cookie": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const cookieParams: Record<string, unknown> = {
          name: command.name,
          value: command.value,
          domain: command.domain,
          path: command.path ?? "/",
        };
        if (command.secure !== undefined) cookieParams.secure = command.secure;
        if (command.httpOnly !== undefined) cookieParams.httpOnly = command.httpOnly;
        if (command.sameSite) {
          cookieParams.sameSite = command.sameSite;
          if (command.sameSite === "None") cookieParams.secure = true;
        }
        if (command.expires) cookieParams.expires = command.expires;

        const result = await sendCDPCommand<{ success: boolean }>(
          { tabId: tab.id! },
          "Network.setCookie",
          cookieParams
        );
        return { type: "response", id, success: result?.success !== false };
      }

      case "delete_cookies": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const deleteParams: Record<string, unknown> = { name: command.name };
        if (command.domain) deleteParams.domain = command.domain;
        if (command.path) deleteParams.path = command.path;

        await sendCDPCommand(
          { tabId: tab.id! },
          "Network.deleteCookies",
          deleteParams
        );
        return { type: "response", id, success: true, data: { deleted: true } };
      }

      case "export_session_raw": {
        // Raw UNREDACTED cookie export (incl. httpOnly session cookies) for session capture
        // to ~/.crawlio/<domain>-session.json.
        //
        // SECURITY: this returns cookies in the clear, so it MUST be scoped to
        // the site the operator is actually connected to — the visible debugger banner on
        // that tab is the consent. Previously a caller-supplied `domain` overrode the scope
        // AND a missing tab.url fell back to ALL cookies, so a hijacked/TOFU bridge could
        // "connect to tab A, export bank.com's httpOnly cookies". Now: require an http(s)
        // connected tab, and honor a caller `domain` ONLY when it is the SAME registrable
        // site as that tab. No all-domains path remains.
        const tab = await getConnectedTab();
        if (!tab.url || !/^https?:/i.test(tab.url)) {
          throw new Error("export_session_raw requires an http(s) connected tab");
        }
        await ensureDebugger(tab.id!);

        const tabHost = new URL(tab.url).hostname.replace(/^www\./, "");
        const requested = typeof (command as any).domain === "string"
          ? (command as any).domain.replace(/^www\./, "")
          : undefined;
        // same-site iff equal or one is a dot-suffix of the other (app.example.com ~ example.com)
        const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
        if (requested && !sameSite(requested, tabHost)) {
          throw new Error(`export_session_raw is scoped to the connected site "${tabHost}"; refusing cross-site domain "${requested}"`);
        }
        const filterDomain = requested ?? tabHost;

        const result = await sendCDPCommand<{ cookies: any[] }>(
          { tabId: tab.id! },
          "Network.getAllCookies",
          {}
        );

        const cookies = (result?.cookies ?? []).filter((c: any) =>
          c.domain === filterDomain ||
          c.domain === `.${filterDomain}` ||
          c.domain.endsWith(`.${filterDomain}`)
        );

        return { type: "response", id, success: true, data: { cookies, count: cookies.length, domain: filterDomain } };
      }

      // Our improvement: fallback to Runtime.evaluate when DOMStorage.enable failed
      case "get_storage": {
        const tab = await getConnectedTab();
        if (!tab.url || !tab.url.startsWith("http")) {
          return { type: "response", id, success: true, data: { items: {}, count: 0 } };
        }
        await ensureDebugger(tab.id!);
        const storageType = command.storageType ?? "local";
        let entries: [string, string][] = [];
        let fallbackUsed = false;

        // Check if DOMStorage domain enabled successfully
        const domainState = tabDomainState.get(tab.id!);
        const domStorageOk = domainState?.optional.some(d => d.domain === "DOMStorage.enable" && d.success) ?? false;

        if (domStorageOk) {
          try {
            const storageId = getStorageId(tab.url, storageType);
            const result = await sendCDPCommand<{ entries: [string, string][] }>(
              { tabId: tab.id! },
              "DOMStorage.getDOMStorageItems",
              { storageId }
            );
            entries = result?.entries ?? [];
          } catch (e) {
            if (__DEV__) console.warn("[Crawlio] DOMStorage.getDOMStorageItems failed, falling back:", e);
            fallbackUsed = true;
          }
        } else {
          fallbackUsed = true;
        }

        // Fallback: Runtime.evaluate with localStorage/sessionStorage API
        if (fallbackUsed) {
          try {
            const jsApi = storageType === "local" ? "localStorage" : "sessionStorage";
            const evalResult = await sendCDPCommand<{ result: { value: string } }>(
              { tabId: tab.id! },
              "Runtime.evaluate",
              buildEvalParams(tab.id!, `JSON.stringify(Object.fromEntries(Object.keys(${jsApi}).map(k => [k, ${jsApi}.getItem(k)])))`)
            );
            if (evalResult?.result?.value) {
              const parsed = JSON.parse(evalResult.result.value) as Record<string, string>;
              entries = Object.entries(parsed);
            }
          } catch (fallbackErr) {
            if (__DEV__) console.warn("[Crawlio] Runtime.evaluate storage fallback also failed:", fallbackErr);
          }
        }

        if (command.key) {
          const found = entries.find(([k]: [string, string]) => k === command.key);
          return { type: "response", id, success: true, data: { key: command.key, value: found ? found[1] : null } };
        }
        const items: Record<string, string> = {};
        for (const [k, v] of entries) items[k] = v;
        return { type: "response", id, success: true, data: { items, count: entries.length } };
      }

      case "set_storage": {
        const tab = await getConnectedTab();
        if (!tab.url || !tab.url.startsWith("http")) {
          throw new Error("Cannot access storage on non-HTTP pages");
        }
        await ensureDebugger(tab.id!);
        const storageType = command.storageType ?? "local";

        const domainState = tabDomainState.get(tab.id!);
        const domStorageOk = domainState?.optional.some(d => d.domain === "DOMStorage.enable" && d.success) ?? false;

        if (domStorageOk) {
          try {
            const storageId = getStorageId(tab.url, storageType);
            await sendCDPCommand(
              { tabId: tab.id! },
              "DOMStorage.setDOMStorageItem",
              { storageId, key: command.key, value: command.value }
            );
            return { type: "response", id, success: true, data: { stored: true } };
          } catch (e) {
            if (__DEV__) console.warn("[Crawlio] DOMStorage.setDOMStorageItem failed, falling back:", e);
          }
        }

        // Fallback: Runtime.evaluate with localStorage/sessionStorage API
        const jsApi = storageType === "local" ? "localStorage" : "sessionStorage";
        await sendCDPCommand(
          { tabId: tab.id! },
          "Runtime.evaluate",
          buildEvalParams(tab.id!, `${jsApi}.setItem(${JSON.stringify(command.key)}, ${JSON.stringify(command.value)})`)
        );
        return { type: "response", id, success: true, data: { stored: true, fallback: true } };
      }

      case "clear_storage": {
        const tab = await getConnectedTab();
        if (!tab.url || !tab.url.startsWith("http")) {
          throw new Error("Cannot access storage on non-HTTP pages");
        }
        await ensureDebugger(tab.id!);
        const storageType = command.storageType ?? "local";

        const domainState = tabDomainState.get(tab.id!);
        const domStorageOk = domainState?.optional.some(d => d.domain === "DOMStorage.enable" && d.success) ?? false;

        if (domStorageOk) {
          try {
            const storageId = getStorageId(tab.url, storageType);
            await sendCDPCommand(
              { tabId: tab.id! },
              "DOMStorage.clear",
              { storageId }
            );
            return { type: "response", id, success: true, data: { cleared: true } };
          } catch (e) {
            if (__DEV__) console.warn("[Crawlio] DOMStorage.clear failed, falling back:", e);
          }
        }

        // Fallback: Runtime.evaluate with localStorage/sessionStorage API
        const jsApi = storageType === "local" ? "localStorage" : "sessionStorage";
        await sendCDPCommand(
          { tabId: tab.id! },
          "Runtime.evaluate",
          buildEvalParams(tab.id!, `${jsApi}.clear()`)
        );
        return { type: "response", id, success: true, data: { cleared: true, fallback: true } };
      }

      // AC-23: IndexedDB operations
      case "get_databases": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const origin = command.origin ?? getSecurityOrigin(tab.url ?? "");

        try {
          const dbNames = await sendCDPCommand<{ databaseNames: string[] }>(
            { tabId: tab.id! },
            "IndexedDB.requestDatabaseNames",
            { securityOrigin: origin }
          );

          const databases = [];
          for (const name of dbNames?.databaseNames ?? []) {
            const dbInfo = await sendCDPCommand<{ databaseWithObjectStores: any }>(
              { tabId: tab.id! },
              "IndexedDB.requestDatabase",
              { securityOrigin: origin, databaseName: name }
            );
            const db = dbInfo?.databaseWithObjectStores;
            if (db) {
              databases.push({
                name: db.name,
                version: db.version,
                objectStores: (db.objectStores ?? []).map((os: any) => ({
                  name: os.name,
                  keyPath: os.keyPath?.string ?? os.keyPath?.array ?? "(auto)",
                  autoIncrement: os.autoIncrement,
                  indexCount: (os.indexes ?? []).length,
                })),
              });
            }
          }

          return { type: "response", id, success: true, data: { origin, databases } };
        } catch {
          // Fallback: indexedDB.databases() JS API (Chrome 71+)
          const evalResult = await sendCDPCommand<{ result: { value: string } }>(
            { tabId: tab.id! }, "Runtime.evaluate",
            buildEvalParams(tab.id!, `indexedDB.databases().then(dbs =>
              JSON.stringify(dbs.map(d => ({ name: d.name, version: d.version, objectStores: [] })))
            )`, { awaitPromise: true })
          );
          const databases = JSON.parse(evalResult?.result?.value ?? "[]");
          return { type: "response", id, success: true, data: { origin, databases, fallback: true } };
        }
      }

      case "query_object_store": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const origin = getSecurityOrigin(tab.url ?? "");
        const limit = Math.min(command.limit ?? 25, 100);
        const skip = command.skip ?? 0;

        try {
          const result = await sendCDPCommand<{ objectStoreDataEntries: any[]; hasMore: boolean }>(
            { tabId: tab.id! },
            "IndexedDB.requestData",
            {
              securityOrigin: origin,
              databaseName: command.database,
              objectStoreName: command.store,
              indexName: command.index ?? "",
              skipCount: skip,
              pageSize: limit,
            }
          );

          const entries = (result?.objectStoreDataEntries ?? []).map((entry: any) => ({
            key: entry.key?.value ?? entry.key,
            primaryKey: entry.primaryKey?.value ?? entry.primaryKey,
            value: entry.value?.preview?.properties
              ? Object.fromEntries(entry.value.preview.properties.map((p: any) => [p.name, p.value]))
              : entry.value?.value ?? entry.value?.description ?? "[complex object]",
          }));

          return { type: "response", id, success: true, data: { database: command.database, store: command.store, entries, hasMore: result?.hasMore ?? false } };
        } catch {
          // Fallback: Runtime.evaluate with indexedDB cursor-based read
          const evalResult = await sendCDPCommand<{ result: { value: string } }>(
            { tabId: tab.id! }, "Runtime.evaluate",
            buildEvalParams(tab.id!, `new Promise((resolve, reject) => {
              const req = indexedDB.open(${JSON.stringify(command.database)});
              req.onerror = () => reject(req.error);
              req.onsuccess = () => {
                const db = req.result;
                try {
                  const tx = db.transaction(${JSON.stringify(command.store)}, "readonly");
                  const store = tx.objectStore(${JSON.stringify(command.store)});
                  const entries = []; let skipped = 0;
                  const cursorReq = store.openCursor();
                  cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (!cursor || entries.length >= ${limit}) {
                      resolve(JSON.stringify({ entries, hasMore: !!cursor }));
                      return;
                    }
                    if (skipped < ${skip}) { skipped++; cursor.continue(); return; }
                    entries.push({ key: cursor.key, value: cursor.value });
                    cursor.continue();
                  };
                  cursorReq.onerror = () => reject(cursorReq.error);
                } catch (e) { reject(e); }
              };
            })`, { awaitPromise: true })
          );
          const parsed = JSON.parse(evalResult?.result?.value ?? '{"entries":[],"hasMore":false}');
          return { type: "response", id, success: true, data: { database: command.database, store: command.store, entries: parsed.entries, hasMore: parsed.hasMore, fallback: true } };
        }
      }

      case "clear_database": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const origin = getSecurityOrigin(tab.url ?? "");

        if (command.store) {
          try {
            await sendCDPCommand(
              { tabId: tab.id! },
              "IndexedDB.clearObjectStore",
              { securityOrigin: origin, databaseName: command.database, objectStoreName: command.store }
            );
          } catch {
            // Fallback: Runtime.evaluate to clear object store via transaction
            await sendCDPCommand(
              { tabId: tab.id! }, "Runtime.evaluate",
              buildEvalParams(tab.id!, `new Promise((resolve, reject) => {
                const req = indexedDB.open(${JSON.stringify(command.database)});
                req.onerror = () => reject(req.error);
                req.onsuccess = () => {
                  const db = req.result;
                  const tx = db.transaction(${JSON.stringify(command.store)}, "readwrite");
                  const store = tx.objectStore(${JSON.stringify(command.store)});
                  const clearReq = store.clear();
                  clearReq.onsuccess = () => resolve("cleared");
                  clearReq.onerror = () => reject(clearReq.error);
                };
              })`, { awaitPromise: true })
            );
          }
          return { type: "response", id, success: true, data: { cleared: "store", database: command.database, store: command.store } };
        } else {
          try {
            await sendCDPCommand(
              { tabId: tab.id! },
              "IndexedDB.deleteDatabase",
              { securityOrigin: origin, databaseName: command.database }
            );
          } catch {
            // Fallback: Runtime.evaluate with indexedDB.deleteDatabase()
            await sendCDPCommand(
              { tabId: tab.id! }, "Runtime.evaluate",
              buildEvalParams(tab.id!, `new Promise((resolve, reject) => {
                const req = indexedDB.deleteDatabase(${JSON.stringify(command.database)});
                req.onsuccess = () => resolve("deleted");
                req.onerror = () => reject(req.error);
              })`, { awaitPromise: true })
            );
          }
          return { type: "response", id, success: true, data: { cleared: "database", database: command.database } };
        }
      }

      // AC-6: Dialog control
      case "get_dialog": {
        return { type: "response", id, success: true, data: { dialog: pendingDialog } };
      }

      // AC-6: Dialog handling
      case "handle_dialog": {
        const targetTabId = await requireDebuggerTab();
        if (!pendingDialog) {
          throw new Error("No pending dialog");
        }

        const handleParams: Record<string, unknown> = { accept: command.accept };
        if (command.promptText !== undefined && pendingDialog.type === "prompt") {
          handleParams.promptText = command.promptText;
        }

        // Fix: clear state before await to prevent timeout race (double-accept)
        pendingDialog = null;
        if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }

        await sendCDPCommand(
          { tabId: targetTabId }, "Page.handleJavaScriptDialog",
          handleParams, 0
        );
        return { type: "response", id, success: true, data: { accepted: command.accept } };
      }

      case "take_screenshot": {
        const tab = await getConnectedTab();
        const data = await takeScreenshotHardened(tab.id!);
        return { type: "response", id, success: true, data: { data } };
      }

      case "capture_page": {
        const tab = await getConnectedTab();
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }

        // Wait for page load before capture
        try {
          await ensureDebugger(tab.id!);
          await waitForPageLoad(tab.id!);
        } catch { /* proceed without wait */ }

        await CDP_YIELD();

        // Parallel enrichment: framework detection, DOM snapshot, cookies run concurrently
        const [fwResult, domResult, cookies] = await Promise.all([
          (async () => {
            let fw = await cdpExecuteFunction<FrameworkDetection>(tab.id!, detectFrameworkInPage, [mainDocResponseHeaders]);
            if (!fw || fw.framework === "Unknown") {
              await new Promise(r => setTimeout(r, 300));
              const retry = await cdpExecuteFunction<FrameworkDetection>(tab.id!, detectFrameworkInPage, [mainDocResponseHeaders]);
              if (retry && retry.framework !== "Unknown") fw = retry;
            }
            return fw;
          })(),
          cdpExecuteFunction<any>(tab.id!, captureDOMSnapshot, [10]),
          (tab.url && tab.url.startsWith("http"))
            ? captureCookies(tab.id!, tab.url).catch(() => [] as CookieEntry[])
            : Promise.resolve([] as CookieEntry[]),
        ]);

        if (fwResult && fwResult.framework !== "Unknown" && tab.url) {
          dispatchFrameworkTelemetry(tab.url, fwResult);
        }

        // Console logs (in-memory, no CDP call needed)
        const logs = [...consoleLogs];
        consoleLogs = [];

        // Network entries (in-memory, completed requests only)
        const netEntries = Array.from(networkEntries.values()).filter(e => e.url && !e._startTime);

        const capture = {
          url: tab.url ?? "",
          title: tab.title,
          framework: fwResult,
          domSnapshot: domResult,
          consoleLogs: logs,
          networkRequests: netEntries,
          cookies,
          capturedAt: new Date().toISOString(),
          dialogCount: dialogCounts.get(tab.id!) || 0,
        };

        // Write heavy data to IDB, lightweight metadata to session storage
        try {
          await putCapture(capture);
          storageWrite("crawlio:capture-meta", {
            url: capture.url,
            title: capture.title,
            framework: capture.framework,
            capturedAt: capture.capturedAt,
          });
        } catch { /* IDB write failed — fall back to session storage */
          storageWrite("crawlio:capture", capture);
        }
        if (logs.length) {
          try { await putConsoleLogs(logs); } catch { /* IDB failed */ storageWrite("crawlio:console", logs); }
        }
        writeStatus({ lastCaptureAt: capture.capturedAt, activeTabUrl: tab.url ?? "" });

        return { type: "response", id, success: true, data: capture };
      }

      // --- Browser interaction commands ---

      case "browser_evaluate": {
        const expression = command.expression as string;
        if (!expression || typeof expression !== "string") {
          return { type: "response", id, success: false, error: "Missing expression" };
        }
        if (expression.length > MAX_EVAL_EXPRESSION_LENGTH) throw new Error(`expression too long (max ${MAX_EVAL_EXPRESSION_LENGTH} chars)`);
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const result = await sendCDPCommand<{
          result: { value?: unknown; type?: string; description?: string };
          exceptionDetails?: { text: string; exception?: { description?: string }; wasThrown?: boolean };
        }>(
          { tabId: tab.id! }, "Runtime.evaluate",
          buildEvalParams(tab.id!, expression, { returnByValue: true, awaitPromise: true }), 0, 10000
        );
        if (result.exceptionDetails) {
          const errMsg = result.exceptionDetails.exception?.description
            || result.exceptionDetails.text
            || "Evaluation error";
          return { type: "response", id, success: false, error: errMsg };
        }
        return { type: "response", id, success: true, data: { result: result.result?.value, type: result.result?.type } };
      }

      case "browser_navigate": {
        let rawUrl = command.url as string;
        if (!rawUrl) throw new Error("url is required");
        // Block javascript: URLs
        if (rawUrl.toLowerCase().startsWith("javascript:"))
          throw new Error("Unsupported protocol: javascript:");
        // Smart URL parsing: auto-add scheme
        if (!/^https?:\/\//i.test(rawUrl) && !rawUrl.startsWith("chrome://") && !rawUrl.startsWith("about:")) {
          if (rawUrl.startsWith("localhost") || rawUrl.startsWith("127.0.0.1")) {
            rawUrl = "http://" + rawUrl;
          } else {
            rawUrl = "https://" + rawUrl;
          }
        }
        // Use connected tab so navigate + capture target the same tab
        const tab = await getConnectedTab();
        try {
          await ensureDebugger(tab.id!);
          // Stop pending load if active
          try { await sendCDPCommand({ tabId: tab.id! }, "Page.stopLoading", {}, 0); } catch { /* ok */ }
          await sendCDPCommand({ tabId: tab.id! }, "Page.navigate", { url: rawUrl }, 0);
          await waitForPageLoad(tab.id!, 15000);
        } catch (navErr) {
          const navMsg = navErr instanceof Error ? navErr.message : String(navErr);
          // Handle download triggers (ERR_ABORTED) gracefully
          if (navMsg.includes("net::ERR_ABORTED")) {
            // Page triggered a download — not an error
          } else {
            // Fallback for chrome:// pages where debugger can't attach
            await chrome.tabs.update(tab.id!, { url: rawUrl });
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        const updated = await chrome.tabs.get(tab.id!);
        // Refresh stored connectedTab so get_connection_status returns current URL/favicon
        await chrome.storage.session.set({ "crawlio:connectedTab": {
          tabId: updated.id!, url: updated.url || "", title: updated.title || "Untitled",
          favIconUrl: updated.favIconUrl, windowId: updated.windowId,
        }});
        // Auto-snapshot after navigation
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "navigate", url: updated.url, title: updated.title, snapshot },
        };
      }

      case "browser_click": {
        const rawSelector = command.selector as string | undefined;
        const ref = command.ref as string | undefined;
        const coordX = command.x as number | undefined;
        const coordY = command.y as number | undefined;
        if (!rawSelector && !ref && (coordX === undefined || coordY === undefined)) {
          throw new Error("selector, ref, or x/y coordinates are required");
        }
        const button = (command.button as "left" | "right" | "middle") || undefined;
        const mods = command.modifiers as { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } | undefined;
        const clickMods = mods ? buildModifiers(mods) : 0;
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);

        let x: number, y: number;
        let resolvedSelector = rawSelector;

        if (coordX !== undefined && coordY !== undefined && !rawSelector && !ref) {
          // Coordinate-based click — no selector needed
          x = coordX;
          y = coordY;
          await dispatchClick(tab.id!, x, y, { button, modifiers: clickMods });
        } else if (ref) {
          ({ x, y } = await resolveAriaRef(tab.id!, ref));
          await dispatchClick(tab.id!, x, y, { button, modifiers: clickMods });
        } else {
          // Parse text selector: "text=Continue" or "button >> text=Continue"
          const selector = resolveTextSelector(rawSelector!);
          resolvedSelector = selector;
          ({ x, y } = await withFreshElement(tab.id!, selector, async ({ x, y }) => {
            await dispatchClick(tab.id!, x, y, { button, modifiers: clickMods });
            return { x, y };
          }));
        }
        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "click", selector: resolvedSelector ?? ref, x: x!, y: y!, snapshot },
        };
      }

      case "browser_type": {
        const selector = command.selector as string | undefined;
        const ref = command.ref as string | undefined;
        const text = command.text as string;
        const clearFirst = command.clearFirst as boolean | undefined;
        const slowly = command.slowly as boolean | undefined;
        const submit = command.submit as boolean | undefined;
        const typeMods = command.modifiers as { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } | undefined;
        const typeModBits = typeMods ? buildModifiers(typeMods) : 0;
        if (!selector && !ref) throw new Error("selector or ref is required");
        if (text === undefined || text === null) throw new Error("text is required");
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);

        if (ref) {
          const { x, y } = await resolveAriaRef(tab.id!, ref);
          await dispatchClick(tab.id!, x, y);
          if (clearFirst) {
            await dispatchKey(tab.id!, "Home");
            await dispatchKey(tab.id!, "End", 8); // Shift+End to select all
            await dispatchKey(tab.id!, "Backspace");
          }
          await dispatchType(tab.id!, text, typeModBits, !!slowly);
        } else {
          await withFreshElement(tab.id!, selector!, async () => {
            await cdpExecuteFunction(tab.id!, focusElementInPage, [selector!], true);
            if (clearFirst) {
              await dispatchKey(tab.id!, "Home");
              await dispatchKey(tab.id!, "End", 8); // Shift+End to select all
              await dispatchKey(tab.id!, "Backspace");
            }
            await dispatchType(tab.id!, text, typeModBits, !!slowly);
          });
        }
        if (submit) await dispatchKey(tab.id!, "Enter");
        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "type", selector: selector ?? ref, text, clearFirst: !!clearFirst, snapshot },
        };
      }

      case "browser_press_key": {
        const key = command.key as string;
        if (!key) throw new Error("key is required");
        const keyMods = command.modifiers as { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } | undefined;
        const keyModBits = keyMods ? buildModifiers(keyMods) : 0;
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);
        await dispatchKey(tab.id!, key, keyModBits);
        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "press_key", key, snapshot },
        };
      }

      case "browser_hover": {
        const selector = command.selector as string | undefined;
        const ref = command.ref as string | undefined;
        if (!selector && !ref) throw new Error("selector or ref is required");
        const hoverMods = command.modifiers as { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } | undefined;
        const hoverModBits = hoverMods ? buildModifiers(hoverMods) : 0;
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);
        const zoom = await getZoomFactor(tab.id!);

        let x: number, y: number;
        if (ref) {
          ({ x, y } = await resolveAriaRef(tab.id!, ref));
          const zx = Math.round(x * zoom);
          const zy = Math.round(y * zoom);
          await ensureDebugger(tab.id!);
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x: zx, y: zy, button: "none", clickCount: 0, modifiers: hoverModBits,
          }, 0);
        } else {
          ({ x, y } = await withFreshElement(tab.id!, selector!, async ({ x, y }) => {
            const zx = Math.round(x * zoom);
            const zy = Math.round(y * zoom);
            await ensureDebugger(tab.id!);
            await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
              type: "mouseMoved", x: zx, y: zy, button: "none", clickCount: 0, modifiers: hoverModBits,
            }, 0);
            return { x, y };
          }));
        }
        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "hover", selector: selector ?? ref, x, y, snapshot },
        };
      }

      case "browser_scroll": {
        const tab = await getConnectedTab();
        const deltaX = (command.deltaX as number) ?? 0;
        const deltaY = (command.deltaY as number) ?? 0;
        const selector = command.selector as string | undefined;
        const ref = command.ref as string | undefined;

        await ensureDebugger(tab.id!);

        if (ref) {
          // Ref-based: scroll element into view using resolveAriaRef
          const { x, y } = await resolveAriaRef(tab.id!, ref);
          // Scroll element into view via JS (resolveAriaRef already scrolls, but scroll to center)
          const backendNodeId = tabAriaState.get(tab.id!)?.refMap.get(ref);
          if (backendNodeId && backendNodeId !== -1) {
            const resolved = await sendCDPCommand<{ object: { objectId?: string } }>(
              { tabId: tab.id! }, "DOM.resolveNode", { backendNodeId }
            );
            if (resolved.object.objectId) {
              await sendCDPCommand({ tabId: tab.id! }, "Runtime.callFunctionOn", {
                objectId: resolved.object.objectId,
                functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); }`,
                returnByValue: true,
              });
            }
          }
          // Dispatch mouseWheel if additional delta requested
          if (deltaX || deltaY) {
            const zoom = await getZoomFactor(tab.id!);
            await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: Math.round(x * zoom),
              y: Math.round(y * zoom),
              deltaX,
              deltaY,
              modifiers: 0,
            }, 0);
          }
        } else if (selector) {
          const scrollExpr = `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
            el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
            if (${deltaX} || ${deltaY}) window.scrollBy(${deltaX}, ${deltaY});
            return { x: window.scrollX, y: window.scrollY };
          })()`;
          await sendCDPCommand({ tabId: tab.id! }, "Runtime.evaluate",
            buildEvalParams(tab.id!, scrollExpr, { returnByValue: true }), 0);
        } else if (deltaX || deltaY) {
          // Use CDP mouseWheel for proper scroll dispatch (not just JS scrollBy)
          const zoom = await getZoomFactor(tab.id!);
          const viewportExpr = `({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })`;
          const vpResult = await sendCDPCommand<{ result: { value: { x: number; y: number } } }>(
            { tabId: tab.id! }, "Runtime.evaluate",
            buildEvalParams(tab.id!, viewportExpr, { returnByValue: true }), 0
          );
          const cx = vpResult.result?.value?.x ?? 400;
          const cy = vpResult.result?.value?.y ?? 300;
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: Math.round(cx * zoom),
            y: Math.round(cy * zoom),
            deltaX,
            deltaY,
            modifiers: 0,
          }, 0);
        }

        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "scroll", deltaX, deltaY, selector: selector ?? ref ?? null, snapshot },
        };
      }

      case "browser_double_click": {
        const selector = command.selector as string | undefined;
        const ref = command.ref as string | undefined;
        if (!selector && !ref) throw new Error("selector or ref is required");
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);
        const dblZoom = await getZoomFactor(tab.id!);

        async function dblClickAt(cx: number, cy: number): Promise<void> {
          const zx = Math.round(cx * dblZoom);
          const zy = Math.round(cy * dblZoom);
          await ensureDebugger(tab.id!);
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mousePressed", x: zx, y: zy, button: "left", clickCount: 1,
          }, 0);
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mouseReleased", x: zx, y: zy, button: "left", clickCount: 1,
          }, 0);
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mousePressed", x: zx, y: zy, button: "left", clickCount: 2,
          }, 0);
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mouseReleased", x: zx, y: zy, button: "left", clickCount: 2,
          }, 0);
        }

        let x: number, y: number;
        if (ref) {
          ({ x, y } = await resolveAriaRef(tab.id!, ref));
          await dblClickAt(x, y);
        } else {
          ({ x, y } = await withFreshElement(tab.id!, selector!, async ({ x, y }) => {
            await dblClickAt(x, y);
            return { x, y };
          }));
        }
        await waitForStableDOM(tab.id!);
        return {
          type: "response", id, success: true,
          data: { action: "double_click", selector: selector ?? ref, x, y },
        };
      }

      case "browser_drag": {
        const from = command.from as string | undefined;
        const to = command.to as string | undefined;
        const refFrom = command.refFrom as string | undefined;
        const refTo = command.refTo as string | undefined;
        if (!from && !refFrom) throw new Error("from selector or refFrom is required");
        if (!to && !refTo) throw new Error("to selector or refTo is required");
        const steps = (command.steps as number) ?? 10;
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);
        const dragZoom = await getZoomFactor(tab.id!);

        // Resolve start coordinates
        let fx: number, fy: number;
        if (refFrom) {
          ({ x: fx, y: fy } = await resolveAriaRef(tab.id!, refFrom));
        } else {
          const fromPrepared = await prepareElementForInteraction(tab.id!, from!);
          fx = fromPrepared.x;
          fy = fromPrepared.y;
        }

        // Resolve end coordinates
        let tx: number, ty: number;
        if (refTo) {
          ({ x: tx, y: ty } = await resolveAriaRef(tab.id!, refTo));
        } else {
          const toPrepared = await prepareElementForInteraction(tab.id!, to!);
          tx = toPrepared.x;
          ty = toPrepared.y;
        }

        await ensureDebugger(tab.id!);
        const zfx = Math.round(fx * dragZoom);
        const zfy = Math.round(fy * dragZoom);
        const ztx = Math.round(tx * dragZoom);
        const zty = Math.round(ty * dragZoom);

        await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
          type: "mousePressed", x: zfx, y: zfy, button: "left", clickCount: 1,
        }, 0);

        for (let i = 1; i <= steps; i++) {
          const ratio = i / steps;
          const mx = Math.round(zfx + (ztx - zfx) * ratio);
          const my = Math.round(zfy + (zty - zfy) * ratio);
          await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x: mx, y: my, button: "left",
          }, 0);
        }

        await sendCDPCommand({ tabId: tab.id! }, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x: ztx, y: zty, button: "left", clickCount: 1,
        }, 0);

        await waitForStableDOM(tab.id!);
        return {
          type: "response", id, success: true,
          data: { action: "drag", from: from ?? refFrom, to: to ?? refTo, steps },
        };
      }

      case "browser_file_upload": {
        const selector = command.selector as string;
        const files = command.files as string[];
        if (!selector) throw new Error("selector is required");
        if (!files || !Array.isArray(files) || files.length === 0) throw new Error("files array is required and must not be empty");

        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        // Resolve element via existing pattern (returns objectId)
        const objectId = await resolveElement(tab.id!, selector);

        // Validate it's a file input
        const typeCheck = await sendCDPCommand<{ result: { value: string } }>(
          { tabId: tab.id! }, "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: `function() {
              if (this.tagName !== 'INPUT') return 'not-input:' + this.tagName;
              if (this.type !== 'file') return 'not-file:' + this.type;
              return 'ok';
            }`,
            returnByValue: true,
          }
        );
        if (typeCheck.result.value !== "ok") {
          throw new Error(`Element is not a file input (${typeCheck.result.value})`);
        }

        // Set files via DOM.setFileInputFiles with objectId
        await sendCDPCommand({ tabId: tab.id! }, "DOM.setFileInputFiles", {
          objectId,
          files,
        });

        return {
          type: "response", id, success: true,
          data: { action: "file_upload", selector, filesCount: files.length },
        };
      }

      case "browser_select_option": {
        const selector = command.selector as string | undefined;
        const ref = command.ref as string | undefined;
        const value = command.value as string;
        if (!selector && !ref) throw new Error("selector or ref is required");
        if (value === undefined || value === null) throw new Error("value is required");
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);

        let result: any;
        if (ref) {
          const backendNodeId = tabAriaState.get(tab.id!)?.refMap.get(ref);
          if (backendNodeId === undefined) throw new Error(`Element ref '${ref}' not found. Run browser_snapshot to refresh.`);
          await ensureDebugger(tab.id!);
          let objectId: string | undefined;
          if (backendNodeId === -1) {
            const cssSelector = tabAriaState.get(tab.id!)?.refSelectorMap.get(ref);
            if (!cssSelector) throw new Error(`Element ref '${ref}' has no CSS selector. Run browser_snapshot to refresh.`);
            objectId = await resolveCssSelectorToObjectId(tab.id!, cssSelector);
          } else {
            const resolved = await sendCDPCommand<{ object: { objectId?: string } }>(
              { tabId: tab.id! }, "DOM.resolveNode", { backendNodeId }
            );
            objectId = resolved.object.objectId;
          }
          if (!objectId) throw new Error(`Could not resolve ref '${ref}' to DOM node`);
          const selectResult = await sendCDPCommand<{ result: { value: any } }>(
            { tabId: tab.id! }, "Runtime.callFunctionOn",
            {
              objectId,
              functionDeclaration: `function(value) {
                if (this.tagName !== 'SELECT') throw new Error('Element is not a <select>');
                const prev = this.value;
                this.value = value;
                if (this.value !== value) throw new Error('Option value "' + value + '" not found');
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
                return { previousValue: prev, newValue: this.value };
              }`,
              arguments: [{ value }],
              returnByValue: true,
            }
          );
          result = selectResult.result.value;
        } else {
          result = await withFreshElement(tab.id!, selector!, async () => {
            const r = await cdpExecuteFunction(tab.id!, selectOptionInPage, [selector!, value], true);
            if (!r) throw new Error(`Could not select option in: ${selector}`);
            return r;
          });
        }
        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "select_option", selector: selector ?? ref, ...result, snapshot },
        };
      }

      case "browser_wait": {
        const seconds = command.seconds as number;
        if (!seconds || seconds <= 0) throw new Error("seconds must be > 0");
        const clamped = Math.min(seconds, 30);
        await new Promise(r => setTimeout(r, clamped * 1000));
        return {
          type: "response", id, success: true,
          data: { action: "wait", seconds: clamped },
        };
      }

      case "browser_intercept": {
        const tab = await getConnectedTab();
        const tabId = tab.id!;
        const action = command.action as string;

        if (action === "disable") {
          await disableInterception(tabId);
          return {
            type: "response", id, success: true,
            data: { action: "intercept_disabled", tabId },
          };
        }

        const patterns = command.patterns as InterceptRule[] | undefined;
        if (!patterns?.length) throw new Error("patterns array required (each with urlPattern and action)");

        await enableInterception(tabId, patterns);
        return {
          type: "response", id, success: true,
          data: { action: "intercept_enabled", tabId, patternCount: patterns.length },
        };
      }

      case "wait_for_selector": {
        const wfsTabId = await requireDebuggerTab();
        const selector = command.selector as string;
        if (!selector) throw new Error("selector is required");
        const result = await waitForSelector(wfsTabId, {
          selector,
          state: (command.state as WaitState) || undefined,
          timeout: (command.timeout as number) || undefined,
        });
        return {
          type: "response", id, success: result.found,
          data: { action: "wait_for_selector", selector, ...result },
        };
      }

      // --- Frame execution context tools (AC-2) ---

      case "get_frame_tree": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        await populateFrameTree(tab.id!);
        const map = frameTrees.get(tab.id!);
        if (!map) return { type: "response", id, success: true, data: { action: "get_frame_tree", frames: [] } };

        // Build flat list with contextId for MCP consumption
        const frames = Array.from(map.values()).map(f => ({
          frameId: f.id,
          parentFrameId: f.parentId || null,
          url: f.url,
          name: f.name,
          securityOrigin: f.securityOrigin,
          contextId: frameContexts.get(tab.id!)?.get(f.id) ?? null,
          isActive: f.id === activeFrameId,
        }));

        return { type: "response", id, success: true, data: { action: "get_frame_tree", frames, activeFrameId } };
      }

      case "switch_to_frame": {
        const tab = await getConnectedTab();
        const frameId = command.frameId as string;
        if (!frameId) throw new Error("frameId is required");

        // Validate frame exists in our frame tree
        const frameMap = frameTrees.get(tab.id!);
        if (!frameMap?.has(frameId)) {
          throw new Error(`Frame ${frameId} not found — call get_frame_tree first`);
        }

        // Validate we have an execution context for this frame
        const ctxId = frameContexts.get(tab.id!)?.get(frameId);
        if (ctxId === undefined) {
          throw new Error(`No execution context for frame ${frameId} — frame may not have loaded yet`);
        }

        activeFrameId = frameId;
        const frame = frameMap.get(frameId)!;
        return { type: "response", id, success: true, data: {
          action: "switch_to_frame", frameId, url: frame.url, name: frame.name, contextId: ctxId,
        }};
      }

      case "switch_to_main_frame": {
        activeFrameId = null;
        return { type: "response", id, success: true, data: { action: "switch_to_main_frame", activeFrameId: null } };
      }

      // --- Tab management (AC-3) ---

      case "create_tab": {
        await ensureTabPermission(type);
        const createUrl = command.url as string | undefined;
        if (!createUrl || typeof createUrl !== "string") {
          throw new Error("url is required");
        }
        try {
          const parsed = new URL(createUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`URL must use http/https scheme, got ${parsed.protocol}`);
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes("http/https")) throw e;
          throw new Error(`Invalid URL: ${createUrl}`);
        }
        const createdTab = await chrome.tabs.create({
          url: createUrl,
          active: command.active !== false,
        });

        // Auto-connect: attach debugger + start capture so the tab is ready for interaction
        if (command.connect) {
          await new Promise<void>((resolve) => {
            let th: ReturnType<typeof setTimeout> | undefined;
            const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
              if (tabId === createdTab.id && info.status === "complete") {
                clearTimeout(th);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            th = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
          });
          const freshTab = await chrome.tabs.get(createdTab.id!);
          await chrome.storage.session.set({ "crawlio:connectedTab": {
            tabId: freshTab.id!, url: freshTab.url || "", title: freshTab.title || "Untitled",
            favIconUrl: freshTab.favIconUrl, windowId: freshTab.windowId,
          }});
          await startNetworkCapture(freshTab.id!);
          await persistState().catch(() => {});
          handleCommand({ type: "capture_page", id: "auto-connect" }).catch(() => {});
          setDynamicIcon("active", freshTab.id!);
          const domainResult = tabDomainState.get(freshTab.id!) ?? null;
          return { type: "response", id, success: true, data: {
            action: "create_tab",
            tabId: freshTab.id,
            url: freshTab.url ?? freshTab.pendingUrl ?? createUrl,
            title: freshTab.title ?? "",
            connected: true,
            domainState: domainResult,
          }};
        }

        return { type: "response", id, success: true, data: {
          action: "create_tab",
          tabId: createdTab.id,
          url: createdTab.url ?? createdTab.pendingUrl ?? createUrl,
          title: createdTab.title ?? "",
        }};
      }

      case "close_tab": {
        await ensureTabPermission(type);
        const closeTabId = command.tabId;
        if (typeof closeTabId !== "number" || !Number.isInteger(closeTabId) || closeTabId <= 0) {
          throw new Error("tabId must be a positive integer");
        }
        // If this is the connected tab, disconnect first
        if (closeTabId === debuggerAttachedTabId) {
          try { await chrome.debugger.detach({ tabId: closeTabId }); } catch { /* already detached */ }
          attachedTabs.delete(closeTabId);
          debuggerAttachedTabId = null;
          activeFrameId = null;
          stealthScriptId = null;
          frameworkHookScriptId = null;
          currentSecurityState = null;
          connectionStartTime = null;
          lastCommandTime = null;
          networkCapturing = false;
          cssCoverageActive = false;
          jsCoverageActive = false;
          consoleLogs = [];
          mainDocResponseHeaders = {};
          networkEntries.clear();
          wsConnections.clear();
          swRegistrations.clear();
          targetSessions.clear();
          browserContexts.clear();
          frameTrees.delete(closeTabId);
          frameContexts.delete(closeTabId);
          dialogCounts.delete(closeTabId);
          interceptRules.delete(closeTabId);
          tabDomainState.delete(closeTabId);
          pendingDialog = null;
          pendingFileChooser = null;
          if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
          persistState().catch(() => {});
        }
        // Clean port regardless of debugger state (symmetric with tabs.onRemoved)
        activePorts.delete(closeTabId);
        await chrome.tabs.remove(closeTabId);
        // Clean connected tab storage if this was the connected tab
        const closeConnData = await chrome.storage.session.get("crawlio:connectedTab");
        if (closeConnData["crawlio:connectedTab"]?.tabId === closeTabId) {
          await chrome.storage.session.remove("crawlio:connectedTab");
          writeStatus({ capturing: false, activeTabId: null });
        }
        return { type: "response", id, success: true, data: { action: "close_tab", success: true } };
      }

      case "switch_tab": {
        await ensureTabPermission(type);
        const switchTabId = command.tabId;
        if (typeof switchTabId !== "number" || !Number.isInteger(switchTabId) || switchTabId <= 0) {
          throw new Error("tabId must be a positive integer");
        }
        await chrome.tabs.update(switchTabId, { active: true });
        const switchedTab = await chrome.tabs.get(switchTabId);
        return { type: "response", id, success: true, data: {
          action: "switch_tab",
          tabId: switchedTab.id,
          url: switchedTab.url,
          title: switchedTab.title,
        }};
      }

      // AC-8: Viewport & device emulation
      case "set_viewport": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        await sendCDPCommand(
          { tabId: tab.id! },
          "Emulation.setDeviceMetricsOverride",
          {
            width: command.width,
            height: command.height,
            deviceScaleFactor: command.deviceScaleFactor ?? 1,
            mobile: command.mobile ?? false,
          }
        );
        return { type: "response", id, success: true, data: {
          width: command.width,
          height: command.height,
          deviceScaleFactor: command.deviceScaleFactor ?? 1,
          mobile: command.mobile ?? false,
        }};
      }

      case "set_user_agent": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        await sendCDPCommand(
          { tabId: tab.id! },
          "Emulation.setUserAgentOverride",
          { userAgent: command.userAgent }
        );
        return { type: "response", id, success: true, data: { userAgent: command.userAgent } };
      }

      case "emulate_device": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const profile = DEVICE_PROFILES[command.device];
        if (!profile) {
          return { type: "response", id, success: false,
            error: `Unknown device: ${command.device}. Available: ${Object.keys(DEVICE_PROFILES).join(", ")}` };
        }
        await sendCDPCommand(
          { tabId: tab.id! },
          "Emulation.setDeviceMetricsOverride",
          {
            width: profile.width,
            height: profile.height,
            deviceScaleFactor: profile.deviceScaleFactor,
            mobile: profile.mobile,
          }
        );
        if (profile.userAgent) {
          await sendCDPCommand(
            { tabId: tab.id! },
            "Emulation.setUserAgentOverride",
            { userAgent: profile.userAgent }
          );
        }
        return { type: "response", id, success: true, data: {
          device: command.device,
          width: profile.width,
          height: profile.height,
          deviceScaleFactor: profile.deviceScaleFactor,
          mobile: profile.mobile,
          userAgent: profile.userAgent,
        }};
      }

      // AC-12: Geolocation emulation
      // Emulation.clearGeolocationOverride
      case "set_geolocation": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        // If no coordinates provided, clear the override
        if (command.latitude === undefined && command.longitude === undefined) {
          await sendCDPCommand(
            { tabId: tab.id! },
            "Emulation.clearGeolocationOverride",
            {}
          );
          return { type: "response", id, success: true, data: { cleared: true } };
        }

        // Both lat and lng must be provided together
        if (typeof command.latitude !== "number" || typeof command.longitude !== "number") {
          return { type: "response", id, success: false,
            error: "Both latitude and longitude must be provided together" };
        }

        // Validate ranges
        const lat = command.latitude;
        const lng = command.longitude;
        if (lat < -90 || lat > 90) {
          return { type: "response", id, success: false,
            error: `Invalid latitude ${lat}: must be between -90 and 90` };
        }
        if (lng < -180 || lng > 180) {
          return { type: "response", id, success: false,
            error: `Invalid longitude ${lng}: must be between -180 and 180` };
        }

        const accuracy = Math.max(0, (command.accuracy as number) ?? 1);

        await sendCDPCommand(
          { tabId: tab.id! },
          "Emulation.setGeolocationOverride",
          { latitude: lat, longitude: lng, accuracy }
        );

        // Grant geolocation permission so pages don't show permission prompt
        try {
          await sendCDPCommand(
            { tabId: tab.id! },
            "Browser.grantPermissions",
            { permissions: ["geolocation"] }
          );
        } catch {
          // Browser.grantPermissions may not be available in all contexts — non-fatal
        }

        return { type: "response", id, success: true, data: {
          latitude: lat,
          longitude: lng,
          accuracy,
        }};
      }

      // AC-9: PDF generation
      // Error strings: "No web contents to print", "Printing is not available", "Printing failed"
      case "print_to_pdf": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        const PAPER_SIZES: Record<string, { width: number; height: number }> = {
          letter: { width: 8.5, height: 11 },
          legal: { width: 8.5, height: 14 },
          tabloid: { width: 11, height: 17 },
          a3: { width: 11.69, height: 16.54 },
          a4: { width: 8.27, height: 11.69 },
          a5: { width: 5.83, height: 8.27 },
        };

        let paperWidth = command.paperWidth ?? 8.5;
        let paperHeight = command.paperHeight ?? 11;
        if (command.format && PAPER_SIZES[command.format]) {
          paperWidth = PAPER_SIZES[command.format].width;
          paperHeight = PAPER_SIZES[command.format].height;
        }

        const pdfParams: Record<string, unknown> = {
          landscape: command.landscape ?? false,
          displayHeaderFooter: command.displayHeaderFooter ?? false,
          printBackground: command.printBackground ?? true,
          scale: Math.max(0.1, Math.min(2, command.scale ?? 1)),
          paperWidth,
          paperHeight,
          marginTop: command.marginTop ?? 0.4,
          marginBottom: command.marginBottom ?? 0.4,
          marginLeft: command.marginLeft ?? 0.4,
          marginRight: command.marginRight ?? 0.4,
          transferMode: "ReturnAsBase64",
        };

        if (command.pageRanges) pdfParams.pageRanges = command.pageRanges;

        const result = await sendCDPCommand<{ data: string }>(
          { tabId: tab.id! },
          "Page.printToPDF",
          pdfParams,
          1,     // maxRetries — PDF gen is idempotent
          60000  // 60s timeout — large pages can take time
        );

        return { type: "response", id, success: true, data: {
          data: result.data,
          sizeBytes: result.data ? Math.round(result.data.length * 0.75) : 0,
        }};
      }

      // AC-13: Accessibility tree
      case "get_accessibility_tree": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        const maxDepth = Math.min(Math.max((command.depth as number) ?? 10, 1), 50);

        let result: any;

        if (command.root) {
          const doc = await sendCDPCommand<{ root: { nodeId: number } }>(
            { tabId: tab.id! }, "DOM.getDocument", {}
          );
          const node = await sendCDPCommand<{ nodeId: number }>(
            { tabId: tab.id! }, "DOM.querySelector",
            { nodeId: doc.root.nodeId, selector: command.root as string }
          );
          if (!node?.nodeId) {
            return { type: "response", id, success: false,
              error: `Element not found: ${command.root}` };
          }
          result = await sendCDPCommand(
            { tabId: tab.id! }, "Accessibility.getPartialAXTree",
            { nodeId: node.nodeId, fetchRelatives: false }
          );
        } else {
          const axTreeParams: Record<string, unknown> = { depth: maxDepth };
          if (activeFrameId) axTreeParams.frameId = activeFrameId;
          result = await sendCDPCommand(
            { tabId: tab.id! }, "Accessibility.getFullAXTree",
            axTreeParams
          );
        }

        const rawNodes: any[] = result.nodes ?? [];
        const simplified = rawNodes.map(simplifyAXNode);
        const { tree, nodeCount } = buildAXTree(simplified, maxDepth);

        return { type: "response", id, success: true, data: {
          tree,
          nodeCount,
        }};
      }

      // AC-14: Performance metrics
      case "get_performance_metrics": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        // CDP Performance.getMetrics — returns {metrics: [{name, value}, ...]}
        const cdpMetrics = await sendCDPCommand<{ metrics: Array<{ name: string; value: number }> }>(
          { tabId: tab.id! }, "Performance.getMetrics", {}
        );
        const metrics: Record<string, number> = {};
        for (const m of cdpMetrics.metrics ?? []) {
          metrics[m.name] = m.value;
        }

        // Web Vitals from injected PerformanceObserver script
        let webVitals = { lcp: null as number | null, cls: 0, fid: null as number | null };
        try {
          const vitalsResult = await sendCDPCommand<{ result: { value: any } }>(
            { tabId: tab.id! }, "Runtime.evaluate", {
              expression: "window.__crawlioPerf",
              returnByValue: true,
            }
          );
          if (vitalsResult?.result?.value) {
            webVitals = vitalsResult.result.value;
          }
        } catch {
          // Web Vitals not available — non-fatal
        }

        // Navigation timing for core page load metrics
        let timing = null;
        try {
          const timingResult = await sendCDPCommand<{ result: { value: any } }>(
            { tabId: tab.id! }, "Runtime.evaluate", {
              expression: `(() => {
                const t = performance.getEntriesByType("navigation")[0];
                if (!t) return null;
                return {
                  domContentLoaded: t.domContentLoadedEventEnd - t.startTime,
                  load: t.loadEventEnd - t.startTime,
                  firstByte: t.responseStart - t.startTime,
                  domInteractive: t.domInteractive - t.startTime,
                  transferSize: t.transferSize,
                  encodedBodySize: t.encodedBodySize,
                };
              })()`,
              returnByValue: true,
            }
          );
          if (timingResult?.result?.value) {
            timing = timingResult.result.value;
          }
        } catch { /* non-fatal */ }

        return { type: "response", id, success: true, data: {
          chrome: {
            documents: metrics.Documents,
            frames: metrics.Frames,
            jsEventListeners: metrics.JSEventListeners,
            nodes: metrics.Nodes,
            layoutCount: metrics.LayoutCount,
            recalcStyleCount: metrics.RecalcStyleCount,
            layoutDuration: metrics.LayoutDuration,
            recalcStyleDuration: metrics.RecalcStyleDuration,
            scriptDuration: metrics.ScriptDuration,
            taskDuration: metrics.TaskDuration,
            jsHeapUsedSize: metrics.JSHeapUsedSize,
            jsHeapTotalSize: metrics.JSHeapTotalSize,
          },
          webVitals: {
            lcp: webVitals.lcp,
            cls: Math.round(webVitals.cls * 1000) / 1000,
            fid: webVitals.fid,
          },
          timing,
        }};
      }

      case "set_stealth_mode": {
        stealthEnabled = !!command.enabled;

        if (debuggerAttachedTabId) {
          if (stealthEnabled) {
            const stealthResult = await sendCDPCommand<{ identifier: string }>({ tabId: debuggerAttachedTabId }, "Page.addScriptToEvaluateOnNewDocument", {
              source: STEALTH_SCRIPT,
            }, 0);
            stealthScriptId = stealthResult?.identifier ?? null;
            await sendCDPCommand({ tabId: debuggerAttachedTabId }, "Runtime.evaluate", {
              expression: STEALTH_SCRIPT,
              returnByValue: true,
            }, 0);
          } else if (stealthScriptId) {
            // Remove stealth script from future navigations (current page patches are JS-level, irreversible)
            await sendCDPCommand({ tabId: debuggerAttachedTabId }, "Page.removeScriptToEvaluateOnNewDocument", {
              identifier: stealthScriptId,
            }, 0);
            stealthScriptId = null;
          }
        }

        return { type: "response", id, success: true, data: { stealthEnabled } };
      }

      // --- SEO Intelligence Settings (Phase 6) ---
      case "set_seo_intelligence": {
        const prev = { ...seoIntelligenceSettings };
        if (typeof command.enabled === "boolean") seoIntelligenceSettings.enabled = command.enabled;
        if (typeof command.autoOverlay === "boolean") seoIntelligenceSettings.autoOverlay = command.autoOverlay;
        if (typeof command.autoBadge === "boolean") seoIntelligenceSettings.autoBadge = command.autoBadge;
        await chrome.storage.session.set({ "crawlio:seoIntelligence": { ...seoIntelligenceSettings } });
        return { type: "response", id, success: true, data: { previous: prev, current: { ...seoIntelligenceSettings } } };
      }

      case "get_seo_intelligence": {
        return { type: "response", id, success: true, data: { ...seoIntelligenceSettings } };
      }

      case "set_idle_release": {
        // Idle release detaches the debugger after a quiet period so Chrome's "being
        // debugged" banner clears; the next command re-attaches and restores the session.
        const requested = command.idleMs;
        const idleMs = requested === 0 || requested === null ? 0 : resolveIdleReleaseMs(requested);
        await chrome.storage.local.set({ [IDLE_RELEASE_CONFIG_KEY]: idleMs });
        if (idleMs > 0) {
          if (attachedTabs.size > 0) await startIdleReleaseAlarm();
        } else {
          stopIdleReleaseAlarm();
        }
        return { type: "response", id, success: true, data: {
          idleMs,
          enabled: idleMs > 0,
          minimumMs: MIN_IDLE_RELEASE_MS,
          // A request below the floor is raised rather than honored, so say so plainly.
          adjusted: typeof requested === "number" && requested > 0 && requested !== idleMs,
        }};
      }

      case "get_idle_release": {
        const idleMs = await getIdleReleaseMs();
        return { type: "response", id, success: true, data: {
          idleMs, enabled: idleMs > 0, minimumMs: MIN_IDLE_RELEASE_MS, defaultMs: DEFAULT_IDLE_RELEASE_MS,
        }};
      }

      case "emulate_network": {
        const tabId = await requireDebuggerTab();

        // No args = clear throttling
        if (!command.preset && command.downloadKbps === undefined && command.uploadKbps === undefined && command.latencyMs === undefined) {
          await sendCDPCommand({ tabId: tabId }, "Network.emulateNetworkConditions", {
            offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
          });
          return { type: "response", id, success: true, data: { cleared: true } };
        }

        const preset = command.preset ? NETWORK_PRESETS[command.preset] : null;
        const downloadKbps = command.downloadKbps ?? preset?.downloadKbps ?? -1;
        const uploadKbps = command.uploadKbps ?? preset?.uploadKbps ?? -1;
        const latencyMs = command.latencyMs ?? preset?.latencyMs ?? 0;
        const offline = downloadKbps === 0 && uploadKbps === 0;

        await sendCDPCommand({ tabId: tabId }, "Network.emulateNetworkConditions", {
          offline,
          latency: latencyMs,
          downloadThroughput: offline ? 0 : (downloadKbps * 1024 / 8),  // Kbps → bytes/sec
          uploadThroughput: offline ? 0 : (uploadKbps * 1024 / 8),
        });
        return { type: "response", id, success: true, data: { preset: command.preset, downloadKbps, uploadKbps, latencyMs, offline } };
      }

      case "set_cache_disabled": {
        const tabId = await requireDebuggerTab();
        await sendCDPCommand({ tabId: tabId }, "Network.setCacheDisabled", { cacheDisabled: !!command.disabled });
        return { type: "response", id, success: true, data: { cacheDisabled: !!command.disabled } };
      }

      case "set_extra_headers": {
        const tabId = await requireDebuggerTab();
        const headers = command.headers as Record<string, string> ?? {};
        await sendCDPCommand({ tabId: tabId }, "Network.setExtraHTTPHeaders", { headers });
        return { type: "response", id, success: true, data: { headerCount: Object.keys(headers).length } };
      }

      case "get_security_state": {
        await requireDebuggerTab();
        return { type: "response", id, success: true, data: currentSecurityState ?? { securityState: "unknown", updatedAt: new Date().toISOString() } };
      }

      case "ignore_certificate_errors": {
        const tabId = await requireDebuggerTab();
        try {
          await sendCDPCommand({ tabId: tabId }, "Security.setIgnoreCertificateErrors", { ignore: !!command.ignore });
          return { type: "response", id, success: true, data: { ignoringCertErrors: !!command.ignore } };
        } catch {
          return { type: "response", id, success: false, error: "Security domain unavailable via chrome.debugger" };
        }
      }

      // AC-19: Service worker control
      case "list_service_workers": {
        const tabId = await requireDebuggerTab();
        const registrations = Array.from(swRegistrations.values()).filter(r => !r.isDeleted);
        // If CDP ServiceWorker domain failed, fall back to JS API
        if (registrations.length === 0) {
          try {
            const evalResult = await sendCDPCommand<{ result: { value: string } }>(
              { tabId: tabId }, "Runtime.evaluate",
              buildEvalParams(tabId, `navigator.serviceWorker.getRegistrations().then(regs =>
                JSON.stringify(regs.map(r => ({
                  scopeURL: r.scope,
                  isDeleted: false,
                  versions: [{ status: r.active ? "activated" : r.installing ? "installing" : "waiting",
                    scriptURL: (r.active || r.installing || r.waiting)?.scriptURL ?? "" }]
                })))
              )`, { awaitPromise: true })
            );
            const parsed = JSON.parse(evalResult?.result?.value ?? "[]");
            if (parsed.length > 0) {
              return { type: "response", id, success: true, data: { registrations: parsed, fallback: true } };
            }
          } catch { /* JS API also unavailable — return empty */ }
        }
        return { type: "response", id, success: true, data: { registrations } };
      }

      case "stop_service_worker": {
        const tabId = await requireDebuggerTab();
        try {
          if (command.registrationId) {
            const reg = swRegistrations.get(command.registrationId as string);
            if (!reg) return { type: "response", id, success: false, error: `Registration not found: ${command.registrationId}` };
            // CDP has no per-registration stop — stopAllWorkers is the only stop command
            await sendCDPCommand({ tabId: tabId }, "ServiceWorker.stopAllWorkers", {});
            await sendCDPCommand({ tabId: tabId }, "ServiceWorker.unregister", { scopeURL: reg.scopeURL });
          } else {
            await sendCDPCommand({ tabId: tabId }, "ServiceWorker.stopAllWorkers", {});
            for (const reg of swRegistrations.values()) {
              if (!reg.isDeleted) {
                await sendCDPCommand({ tabId: tabId }, "ServiceWorker.unregister", { scopeURL: reg.scopeURL });
              }
            }
          }
          return { type: "response", id, success: true, data: { stopped: true } };
        } catch {
          // Fallback: Runtime.evaluate to unregister service workers via JS API
          await sendCDPCommand(
            { tabId: tabId }, "Runtime.evaluate",
            buildEvalParams(tabId, `navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(r => r.unregister())))`, { awaitPromise: true })
          );
          return { type: "response", id, success: true, data: { stopped: true, fallback: true } };
        }
      }

      case "bypass_service_worker": {
        const tabId = await requireDebuggerTab();
        const bypass = !!command.enabled;
        await sendCDPCommand({ tabId: tabId }, "Network.setBypassServiceWorker", { bypass });
        try {
          await sendCDPCommand({ tabId: tabId }, "ServiceWorker.setForceUpdateOnPageLoad", { forceUpdateOnPageLoad: bypass });
        } catch {
          if (__DEV__) console.warn("[Crawlio] ServiceWorker.setForceUpdateOnPageLoad unavailable, Network bypass still applied");
        }
        return { type: "response", id, success: true, data: { bypassing: bypass } };
      }

      // --- AC-20: DOM Manipulation (DOM.setOuterHTML, DOM.setAttributeValue,
      // DOM.removeAttribute, DOM.removeNode) ---

      case "set_outer_html": {
        const tabId = await requireDebuggerTab();
        const html = command.html as string;
        if (!command.dangerous && /<script|<iframe|on[a-z]+\s*=/i.test(html)) {
          return { type: "response", id, success: false, error: "HTML contains potentially dangerous content (<script>, <iframe>, or event handlers). Set dangerous: true to allow." };
        }
        const nodeId = await resolveNodeId(tabId, command.selector as string);
        await sendCDPCommand({ tabId: tabId }, "DOM.setOuterHTML", { nodeId, outerHTML: html });
        return { type: "response", id, success: true, data: { action: "set_outer_html", selector: command.selector } };
      }

      case "set_attribute": {
        const tabId = await requireDebuggerTab();
        const nodeId = await resolveNodeId(tabId, command.selector as string);
        await sendCDPCommand({ tabId: tabId }, "DOM.setAttributeValue", { nodeId, name: command.name as string, value: command.value as string });
        return { type: "response", id, success: true, data: { action: "set_attribute", selector: command.selector, name: command.name } };
      }

      case "remove_attribute": {
        const tabId = await requireDebuggerTab();
        const nodeId = await resolveNodeId(tabId, command.selector as string);
        await sendCDPCommand({ tabId: tabId }, "DOM.removeAttribute", { nodeId, name: command.name as string });
        return { type: "response", id, success: true, data: { action: "remove_attribute", selector: command.selector, name: command.name } };
      }

      case "remove_node": {
        const tabId = await requireDebuggerTab();
        const nodeId = await resolveNodeId(tabId, command.selector as string);
        await sendCDPCommand({ tabId: tabId }, "DOM.removeNode", { nodeId });
        return { type: "response", id, success: true, data: { action: "remove_node", selector: command.selector } };
      }

      // --- AC-21: CSS Coverage & Pseudo-State ---

      case "start_css_coverage": {
        const tabId = await requireDebuggerTab();
        if (cssCoverageActive) return { type: "response", id, success: false, error: "CSS coverage already active" };
        try {
          await sendCDPCommand({ tabId: tabId }, "CSS.startRuleUsageTracking", {});
          cssCoverageActive = true;
          return { type: "response", id, success: true, data: { action: "start_css_coverage" } };
        } catch {
          return { type: "response", id, success: false, error: "CSS domain unavailable via chrome.debugger — CSS coverage tracking is not supported from extensions" };
        }
      }

      case "stop_css_coverage": {
        const tabId = await requireDebuggerTab();
        if (!cssCoverageActive) return { type: "response", id, success: false, error: "CSS coverage not active" };
        let coverageResult: { ruleUsage: Array<{ styleSheetId: string; startOffset: number; endOffset: number; used: boolean }> } = { ruleUsage: [] };
        try {
          coverageResult = await sendCDPCommand<typeof coverageResult>(
            { tabId: tabId }, "CSS.stopRuleUsageTracking", {}
          );
        } catch {
          cssCoverageActive = false;
          return { type: "response", id, success: false, error: "CSS domain unavailable via chrome.debugger — cannot retrieve coverage results" };
        }
        cssCoverageActive = false;
        const rawRules = coverageResult.ruleUsage ?? [];
        // Summarize per-stylesheet (match JS coverage pattern)
        const sheetMap = new Map<string, { totalBytes: number; usedBytes: number }>();
        for (const r of rawRules) {
          let sheet = sheetMap.get(r.styleSheetId);
          if (!sheet) { sheet = { totalBytes: 0, usedBytes: 0 }; sheetMap.set(r.styleSheetId, sheet); }
          const size = r.endOffset - r.startOffset;
          sheet.totalBytes += size;
          if (r.used) sheet.usedBytes += size;
        }
        const stylesheets = [...sheetMap.entries()].map(([styleSheetId, s]) => ({
          styleSheetId,
          totalBytes: s.totalBytes,
          usedBytes: s.usedBytes,
          coveragePercent: s.totalBytes > 0 ? Math.round((s.usedBytes / s.totalBytes) * 100) : 0,
        }));
        const cssTotalBytes = stylesheets.reduce((sum, s) => sum + s.totalBytes, 0);
        const cssTotalUsed = stylesheets.reduce((sum, s) => sum + s.usedBytes, 0);
        return { type: "response", id, success: true, data: {
          stylesheets,
          summary: {
            totalStylesheets: stylesheets.length,
            totalRules: rawRules.length,
            totalBytes: cssTotalBytes,
            usedBytes: cssTotalUsed,
            overallCoveragePercent: cssTotalBytes > 0 ? Math.round((cssTotalUsed / cssTotalBytes) * 100) : 0,
          },
        } };
      }

      // --- AC-22: JS Code Coverage ---

      case "start_js_coverage": {
        const tabId = await requireDebuggerTab();
        if (jsCoverageActive) return { type: "response", id, success: false, error: "JS coverage already active" };
        await sendCDPCommand({ tabId: tabId }, "Profiler.startPreciseCoverage", {
          callCount: true,
          detailed: !!(command as any).detailed,
        });
        jsCoverageActive = true;
        return { type: "response", id, success: true, data: { action: "start_js_coverage", detailed: !!(command as any).detailed } };
      }

      case "stop_js_coverage": {
        const tabId = await requireDebuggerTab();
        if (!jsCoverageActive) return { type: "response", id, success: false, error: "JS coverage not active" };
        let jsCovResult: { result: Array<{ scriptId: string; url: string; functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }>; isBlockCoverage: boolean }> }> } = { result: [] };
        try {
          jsCovResult = await sendCDPCommand<typeof jsCovResult>(
            { tabId: tabId }, "Profiler.takePreciseCoverage", {}
          );
          await sendCDPCommand({ tabId: tabId }, "Profiler.stopPreciseCoverage", {});
        } finally {
          jsCoverageActive = false;
        }
        // Summarize per-script coverage (raw data can be very large)
        const scripts = (jsCovResult.result ?? []).map((script) => {
          const functions = script.functions ?? [];
          let totalBytes = 0;
          let usedBytes = 0;
          for (const fn of functions) {
            for (const range of fn.ranges ?? []) {
              const size = range.endOffset - range.startOffset;
              totalBytes += size;
              if (range.count > 0) usedBytes += size;
            }
          }
          return {
            scriptId: script.scriptId,
            url: script.url,
            functionCount: functions.length,
            totalBytes,
            usedBytes,
            coveragePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
          };
        }).filter((s) => s.url); // Filter out eval scripts without URL
        const jsTotalBytes = scripts.reduce((sum, s) => sum + s.totalBytes, 0);
        const jsTotalUsed = scripts.reduce((sum, s) => sum + s.usedBytes, 0);
        return { type: "response", id, success: true, data: {
          scripts,
          summary: {
            totalScripts: scripts.length,
            totalBytes: jsTotalBytes,
            usedBytes: jsTotalUsed,
            overallCoveragePercent: jsTotalBytes > 0 ? Math.round((jsTotalUsed / jsTotalBytes) * 100) : 0,
          },
        } };
      }

      case "get_computed_style": {
        const tabId = await requireDebuggerTab();
        const selector = command.selector as string;
        const filterProps = Array.isArray(command.properties) && command.properties.length > 0
          ? (command.properties as string[]).map(p => p.toLowerCase()) : null;

        // Try CDP CSS domain first
        try {
          const cssNodeId = await resolveNodeId(tabId, selector);
          const styleResult = await sendCDPCommand<{ computedStyle: Array<{ name: string; value: string }> }>(
            { tabId: tabId }, "CSS.getComputedStyleForNode", { nodeId: cssNodeId }
          );
          let styles = styleResult.computedStyle ?? [];
          if (filterProps) {
            const filter = new Set(filterProps);
            styles = styles.filter((s) => filter.has(s.name.toLowerCase()));
          }
          const styleObj = Object.fromEntries(styles.map((s) => [s.name, s.value]));
          return { type: "response", id, success: true, data: { style: styleObj, propertyCount: styles.length } };
        } catch {
          // Fallback: Runtime.evaluate with window.getComputedStyle
          const propsJson = filterProps ? JSON.stringify(filterProps) : "null";
          const evalResult = await sendCDPCommand<{ result: { value: string } }>(
            { tabId: tabId }, "Runtime.evaluate",
            buildEvalParams(tabId, `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return JSON.stringify({ error: "Element not found" });
              const cs = window.getComputedStyle(el);
              const filter = ${propsJson};
              const obj = {};
              if (filter) { for (const p of filter) obj[p] = cs.getPropertyValue(p); }
              else { for (let i = 0; i < cs.length; i++) { const n = cs[i]; obj[n] = cs.getPropertyValue(n); } }
              return JSON.stringify({ style: obj, count: Object.keys(obj).length });
            })()`)
          );
          const parsed = JSON.parse(evalResult?.result?.value ?? "{}");
          if (parsed.error) return { type: "response", id, success: false, error: parsed.error };
          return { type: "response", id, success: true, data: { style: parsed.style, propertyCount: parsed.count, fallback: true } };
        }
      }

      case "detect_fonts": {
        const tabId = await requireDebuggerTab();
        const fontSelectors = Array.isArray(command.selectors) && command.selectors.length > 0
          ? (command.selectors as string[]) : ["body", "h1", "h2", "h3", "p", "a", "button", "input", "span"];
        const selectorsJson = JSON.stringify(fontSelectors);
        const fontExpr = `(async () => {
          await document.fonts.ready;
          const providerPatterns = [
            { pattern: /fonts\\.googleapis\\.com|fonts\\.gstatic\\.com/, name: "google" },
            { pattern: /use\\.typekit\\.net|p\\.typekit\\.net/, name: "adobe" },
            { pattern: /fast\\.fonts\\.net|fnt\\.fonts\\.com/, name: "monotype" },
            { pattern: /font-?awesome|fontawesome/, name: "fontawesome" },
            { pattern: /fonts\\.bunny\\.net/, name: "bunny" },
          ];
          function detectProvider(src) {
            if (!src) return "local";
            for (const { pattern, name } of providerPatterns) {
              if (pattern.test(src)) return name;
            }
            if (src.includes("url(")) return "self-hosted";
            return "local";
          }
          function detectFormat(src) {
            if (!src) return "unknown";
            const fmtMatch = src.match(/format\\(["']?([^"')]+)["']?\\)/);
            if (fmtMatch) return fmtMatch[1];
            const extMatch = src.match(/\\.(woff2|woff|ttf|otf|eot|svg)([?"#]|$)/i);
            if (extMatch) return extMatch[1].toLowerCase();
            return "unknown";
          }
          const fontFaceRules = [];
          for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch { continue; }
            for (const rule of rules) {
              if (rule.type === 5) {
                const s = rule.style;
                const src = s.getPropertyValue("src");
                fontFaceRules.push({
                  family: s.getPropertyValue("font-family").replace(/['"]/g, ""),
                  src: src,
                  weight: s.getPropertyValue("font-weight") || "400",
                  style: s.getPropertyValue("font-style") || "normal",
                  display: s.getPropertyValue("font-display") || "",
                  provider: detectProvider(src),
                  format: detectFormat(src),
                });
              }
            }
          }
          const rulesByFamily = {};
          for (const r of fontFaceRules) {
            const key = r.family.toLowerCase();
            if (!rulesByFamily[key]) rulesByFamily[key] = [];
            rulesByFamily[key].push(r);
          }
          const fonts = [];
          const providers = {};
          const formats = {};
          let loaded = 0, failed = 0;
          for (const ff of document.fonts) {
            const familyKey = ff.family.replace(/['"]/g, "").toLowerCase();
            const matchingRules = rulesByFamily[familyKey] || [];
            const ruleSrc = matchingRules.length > 0 ? matchingRules[0].src : "";
            const src = ruleSrc || "";
            const provider = detectProvider(src);
            const format = detectFormat(src);
            providers[provider] = (providers[provider] || 0) + 1;
            formats[format] = (formats[format] || 0) + 1;
            if (ff.status === "loaded") loaded++;
            else if (ff.status === "error") failed++;
            fonts.push({
              family: ff.family,
              weight: ff.weight,
              style: ff.style,
              stretch: ff.stretch,
              status: ff.status,
              unicodeRange: ff.unicodeRange,
              source: src,
              format: format,
              provider: provider,
            });
          }
          const usage = {};
          const sels = ${selectorsJson};
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const cs = window.getComputedStyle(el);
            usage[sel] = {
              fontFamily: cs.fontFamily,
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
            };
          }
          return JSON.stringify({
            fonts,
            fontFaceRules,
            usage,
            summary: {
              totalFonts: fonts.length,
              loadedFonts: loaded,
              failedFonts: failed,
              providers,
              formats,
            },
          });
        })()`;
        try {
          const evalResult = await sendCDPCommand<{ result: { value: string } }>(
            { tabId: tabId }, "Runtime.evaluate",
            buildEvalParams(tabId, fontExpr, { awaitPromise: true })
          );
          const parsed = JSON.parse(evalResult?.result?.value ?? "{}");
          return { type: "response", id, success: true, data: parsed };
        } catch (err) {
          return { type: "response", id, success: false, error: `detect_fonts failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case "force_pseudo_state": {
        const tabId = await requireDebuggerTab();
        try {
          const pseudoNodeId = await resolveNodeId(tabId, command.selector as string);
          await sendCDPCommand({ tabId: tabId }, "CSS.forcePseudoState", {
            nodeId: pseudoNodeId,
            forcedPseudoClasses: command.states,
          });
          return { type: "response", id, success: true, data: { forcedStates: command.states } };
        } catch {
          return { type: "response", id, success: false, error: "CSS domain unavailable via chrome.debugger — force_pseudo_state is not supported from extensions. Use browser_evaluate to toggle classes instead." };
        }
      }

      // --- AC-24: Target & Session Management ---

      case "get_targets": {
        const tabId = await requireDebuggerTab();
        const gtResult = await sendCDPCommand<{ targetInfos: any[] }>({ tabId: tabId }, "Target.getTargets", {});
        let targets = (gtResult.targetInfos ?? []).map((t: any) => ({
          targetId: t.targetId,
          type: t.type,
          title: t.title,
          url: t.url,
          attached: t.attached,
          browserContextId: t.browserContextId,
        }));
        if (command.targetType) {
          targets = targets.filter((t: any) => t.type === command.targetType);
        }
        return { type: "response", id, success: true, data: { targets } };
      }

      case "attach_to_target": {
        const tabId = await requireDebuggerTab();
        const atResult = await sendCDPCommand<{ sessionId: string }>({ tabId: tabId }, "Target.attachToTarget", {
          targetId: command.targetId,
          flatten: true,
        });
        const sessionId = atResult.sessionId;
        targetSessions.set(command.targetId as string, {
          targetId: command.targetId as string,
          sessionId,
          type: "unknown",
          title: "",
          url: "",
        });
        return { type: "response", id, success: true, data: { targetId: command.targetId, sessionId } };
      }

      case "create_browser_context": {
        const tabId = await requireDebuggerTab();

        if (command.dispose) {
          await sendCDPCommand({ tabId: tabId }, "Target.disposeBrowserContext", {
            browserContextId: command.dispose,
          });
          browserContexts.delete(command.dispose as string);
          return { type: "response", id, success: true, data: { disposed: command.dispose } };
        } else {
          const cbcResult = await sendCDPCommand<{ browserContextId: string }>({ tabId: tabId }, "Target.createBrowserContext", {
            disposeOnDetach: true,
          });
          const contextId = cbcResult.browserContextId;
          browserContexts.add(contextId);
          return { type: "response", id, success: true, data: { browserContextId: contextId } };
        }
      }

      // AC-25: Memory & Heap Analysis
      case "get_dom_counters": {
        const tabId = await requireDebuggerTab();
        try {
          const counters = await sendCDPCommand<{ documents: number; nodes: number; jsEventListeners: number }>(
            { tabId: tabId }, "Memory.getDOMCounters", {}
          );
          return { type: "response", id, success: true, data: {
            documents: counters.documents,
            nodes: counters.nodes,
            jsEventListeners: counters.jsEventListeners,
          }};
        } catch {
          // Fallback: Runtime.evaluate with performance.memory + DOM tree walk
          const evalResult = await sendCDPCommand<{ result: { value: string } }>(
            { tabId: tabId }, "Runtime.evaluate",
            buildEvalParams(tabId, `JSON.stringify({
              nodes: document.querySelectorAll("*").length,
              documents: document.querySelectorAll("iframe").length + 1,
              jsHeapSizeUsed: performance.memory ? performance.memory.usedJSHeapSize : null,
              jsHeapSizeTotal: performance.memory ? performance.memory.totalJSHeapSize : null,
              jsHeapSizeLimit: performance.memory ? performance.memory.jsHeapSizeLimit : null,
            })`)
          );
          const parsed = JSON.parse(evalResult?.result?.value ?? "{}");
          return { type: "response", id, success: true, data: { ...parsed, fallback: true } };
        }
      }

      // AC-25: Force GC
      case "force_gc": {
        const tabId = await requireDebuggerTab();

        try {
          // HeapProfiler.collectGarbage — V8-level GC
          await sendCDPCommand({ tabId: tabId }, "HeapProfiler.collectGarbage", {});

          // Return post-GC DOM counters for reference
          let postGcCounters: { documents?: number; nodes?: number; jsEventListeners?: number } = {};
          try {
            postGcCounters = await sendCDPCommand<{ documents: number; nodes: number; jsEventListeners: number }>(
              { tabId: tabId }, "Memory.getDOMCounters", {}
            );
          } catch { /* Memory domain may also be unavailable */ }
          return { type: "response", id, success: true, data: {
            gcCompleted: true,
            postGcCounters: {
              documents: postGcCounters.documents ?? null,
              nodes: postGcCounters.nodes ?? null,
              jsEventListeners: postGcCounters.jsEventListeners ?? null,
            },
          }};
        } catch {
          return { type: "response", id, success: false, error: "HeapProfiler domain unavailable via chrome.debugger — force GC is not possible from extensions" };
        }
      }

      // AC-25: Heap Snapshot
      case "take_heap_snapshot": {
        const tabId = await requireDebuggerTab();

        const chunks: string[] = [];
        const HEAP_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024; // 50MB
        let heapTotalSize = 0;
        let heapSizeExceeded = false;

        // Register temporary event listener to collect snapshot chunks
        // Review fix: guard params?.chunk to prevent undefined in array
        const chunkListener = (source: chrome.debugger.Debuggee, method: string, params: any) => {
          if (source.tabId === tabId && method === "HeapProfiler.addHeapSnapshotChunk" && params?.chunk) {
            heapTotalSize += params.chunk.length;
            if (heapTotalSize > HEAP_SNAPSHOT_MAX_BYTES) {
              heapSizeExceeded = true;
              return; // Stop collecting chunks
            }
            chunks.push(params.chunk);
          }
        };
        chrome.debugger.onEvent.addListener(chunkListener);

        try {
          await sendCDPCommand({ tabId }, "HeapProfiler.takeHeapSnapshot", {
            reportProgress: false,
            treatGlobalObjectsAsRoots: true,
          }, 0, 25000); // 25s timeout for snapshot collection

          // Abort if snapshot exceeded size cap
          if (heapSizeExceeded) {
            return { type: "response", id, success: false, error: `Heap snapshot exceeded ${HEAP_SNAPSHOT_MAX_BYTES / (1024 * 1024)}MB limit (collected ${Math.round(heapTotalSize / (1024 * 1024))}MB). Use Chrome DevTools for large heap analysis.` };
          }

          // Review fix: distinguish empty collection from parsing failure
          if (chunks.length === 0) {
            return { type: "response", id, success: false, error: "No snapshot chunks received" };
          }

          // Parse snapshot metadata — full snapshot is too large for MCP response
          const snapshotStr = chunks.join("");
          try {
            const snapshot = JSON.parse(snapshotStr);
            const meta = snapshot.snapshot?.meta ?? {};
            return { type: "response", id, success: true, data: {
              summary: {
                totalNodes: meta.node_count ?? 0,
                totalEdges: meta.edge_count ?? 0,
                snapshotSizeBytes: snapshotStr.length,
              },
            }};
          } catch {
            // Parsing failed — return raw size info
            // Review fix: defensive reduce in case of non-string elements
            const totalSize = chunks.reduce((sum, c) => sum + (typeof c === "string" ? c.length : 0), 0);
            return { type: "response", id, success: true, data: {
              summary: {
                snapshotSizeBytes: totalSize,
                chunkCount: chunks.length,
                note: "Snapshot collected but too large to parse inline",
              },
            }};
          }
        } finally {
          chrome.debugger.onEvent.removeListener(chunkListener);
        }
      }

      // AC-26: Overlay & Visual Debug
      case "highlight_element": {
        const tabId = await requireDebuggerTab();

        if (!command.selector) {
          // Clear highlight — try Overlay first, fall back to removing injected div
          try {
            await sendCDPCommand({ tabId: tabId }, "Overlay.enable", {});
            await sendCDPCommand({ tabId: tabId }, "Overlay.hideHighlight", {});
          } catch {
            await sendCDPCommand({ tabId: tabId }, "Runtime.evaluate",
              buildEvalParams(tabId, `document.getElementById("__crawlio_highlight")?.remove()`)
            );
          }
          return { type: "response", id, success: true, data: { cleared: true } };
        }

        try {
          await sendCDPCommand({ tabId: tabId }, "Overlay.enable", {});
          const highlightNodeId = await resolveNodeId(tabId, command.selector as string);
          const rgba = parseOverlayColor(command.color as string | undefined);
          await sendCDPCommand({ tabId: tabId }, "Overlay.highlightNode", {
            highlightConfig: {
              showInfo: true,
              showStyles: true,
              contentColor: rgba,
              paddingColor: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a * 0.5 },
              borderColor: { r: rgba.r, g: rgba.g, b: rgba.b, a: 1 },
              marginColor: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a * 0.3 },
            },
            nodeId: highlightNodeId,
          });
          return { type: "response", id, success: true, data: { selector: command.selector } };
        } catch {
          // Fallback: inject absolute-positioned highlight div via Runtime.evaluate
          const color = /^#?[0-9a-fA-F]{6}$/.test(command.color as string) ? command.color : "#6fa8dc";
          const evalResult = await sendCDPCommand<{ result: { value: string } }>(
            { tabId: tabId }, "Runtime.evaluate",
            buildEvalParams(tabId, `(() => {
              const el = document.querySelector(${JSON.stringify(command.selector)});
              if (!el) return JSON.stringify({ error: "Element not found" });
              const rect = el.getBoundingClientRect();
              let overlay = document.getElementById("__crawlio_highlight");
              if (!overlay) { overlay = document.createElement("div"); overlay.id = "__crawlio_highlight"; document.body.appendChild(overlay); }
              Object.assign(overlay.style, {
                position: "fixed", zIndex: "2147483647", pointerEvents: "none",
                border: "2px solid ${color}", background: "${color}33",
                top: rect.top + "px", left: rect.left + "px",
                width: rect.width + "px", height: rect.height + "px",
                transition: "all 0.2s ease",
              });
              return JSON.stringify({ selector: ${JSON.stringify(command.selector)}, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } });
            })()`)
          );
          const parsed = JSON.parse(evalResult?.result?.value ?? "{}");
          if (parsed.error) return { type: "response", id, success: false, error: parsed.error };
          return { type: "response", id, success: true, data: { ...parsed, fallback: true } };
        }
      }

      case "show_layout_shifts": {
        const tabId = await requireDebuggerTab();
        try {
          await sendCDPCommand({ tabId: tabId }, "Overlay.enable", {});
          await sendCDPCommand({ tabId: tabId }, "Overlay.setShowLayoutShiftRegions", { result: command.enabled });
          return { type: "response", id, success: true, data: { layoutShiftsVisible: command.enabled } };
        } catch {
          return { type: "response", id, success: false, error: "Overlay domain unavailable via chrome.debugger — layout shift visualization is not supported from extensions" };
        }
      }

      case "show_paint_rects": {
        const tabId = await requireDebuggerTab();
        try {
          await sendCDPCommand({ tabId: tabId }, "Overlay.enable", {});
          await sendCDPCommand({ tabId: tabId }, "Overlay.setShowPaintRects", { result: command.enabled });
          return { type: "response", id, success: true, data: { paintRectsVisible: command.enabled } };
        } catch {
          return { type: "response", id, success: false, error: "Overlay domain unavailable via chrome.debugger — paint rect visualization is not supported from extensions" };
        }
      }

      case "browser_fill_form": {
        const fields = command.fields as Array<{ ref: string; type?: string; value: string }>;
        if (!fields || !Array.isArray(fields) || fields.length === 0) throw new Error("fields array is required");
        const tab = await getConnectedTab();
        await ensureTabFocused(tab.id!);
        const results: Array<{ ref: string; status: string }> = [];

        for (const field of fields) {
          const fieldType = field.type || "textbox";
          const backendNodeId = tabAriaState.get(tab.id!)?.refMap.get(field.ref);
          if (backendNodeId === undefined) {
            results.push({ ref: field.ref, status: "error: ref not found" });
            continue;
          }

          try {
            if (fieldType === "textbox" || fieldType === "searchbox") {
              // Focus the element via click, then insert text
              const { x, y } = await resolveAriaRef(tab.id!, field.ref);
              await dispatchClick(tab.id!, x, y);
              // Select all existing text and replace
              await dispatchKey(tab.id!, "a", 4); // Ctrl+A / Meta+A
              await sendCDPCommand({ tabId: tab.id! }, "Input.insertText", { text: field.value }, 0);
              results.push({ ref: field.ref, status: "filled" });
            } else if (fieldType === "checkbox" || fieldType === "radio") {
              // Click to toggle
              const { x, y } = await resolveAriaRef(tab.id!, field.ref);
              await dispatchClick(tab.id!, x, y);
              results.push({ ref: field.ref, status: "clicked" });
            } else if (fieldType === "combobox") {
              // Click to open, type to filter, then click option
              const { x, y } = await resolveAriaRef(tab.id!, field.ref);
              await dispatchClick(tab.id!, x, y);
              await sendCDPCommand({ tabId: tab.id! }, "Input.insertText", { text: field.value }, 0);
              results.push({ ref: field.ref, status: "filled" });
            } else {
              results.push({ ref: field.ref, status: `error: unknown type '${fieldType}'` });
            }
          } catch (err) {
            results.push({ ref: field.ref, status: `error: ${err instanceof Error ? err.message : String(err)}` });
          }
        }

        await waitForStableDOM(tab.id!);
        let snapshot: string | undefined;
        try { snapshot = (await generateAriaSnapshot(tab.id!)).snapshot; } catch { /* snapshot optional */ }
        return {
          type: "response", id, success: true,
          data: { action: "fill_form", fields: results, snapshot },
        };
      }

      case "browser_snapshot": {
        const tab = await getConnectedTab();
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const snapshotOpts: SnapshotOptions = {};
        if (command.interactive === true) snapshotOpts.interactive = true;
        if (command.compact === true) snapshotOpts.compact = true;
        if (typeof command.maxDepth === "number") snapshotOpts.maxDepth = Math.max(0, Math.min(command.maxDepth, 50));
        if (typeof command.selector === "string" && command.selector) snapshotOpts.selector = command.selector;
        const result = await generateAriaSnapshot(tab.id!, snapshotOpts);
        // Cache snapshot for diff_snapshot auto-compare
        getAriaState(tab.id!).lastSnapshot = result.snapshot;
        return { type: "response", id, success: true, data: { snapshot: result.snapshot, estimatedTokens: result.estimatedTokens } };
      }

      case "diff_snapshot": {
        const tab = await getConnectedTab();
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const currentResult = await generateAriaSnapshot(tab.id!);
        const currentSnapshot = currentResult.snapshot;
        const ariaState = getAriaState(tab.id!);
        const baseline = typeof command.baseline === "string" ? command.baseline : ariaState.lastSnapshot;
        // Update cache with current snapshot
        ariaState.lastSnapshot = currentSnapshot;
        if (!baseline) {
          return { type: "response", id, success: false, error: "No baseline snapshot available. Take a browser_snapshot first, or provide a baseline string." };
        }
        return { type: "response", id, success: true, data: { baseline, current: currentSnapshot } };
      }

      case "wait_for_network_idle": {
        const timeout = Math.min(Number(command.timeout) || 15000, 30000);
        const idleTime = Math.min(Number(command.idleTime) || 500, 5000);
        const start = Date.now();

        const result = await new Promise<{ status: string; elapsed: number; pendingAtTimeout?: number }>((resolve) => {
          let lastActivity = Date.now();

          const check = () => {
            const now = Date.now();
            const pending = Array.from(networkEntries.values()).filter(e => e._startTime !== undefined).length;

            if (pending === 0 && now - lastActivity >= idleTime) {
              resolve({ status: "idle", elapsed: now - start });
              return;
            }
            if (pending > 0) lastActivity = now;
            if (now - start >= timeout) {
              resolve({ status: "timeout", elapsed: now - start, pendingAtTimeout: pending });
              return;
            }
            setTimeout(check, 100);
          };
          // Give the page a moment to start issuing requests
          setTimeout(check, 200);
        });

        return { type: "response", id, success: true, data: result };
      }

      case "parse_tracking_pixels": {
        const entries = Array.from(networkEntries.values()).filter(e => e.url && !e._startTime);
        const events: Array<Record<string, unknown>> = [];
        const unrecognizedTrackingUrls: string[] = [];
        const seenUnrecognized = new Set<string>();

        for (const entry of entries) {
          let matched = false;
          for (const config of Object.values(TRACKER_VENDORS)) {
            for (const pattern of config.urlPatterns) {
              if (pattern.test(entry.url)) {
                matched = true;
                let parsed: URL | undefined;
                try { parsed = new URL(entry.url); } catch { break; }
                const pixelId = config.extractPixelId(parsed) || "unknown";
                const eventName = config.extractEventName(parsed) || "unknown";
                const parameters = config.extractParameters(parsed);
                const eventType = config.standardEvents.includes(eventName) ? "standard" : "custom";
                events.push({
                  vendor: config.vendor,
                  pixelId,
                  eventName,
                  eventType,
                  parameters,
                  url: entry.url,
                  method: entry.method,
                  timestamp: Date.now(),
                  status: entry.status > 0 ? entry.status : undefined,
                  requestUrl: entry.url,
                });
                break;
              }
            }
            if (matched) break;
          }
          if (!matched && !seenUnrecognized.has(entry.url)) {
            for (const hp of TRACKING_HEURISTIC_PATTERNS) {
              if (hp.test(entry.url)) {
                seenUnrecognized.add(entry.url);
                unrecognizedTrackingUrls.push(entry.url);
                break;
              }
            }
          }
        }

        // Group by vendor + pixelId
        const pixelMap = new Map<string, Record<string, unknown>>();
        const vendorSet = new Set<string>();
        for (const event of events) {
          vendorSet.add(event.vendor as string);
          const key = `${event.vendor}:${event.pixelId}`;
          let summary = pixelMap.get(key);
          if (!summary) {
            summary = {
              vendor: event.vendor,
              pixelId: event.pixelId,
              eventCount: 0,
              events: [] as Record<string, unknown>[],
              uniqueEventNames: [] as string[],
            };
            pixelMap.set(key, summary);
          }
          (summary.events as Record<string, unknown>[]).push(event);
          summary.eventCount = (summary.eventCount as number) + 1;
          const names = summary.uniqueEventNames as string[];
          if (!names.includes(event.eventName as string)) {
            names.push(event.eventName as string);
          }
        }

        return {
          type: "response",
          id,
          success: true,
          data: {
            totalPixelFires: events.length,
            vendors: Array.from(vendorSet),
            pixels: Array.from(pixelMap.values()),
            events,
            unrecognizedTrackingUrls,
          },
        };
      }

      case "inspect_datalayer": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        await CDP_YIELD();
        const dlResult = await cdpExecuteFunction<{
          facebook: { loaded: boolean; version: string | null; pixelIds: string[]; queueLength: number } | null;
          ga4: { dataLayerLength: number; events: string[]; gtag: boolean; gaLegacy: boolean } | null;
          gtm: { containers: string[] } | null;
          tiktok: { loaded: boolean; queueLength: number } | null;
        }>(tab.id!, inspectDataLayer);
        return { type: "response", id, success: true, data: dlResult || { facebook: null, ga4: null, gtm: null, tiktok: null } };
      }

      case "inject_serp_overlay": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        if (await checkSiteOptOut(tab.id!)) {
          return { type: "response", id, success: false, error: OPT_OUT_ERROR, problem: "opt_out" };
        }
        const widgets = (command.widgets as string[]) || ["badge", "header", "sidebar"];
        const query = (command.query as string) || "";
        const data = (command.data as Record<string, unknown>) || {};
        const result = await cdpExecuteFunction<{ injected: boolean; widgetCount: number; query: string }>(
          tab.id!, injectSerpOverlay, [{ widgets, query, css: SERP_OVERLAY_CSS, data }]
        );
        if (!result) {
          return { type: "response", id, success: false, error: "Failed to inject SERP overlay — page may have navigated" };
        }
        return { type: "response", id, success: true, data: result };
      }

      case "clear_serp_overlay": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const result = await cdpExecuteFunction<{ cleared: boolean; reason?: string }>(
          tab.id!, removeSerpOverlay, []
        );
        return { type: "response", id, success: true, data: result || { cleared: false, reason: "CDP evaluate failed" } };
      }

      case "get_enrichment": {
        const queryUrl = command.url as string | undefined;
        if (queryUrl) {
          const entry = accumulator.get(queryUrl);
          if (!entry) {
            return { type: "response", id, success: true, data: null };
          }
          return { type: "response", id, success: true, data: {
            url: entry.url,
            title: entry.title,
            framework: entry.framework,
            capturedAt: entry.capturedAt,
            networkRequests: entry.networkRequests?.length ?? 0,
            consoleLogs: entry.consoleLogs?.length ?? 0,
            hasDomSnapshot: !!entry.domSnapshotJSON,
            hasScreenshot: !!entry.screenshot,
          }};
        }
        // No URL — return all enrichment summaries
        const all = accumulator.getAll().map(e => ({
          url: e.url,
          title: e.title,
          framework: e.framework,
          capturedAt: e.capturedAt,
        }));
        return { type: "response", id, success: true, data: { entries: all, count: all.length } };
      }

      case "compare_raw_rendered": {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);

        // 1. Find the main document request in networkEntries
        let rawHtml = "";
        let rawSource = "none";
        const pageUrl = tab.url || "";

        // Try Network.getResponseBody for the document request
        for (const [reqId, entry] of networkEntries) {
          if (entry.resourceType === "Document" && entry.url === pageUrl) {
            try {
              const resp = await sendCDPCommand<{ body: string; base64Encoded: boolean }>(
                { tabId: tab.id! }, "Network.getResponseBody", { requestId: reqId }
              );
              if (!resp.base64Encoded && resp.body) {
                rawHtml = resp.body;
                rawSource = "network-cache";
              }
            } catch { /* response body evicted — fall through to fetch */ }
            break;
          }
        }

        // Fallback: fetch in page context (same-origin, inherits cookies/auth)
        if (!rawHtml) {
          try {
            const fetchResult = await sendCDPCommand<{ result: { type: string; value?: string } }>(
              { tabId: tab.id! }, "Runtime.evaluate", {
                expression: `fetch(location.href, { credentials: 'include' }).then(r => r.text())`,
                awaitPromise: true,
                returnByValue: true,
              }
            );
            if (fetchResult.result?.value) {
              rawHtml = fetchResult.result.value;
              rawSource = "fetch-in-page";
            }
          } catch { /* fetch failed */ }
        }

        if (!rawHtml) {
          return { type: "response", id, success: false, data: { error: "Could not retrieve raw HTML. Ensure network capture was active when the page loaded, or the page allows same-origin fetch." } };
        }

        // 2. Capture rendered DOM + SEO elements via Runtime.evaluate
        const renderResult = await sendCDPCommand<{ result: { type: string; value?: unknown } }>(
          { tabId: tab.id! }, "Runtime.evaluate", {
            expression: `(() => {
  const renderedHtml = document.documentElement.outerHTML;
  const title = document.title || null;
  const descEl = document.querySelector('meta[name="description"]');
  const metaDescription = descEl ? descEl.getAttribute("content") : null;
  const canEl = document.querySelector('link[rel="canonical"]');
  const canonical = canEl ? canEl.getAttribute("href") : null;
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(h => ({
    level: parseInt(h.tagName.substring(1), 10),
    text: (h.textContent || "").trim().substring(0, 200)
  }));
  const linkCount = document.querySelectorAll("a[href]").length;
  const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  const structuredData = jsonLdScripts.map(s => { try { return JSON.parse(s.textContent || ""); } catch { return null; } }).filter(Boolean);
  const bodyText = (document.body?.innerText || "").trim();
  return {
    renderedHtml,
    seoElements: {
      title,
      metaDescription,
      canonical,
      headings,
      linkCount,
      structuredData,
      contentLength: renderedHtml.length,
      textLength: bodyText.length,
    }
  };
})()`,
            returnByValue: true,
          }
        );

        const rendered = (renderResult.result?.value || {}) as Record<string, unknown>;
        const renderedHtml = (rendered.renderedHtml as string) || "";
        const renderedSeo = (rendered.seoElements || {}) as Record<string, unknown>;

        // 3. Parse SEO elements from raw HTML (regex-based, no DOM in service worker)
        const rawTitle = (rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim() || null;
        const rawDescMatch = rawHtml.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
          || rawHtml.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
        const rawMetaDescription = rawDescMatch?.[1] || null;
        const rawCanMatch = rawHtml.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)
          || rawHtml.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
        const rawCanonical = rawCanMatch?.[1] || null;
        const rawHeadings: Array<{ level: number; text: string }> = [];
        const headingRe = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
        let hMatch: RegExpExecArray | null;
        while ((hMatch = headingRe.exec(rawHtml)) !== null) {
          rawHeadings.push({ level: parseInt(hMatch[1].substring(1), 10), text: hMatch[2].replace(/<[^>]*>/g, "").trim().substring(0, 200) });
        }
        const rawLinkCount = (rawHtml.match(/<a\s[^>]*href=/gi) || []).length;
        const rawJsonLdRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        const rawStructuredData: unknown[] = [];
        let jMatch: RegExpExecArray | null;
        while ((jMatch = rawJsonLdRe.exec(rawHtml)) !== null) {
          try { rawStructuredData.push(JSON.parse(jMatch[1])); } catch { /* malformed JSON-LD */ }
        }
        const rawTextLength = rawHtml.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().length;

        const rawSeo = {
          title: rawTitle,
          metaDescription: rawMetaDescription,
          canonical: rawCanonical,
          headings: rawHeadings,
          linkCount: rawLinkCount,
          structuredData: rawStructuredData,
          contentLength: rawHtml.length,
          textLength: rawTextLength,
        };

        // 4. Compute differences
        const differences: Array<{ element: string; raw: unknown; rendered: unknown; impact: string; description: string }> = [];

        if (rawSeo.title !== renderedSeo.title) {
          differences.push({ element: "title", raw: rawSeo.title, rendered: renderedSeo.title, impact: "high", description: rawSeo.title ? "Title changed by JavaScript" : "Title set entirely by JavaScript" });
        }
        if (rawSeo.metaDescription !== renderedSeo.metaDescription) {
          differences.push({ element: "metaDescription", raw: rawSeo.metaDescription, rendered: renderedSeo.metaDescription, impact: "high", description: rawSeo.metaDescription ? "Meta description changed by JavaScript" : "Meta description set entirely by JavaScript" });
        }
        if (rawSeo.canonical !== renderedSeo.canonical) {
          differences.push({ element: "canonical", raw: rawSeo.canonical, rendered: renderedSeo.canonical, impact: "high", description: rawSeo.canonical ? "Canonical URL changed by JavaScript" : "Canonical URL set entirely by JavaScript" });
        }

        const renderedHeadings = (renderedSeo.headings as Array<{ level: number; text: string }>) || [];
        if (rawSeo.headings.length !== renderedHeadings.length) {
          differences.push({ element: "headings", raw: rawSeo.headings.length, rendered: renderedHeadings.length, impact: "medium", description: `Heading count changed: ${rawSeo.headings.length} raw → ${renderedHeadings.length} rendered` });
        }

        const renderedLinkCount = (renderedSeo.linkCount as number) || 0;
        if (Math.abs(rawSeo.linkCount - renderedLinkCount) > 5) {
          differences.push({ element: "links", raw: rawSeo.linkCount, rendered: renderedLinkCount, impact: "medium", description: `Link count changed: ${rawSeo.linkCount} raw → ${renderedLinkCount} rendered` });
        }

        const renderedSD = (renderedSeo.structuredData as unknown[]) || [];
        if (rawSeo.structuredData.length !== renderedSD.length) {
          differences.push({ element: "structuredData", raw: rawSeo.structuredData.length, rendered: renderedSD.length, impact: "high", description: rawSeo.structuredData.length === 0 ? "Structured data injected entirely by JavaScript" : `Structured data count changed: ${rawSeo.structuredData.length} raw → ${renderedSD.length} rendered` });
        }

        const renderedContentLength = (renderedSeo.contentLength as number) || 0;
        const sizeDelta = renderedContentLength - rawSeo.contentLength;
        const sizeRatio = rawSeo.contentLength > 0 ? Math.abs(sizeDelta) / rawSeo.contentLength : 0;
        if (sizeRatio > 0.3) {
          differences.push({ element: "contentSize", raw: rawSeo.contentLength, rendered: renderedContentLength, impact: "low", description: `HTML size changed by ${Math.round(sizeRatio * 100)}%: ${rawSeo.contentLength} → ${renderedContentLength} bytes` });
        }

        // 5. Assess risk
        const hasHighImpact = differences.some(d => d.impact === "high");
        const hasMediumImpact = differences.some(d => d.impact === "medium");
        const riskLevel = hasHighImpact ? "high" : hasMediumImpact ? "medium" : "low";
        const jsDependent = differences.length > 0;

        // Cap raw HTML to 100KB for response size
        const MAX_HTML = 100000;
        const cappedRawHtml = rawHtml.length > MAX_HTML ? rawHtml.substring(0, MAX_HTML) : rawHtml;
        const cappedRenderedHtml = renderedHtml.length > MAX_HTML ? renderedHtml.substring(0, MAX_HTML) : renderedHtml;

        return { type: "response", id, success: true, data: {
          url: pageUrl,
          rawSource,
          raw: { html: cappedRawHtml, seoElements: rawSeo, size: rawHtml.length },
          rendered: { html: cappedRenderedHtml, seoElements: renderedSeo, size: renderedHtml.length },
          differences,
          jsDependent,
          riskLevel,
        }};
      }

      default:
        return { type: "response", id, success: false, error: `Unknown command: ${type}` };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const response: Record<string, unknown> = { type: "response", id, success: false, error: msg };
    if (e instanceof PermissionError) {
      response.permission_required = true;
      response.missing = e.missing;
      response.suggestion = e.suggestion;
      response.problem = "permission_denied";
    } else {
      response.problem = classifyProblem(e, msg);
    }
    return response;
  }
}

// --- ARIA Snapshot Engine ---

const ARIA_INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio",
  "combobox", "listbox", "slider", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option",
  "switch", "searchbox", "spinbutton", "treeitem",
]);

const ARIA_LANDMARK_ROLES = new Set([
  "heading", "img", "navigation", "main", "banner",
  "contentinfo", "complementary", "form", "region",
]);

const ARIA_CONTENT_ROLES = new Set([
  "heading", "cell", "gridcell", "columnheader", "rowheader",
  "listitem", "article", "region", "main", "navigation",
]);

const ARIA_STRUCTURAL_ROLES = new Set([
  "generic", "group", "list", "table", "row", "rowgroup",
  "grid", "treegrid", "menu", "menubar", "toolbar",
  "tablist", "tree", "directory", "document", "application",
  "presentation", "none",
]);

const SNAPSHOT_MAX_NODES = 15000;

interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  selector?: string;
}

interface RoleNameTracker {
  counts: Map<string, number>;
  refsByKey: Map<string, string[]>;
  getKey(role: string, name: string): string;
  track(role: string, name: string, ref: string): number;
  getDuplicateKeys(): Set<string>;
}

function createRoleNameTracker(): RoleNameTracker {
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();
  return {
    counts,
    refsByKey,
    getKey(role: string, name: string): string {
      return `${role}:${name}`;
    },
    track(role: string, name: string, ref: string): number {
      const key = this.getKey(role, name);
      const idx = counts.get(key) ?? 0;
      counts.set(key, idx + 1);
      const refs = refsByKey.get(key) ?? [];
      refs.push(ref);
      refsByKey.set(key, refs);
      return idx;
    },
    getDuplicateKeys(): Set<string> {
      const dups = new Set<string>();
      for (const [key, refs] of refsByKey) {
        if (refs.length > 1) dups.add(key);
      }
      return dups;
    },
  };
}

const MAX_CURSOR_INTERACTIVE = 50;

async function findCursorInteractiveElements(tabId: number): Promise<Array<{ selector: string; name: string }>> {
  const script = `(() => {
    const results = [];
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
      'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
      'slider', 'spinbutton', 'switch', 'tab', 'treeitem'
    ]);
    const interactiveTags = new Set([
      'a', 'button', 'input', 'select', 'textarea', 'details', 'summary'
    ]);
    const skipTags = new Set(['head', 'script', 'style', 'noscript']);

    const buildSelector = (el) => {
      const testId = el.getAttribute('data-testid');
      if (testId) return '[data-testid="' + testId + '"]';
      if (el.id) return '#' + CSS.escape(el.id);

      const path = [];
      let current = el;
      while (current && current !== document.body) {
        let sel = current.tagName.toLowerCase();
        const classes = Array.from(current.classList).filter(c => c.trim());
        if (classes.length > 0) sel += '.' + CSS.escape(classes[0]);

        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const matching = siblings.filter(s => {
            if (s.tagName !== current.tagName) return false;
            if (classes.length > 0 && !s.classList.contains(classes[0])) return false;
            return true;
          });
          if (matching.length > 1) {
            const idx = matching.indexOf(current) + 1;
            sel += ':nth-of-type(' + idx + ')';
          }
        }
        path.unshift(sel);
        current = current.parentElement;
        if (path.length >= 1) {
          try {
            const candidate = path.join(' > ');
            if (document.querySelectorAll(candidate).length === 1) break;
          } catch (e) {}
        }
        if (path.length >= 10) break;
      }
      return path.join(' > ');
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (results.length >= ${MAX_CURSOR_INTERACTIVE}) break;

      const tagName = el.tagName.toLowerCase();
      if (skipTags.has(tagName)) continue;
      if (interactiveTags.has(tagName)) continue;

      // Skip if inside a skip container
      let inSkip = false;
      let p = el.parentElement;
      while (p) {
        if (skipTags.has(p.tagName.toLowerCase())) { inSkip = true; break; }
        p = p.parentElement;
      }
      if (inSkip) continue;

      const role = el.getAttribute('role');
      if (role && interactiveRoles.has(role.toLowerCase())) continue;

      const computedStyle = getComputedStyle(el);
      const hasCursorPointer = computedStyle.cursor === 'pointer';
      const hasOnClick = el.hasAttribute('onclick') || el.onclick !== null;
      const tabIndex = el.getAttribute('tabindex');
      const hasTabIndex = tabIndex !== null && tabIndex !== '-1';

      if (!hasCursorPointer && !hasOnClick && !hasTabIndex) continue;

      // Skip elements that only inherit cursor:pointer from ancestor
      if (hasCursorPointer && !hasOnClick && !hasTabIndex) {
        const parent = el.parentElement;
        if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
      }

      // Skip hidden/tiny elements
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;

      // Derive name
      const ariaLabel = el.getAttribute('aria-label');
      const textContent = (el.textContent || '').trim().slice(0, 50);
      const title = el.getAttribute('title');
      const name = ariaLabel || textContent || title || tagName;
      if (!name) continue;

      results.push({ selector: buildSelector(el), name });
    }
    return results;
  })()`;

  try {
    const result = await sendCDPCommand<{ result: { value: Array<{ selector: string; name: string }> } }>(
      { tabId }, "Runtime.evaluate",
      { expression: script, returnByValue: true, timeout: 5000 }, 0, 10000
    );
    return result.result?.value || [];
  } catch {
    return [];
  }
}

async function generateAriaSnapshot(tabId: number, options: SnapshotOptions = {}): Promise<{ snapshot: string; estimatedTokens: number }> {
  await ensureDebugger(tabId);

  await sendCDPCommand({ tabId }, "Accessibility.enable", {}, 0, 3000);

  let nodes: Array<any>;

  if (options.selector) {
    // Scoped snapshot: resolve selector → backendNodeId → partial tree
    await sendCDPCommand({ tabId }, "DOM.enable", {}, 0, 3000);
    const docResult = await sendCDPCommand<{ root: { nodeId: number } }>(
      { tabId }, "DOM.getDocument", { depth: 0 }, 0, 10000
    );
    const qResult = await sendCDPCommand<{ nodeId: number }>(
      { tabId }, "DOM.querySelector",
      { nodeId: docResult.root.nodeId, selector: options.selector }, 0, 5000
    );
    if (!qResult.nodeId) {
      return { snapshot: `(selector "${options.selector}" not found)`, estimatedTokens: 0 };
    }
    const descResult = await sendCDPCommand<{ node: { backendNodeId: number } }>(
      { tabId }, "DOM.describeNode", { nodeId: qResult.nodeId }, 0, 5000
    );
    const partialResult = await sendCDPCommand<{ nodes: Array<any> }>(
      { tabId }, "Accessibility.getPartialAXTree",
      { backendNodeId: descResult.node.backendNodeId, fetchRelatives: true }, 0, 15000
    );
    nodes = partialResult.nodes;
  } else {
    const axParams: Record<string, unknown> = { depth: 50 };
    if (activeFrameId) axParams.frameId = activeFrameId;
    const result = await sendCDPCommand<{ nodes: Array<any> }>(
      { tabId }, "Accessibility.getFullAXTree", axParams, 0, 15000
    );
    nodes = result.nodes;
  }

  if (nodes.length > SNAPSHOT_MAX_NODES) {
    nodes.length = SNAPSHOT_MAX_NODES;
  }

  // Reset per-tab ref map for fresh snapshot
  const ariaState = getAriaState(tabId);
  ariaState.refMap = new Map();
  ariaState.refSelectorMap = new Map();
  ariaState.counter = 0;

  // Build parent→children map (CDP childIds are unreliable)
  const childrenOf = new Map<string, any[]>();
  let rootNode: any = null;

  for (const node of nodes) {
    if (node.ignored) continue;
    if (node.parentId) {
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
      childrenOf.get(node.parentId)!.push(node);
    } else {
      rootNode = node;
    }
  }

  // Attach orphans (parent filtered by truncation) to root
  if (rootNode) {
    const knownIds = new Set<string>();
    for (const node of nodes) {
      if (!node.ignored) knownIds.add(node.nodeId);
    }
    for (const node of nodes) {
      if (node.ignored || !node.parentId || node === rootNode) continue;
      if (!knownIds.has(node.parentId)) {
        if (!childrenOf.has(rootNode.nodeId)) childrenOf.set(rootNode.nodeId, []);
        childrenOf.get(rootNode.nodeId)!.push(node);
      }
    }
  }

  // Extract URL property from AX node (for link annotations)
  function getNodeUrl(node: any): string | null {
    if (!node.properties) return null;
    for (const prop of node.properties) {
      if (prop.name === "url" && prop.value?.value) return prop.value.value;
    }
    return null;
  }

  // Extract ARIA properties for richer output
  function getNodeProps(node: any): { checked?: string; expanded?: boolean; level?: number; disabled?: boolean; value?: string } {
    const props: any = {};
    if (!node.properties) return props;
    for (const prop of node.properties) {
      if (prop.name === "checked" && prop.value?.value !== undefined) props.checked = String(prop.value.value);
      if (prop.name === "expanded" && prop.value?.value !== undefined) props.expanded = prop.value.value;
      if (prop.name === "level" && prop.value?.value !== undefined) props.level = prop.value.value;
      if (prop.name === "disabled" && prop.value?.value === true) props.disabled = true;
      if (prop.name === "invalid" && prop.value?.value) props.value = prop.value.value;
    }
    // Value from node.value (for inputs)
    if (node.value?.value !== undefined && node.value.value !== "") props.value = String(node.value.value);
    return props;
  }

  // Filter extension UI noise — extension nodes have chrome-extension:// source URLs
  function isExtensionNode(node: any): boolean {
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === "url" && typeof prop.value?.value === "string"
            && prop.value.value.startsWith("chrome-extension://")) return true;
        if (prop.name === "roledescription" && typeof prop.value?.value === "string"
            && /extension/i.test(prop.value.value)) return true;
      }
    }
    const name = node.name?.value || "";
    const desc = node.description?.value || "";
    const extensionPatterns = [
      /^Record\s+(screen|camera|tab)\b/i,
      /\bLastPass\b/i, /\bGrammarly\b/i,
      /\b1Password\b/i, /\bBitwarden\b/i, /\bDashlane\b/i,
      /\bAdBlock/i, /\buBlock/i,
      /\bLoom\b/i, /^Turn off for this site$/i, /^Move$/,
    ];
    for (const pattern of extensionPatterns) {
      if (pattern.test(name) || pattern.test(desc)) return true;
    }
    return false;
  }

  const tracker = createRoleNameTracker();

  // Check if a subtree has any interactive descendants (for compact mode)
  function hasInteractiveDescendant(node: any): boolean {
    if (node.ignored || isExtensionNode(node)) return false;
    const role = node.role?.value || "";
    if (ARIA_INTERACTIVE_ROLES.has(role)) return true;
    const children = childrenOf.get(node.nodeId) || [];
    for (const child of children) {
      if (hasInteractiveDescendant(child)) return true;
    }
    return false;
  }

  function formatNode(node: any, depth: number): string {
    if (node.ignored) return "";
    if (isExtensionNode(node)) return "";

    // Depth limiting
    if (options.maxDepth !== undefined && depth > options.maxDepth) return "";

    const role = node.role?.value || "";
    const name = node.name?.value || "";
    const children = childrenOf.get(node.nodeId) || [];
    const isInteractive = ARIA_INTERACTIVE_ROLES.has(role);
    const isContent = ARIA_CONTENT_ROLES.has(role);
    const isStructural = ARIA_STRUCTURAL_ROLES.has(role);
    const isLandmark = ARIA_LANDMARK_ROLES.has(role);

    // Interactive-only mode: skip non-interactive nodes but recurse for children
    if (options.interactive && !isInteractive) {
      // Still recurse — interactive children may be nested under structural nodes
      const lines: string[] = [];
      for (const child of children) {
        const cl = formatNode(child, depth);
        if (cl) lines.push(cl);
      }
      return lines.join("\n");
    }

    // Presentational/none nodes: promote children
    if (role === "none" || role === "presentation") {
      if (children.length === 0) return "";
      const lines: string[] = [];
      for (const child of children) {
        const cl = formatNode(child, depth);
        if (cl) lines.push(cl);
      }
      return lines.join("\n");
    }

    // Generic wrappers with no name: promote children (collapse empty wrappers)
    if (role === "generic" && !name) {
      if (children.length === 0) return "";
      const lines: string[] = [];
      for (const child of children) {
        const cl = formatNode(child, depth);
        if (cl) lines.push(cl);
      }
      return lines.join("\n");
    }

    // Group wrappers with no name and just one child: promote child
    if (role === "group" && !name && children.length === 1) {
      return formatNode(children[0], depth);
    }

    // Compact mode: skip unnamed structural nodes with no interactive descendants
    if (options.compact && isStructural && !name && !hasInteractiveDescendant(node)) {
      return "";
    }

    const indent = "  ".repeat(depth);

    // Truncate long names
    const truncatedName = name.length > 80 ? name.substring(0, 77) + "..." : name;

    // Build the node label
    let label = "";
    if (role && role !== "generic") {
      label = role;
      if (truncatedName) label += ` "${truncatedName}"`;
    } else if (truncatedName) {
      label = `"${truncatedName}"`;
    }

    // Add ARIA properties inline
    const props = getNodeProps(node);
    const propParts: string[] = [];
    if (props.checked !== undefined) propParts.push(`checked=${props.checked}`);
    if (props.expanded !== undefined) propParts.push(`expanded=${props.expanded}`);
    if (props.level !== undefined) propParts.push(`level=${props.level}`);
    if (props.disabled) propParts.push("disabled");
    if (props.value !== undefined && role !== "textbox") propParts.push(`value="${props.value}"`);
    if (propParts.length > 0) label += ` [${propParts.join(", ")}]`;

    // URL annotation for links
    if (role === "link") {
      const url = getNodeUrl(node);
      if (url && !url.startsWith("javascript:")) {
        const shortUrl = url.length > 60 ? url.substring(0, 57) + "..." : url;
        label += ` url="${shortUrl}"`;
      }
    }

    // Assign ref to interactive, named content, or named landmark nodes with backendDOMNodeId
    const shouldRef = isInteractive || (isContent && name) || (isLandmark && name);
    if (shouldRef && node.backendDOMNodeId) {
      ariaState.counter++;
      const ref = `e${ariaState.counter}`;
      const resolvedName = name || "";
      const nth = tracker.track(role, resolvedName, ref);
      ariaState.refMap.set(ref, node.backendDOMNodeId);
      if (label) {
        label += ` [ref=${ref}]`;
        if (nth > 0) label += ` [nth=${nth}]`;
      }
    }

    // Process children depth-first
    const childLines: string[] = [];
    for (const child of children) {
      const childLine = formatNode(child, depth + 1);
      if (childLine) childLines.push(childLine);
    }

    // Build output with YAML-like nesting
    if (!label && childLines.length === 0) return "";
    if (!label && childLines.length > 0) return childLines.join("\n");

    const line = `${indent}- ${label}`;
    if (childLines.length > 0) return line + ":\n" + childLines.join("\n");
    return line;
  }

  if (!rootNode) {
    return { snapshot: "(empty page)", estimatedTokens: 0 };
  }

  let snapshot = formatNode(rootNode, 0) || "(empty page)";

  // Post-process: remove nth annotations from refs that have no duplicates
  // Clean nth from snapshot text for non-duplicate refs
  // (nth only appears as [nth=N] in the output for elements tracked by RoleNameTracker)

  // Cursor-interactive discovery: find clickable elements without ARIA roles
  // Only in full mode (not interactive-only, which filters to existing ARIA interactive nodes)
  if (!options.interactive) {
    try {
      const cursorElements = await findCursorInteractiveElements(tabId);
      if (cursorElements.length > 0) {
        const cursorLines: string[] = [];
        for (const el of cursorElements) {
          ariaState.counter++;
          const ref = `e${ariaState.counter}`;
          ariaState.refMap.set(ref, -1);
          ariaState.refSelectorMap.set(ref, el.selector);
          const truncatedName = el.name.length > 80 ? el.name.substring(0, 77) + "..." : el.name;
          cursorLines.push(`- cursor-interactive "${truncatedName}" [ref=${ref}]`);
        }

        if (cursorLines.length > 0) {
          snapshot += "\n" + cursorLines.join("\n");
        }
      }
    } catch {
      // cursor-interactive discovery is best-effort — don't fail the snapshot
    }
  }

  const estimatedTokens = Math.ceil(snapshot.length / 4);
  return { snapshot, estimatedTokens };
}

async function resolveAriaRef(tabId: number, ref: string): Promise<{ x: number; y: number }> {
  const ariaState = tabAriaState.get(tabId);
  if (!ariaState || ariaState.refMap.size === 0) {
    throw new Error(`No refs available — page may have navigated. Run browser_snapshot first.`);
  }
  const backendNodeId = ariaState.refMap.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(`Element ref '${ref}' not found. Run browser_snapshot to refresh.`);
  }

  await ensureDebugger(tabId);

  // Cursor-interactive ref: resolve via CSS selector instead of backendDOMNodeId
  if (backendNodeId === -1) {
    const selector = ariaState.refSelectorMap.get(ref);
    if (!selector) {
      throw new Error(`Element ref '${ref}' has no CSS selector. Run browser_snapshot to refresh.`);
    }
    await sendCDPCommand({ tabId }, "DOM.enable", {}, 0, 3000);
    const docResult = await sendCDPCommand<{ root: { nodeId: number } }>(
      { tabId }, "DOM.getDocument", { depth: 0 }, 0, 10000
    );
    const qResult = await sendCDPCommand<{ nodeId: number }>(
      { tabId }, "DOM.querySelector",
      { nodeId: docResult.root.nodeId, selector }, 0, 5000
    );
    if (!qResult.nodeId) {
      throw new Error(`Element ref '${ref}' is stale (CSS selector no longer matches). Run browser_snapshot to refresh.`);
    }
    // Scroll into view
    try {
      await sendCDPCommand({ tabId }, "DOM.scrollIntoViewIfNeeded", { nodeId: qResult.nodeId });
    } catch {
      try {
        const resolved = await sendCDPCommand<{ object: { objectId?: string } }>(
          { tabId }, "DOM.resolveNode", { nodeId: qResult.nodeId }
        );
        if (resolved.object.objectId) {
          await sendCDPCommand({ tabId }, "Runtime.callFunctionOn", {
            objectId: resolved.object.objectId,
            functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'end', inline: 'nearest' }); }`,
          });
        }
      } catch { /* best effort scroll */ }
    }
    // Get box model
    let model: { content: number[] };
    try {
      const result = await sendCDPCommand<{ model: { content: number[] } }>(
        { tabId }, "DOM.getBoxModel", { nodeId: qResult.nodeId }
      );
      model = result.model;
    } catch {
      throw new Error(`Element ref '${ref}' is stale (page may have changed). Run browser_snapshot to refresh.`);
    }
    const quad = model.content;
    return {
      x: Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4),
      y: Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4),
    };
  }

  // Standard ARIA ref: resolve via backendDOMNodeId
  // Scroll into view before getBoxModel to ensure element is on-screen
  try {
    await sendCDPCommand({ tabId }, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Fallback: resolve to objectId and use JS scrollIntoView
    try {
      const resolved = await sendCDPCommand<{ object: { objectId?: string } }>(
        { tabId }, "DOM.resolveNode", { backendNodeId }
      );
      if (resolved.object.objectId) {
        await sendCDPCommand({ tabId }, "Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'end', inline: 'nearest' }); }`,
        });
      }
    } catch { /* best effort scroll */ }
  }

  // Get box model for center coordinates — stale backendNodeId throws here after navigation
  let model: { content: number[] };
  try {
    const result = await sendCDPCommand<{ model: { content: number[] } }>(
      { tabId }, "DOM.getBoxModel", { backendNodeId }
    );
    model = result.model;
  } catch {
    throw new Error(`Element ref '${ref}' is stale (page may have changed). Run browser_snapshot to refresh.`);
  }

  const quad = model.content;
  const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
  const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);

  return { x, y };
}

async function resolveCssSelectorToObjectId(tabId: number, selector: string): Promise<string | undefined> {
  await sendCDPCommand({ tabId }, "DOM.enable", {}, 0, 3000);
  const docResult = await sendCDPCommand<{ root: { nodeId: number } }>(
    { tabId }, "DOM.getDocument", { depth: 0 }, 0, 10000
  );
  const qResult = await sendCDPCommand<{ nodeId: number }>(
    { tabId }, "DOM.querySelector",
    { nodeId: docResult.root.nodeId, selector }, 0, 5000
  );
  if (!qResult.nodeId) return undefined;
  const resolved = await sendCDPCommand<{ object: { objectId?: string } }>(
    { tabId }, "DOM.resolveNode", { nodeId: qResult.nodeId }
  );
  return resolved.object.objectId;
}

// --- AX tree helpers (AC-13) ---

function simplifyAXNode(node: any): any {
  const simplified: any = {
    nodeId: node.nodeId,
    role: node.role?.value ?? "unknown",
    name: node.name?.value ?? "",
    ignored: node.ignored ?? false,
  };

  if (node.value?.value) simplified.value = node.value.value;
  if (node.description?.value) simplified.description = node.description.value;
  if (node.childIds?.length) simplified.childIds = node.childIds;
  if (node.parentId) simplified.parentId = node.parentId;

  if (node.properties) {
    for (const prop of node.properties) {
      if (["disabled", "required", "checked", "expanded", "selected", "focused"].includes(prop.name)) {
        if (!simplified.properties) simplified.properties = {};
        simplified.properties[prop.name] = prop.value?.value;
      }
    }
  }

  return simplified;
}

function buildAXTree(flatNodes: any[], maxDepth: number): { tree: any; nodeCount: number } {
  const nodeMap = new Map<string, any>();
  for (const node of flatNodes) {
    if (!node.ignored) nodeMap.set(node.nodeId, { ...node, children: [] });
  }

  let root: any = null;
  const orphans: any[] = [];
  for (const node of nodeMap.values()) {
    if (node.parentId && nodeMap.has(node.parentId)) {
      nodeMap.get(node.parentId)!.children.push(node);
    } else if (!node.parentId) {
      root = node;
    } else {
      orphans.push(node);
    }
  }

  // Attach orphans (parent filtered out or absent in partial tree) to root
  if (root && orphans.length) {
    root.children.push(...orphans);
  }

  function trimDepth(node: any, depth: number): any {
    if (depth >= maxDepth) { delete node.children; return node; }
    if (node.children) {
      node.children = node.children.map((c: any) => trimDepth(c, depth + 1));
    }
    return node;
  }

  return { tree: root ? trimDepth(root, 0) : null, nodeCount: nodeMap.size };
}

// CDP debugger management.
// `makePrimary` promotes the tab to the foreground/capture tab — only the genuine connect
// entry points pass true. Session attaches use the default (false) so they add to
// `attachedTabs` for concurrent control without hijacking the primary. Attaching a tab no
// longer detaches any other tab — multiple tabs stay attached simultaneously.
async function attachDebugger(tabId: number, makePrimary = false): Promise<void> {
  // Already attached — at most promote to primary, never re-attach.
  if (attachedTabs.has(tabId)) {
    if (makePrimary) markPrimaryTab(tabId);
    return;
  }
  // Coalesce concurrent attaches to the *same* tab; different tabs attach in parallel.
  const inFlight = attachLocks.get(tabId);
  if (inFlight) {
    await inFlight;
    if (makePrimary && attachedTabs.has(tabId)) markPrimaryTab(tabId);
    return;
  }
  const op = (async () => {
    try {
      // This IS attachDebugger — the one place the raw API is meant to be called.
      // eslint-disable-next-line no-restricted-syntax
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "already attached" means OUR debugger is on the tab (a duplicate attach), so treat it
      // as success rather than an error — any other message is a genuine failure.
      if (!/already attached/i.test(msg)) {
        throw new Error(`Debugger attach failed for tab ${tabId}: ${msg}`);
      }
    }
    attachedTabs.add(tabId);
    if (makePrimary) markPrimaryTab(tabId);
    startKeepalive();
    startPersistTimer();
    // Armed here rather than in ensureDebugger: connect_tab reaches the debugger through
    // startNetworkCapture → attachDebugger without ever calling ensureDebugger, and once a
    // tab is attached every later ensureDebugger returns on its fast path. Arming anywhere
    // else leaves the idle check unreachable in the normal connect flow.
    startIdleReleaseAlarm().catch(() => {});
  })();
  attachLocks.set(tabId, op);
  try { await op; } finally { attachLocks.delete(tabId); }
}

// Ensure debugger is attached and domains enabled
async function ensureDebugger(tabId: number, makePrimary = false): Promise<DomainEnableResult> {
  // Fast path: already attached with known domain state
  const existing = tabDomainState.get(tabId);
  if (attachedTabs.has(tabId) && existing) {
    if (makePrimary) markPrimaryTab(tabId);
    return existing;
  }

  await attachDebugger(tabId, makePrimary);

  const result: DomainEnableResult = { required: [], optional: [], allRequiredOk: true };

  // Required domains — must all succeed
  const requiredDomains = ["Page.enable", "Runtime.enable"];
  for (const domain of requiredDomains) {
    try {
      await sendCDPCommand({ tabId }, domain, {}, 2);
      result.required.push({ domain, success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.required.push({ domain, success: false, error: msg });
      result.allRequiredOk = false;
      // Detach on required domain failure — connection is unusable
      try { await chrome.debugger.detach({ tabId }); } catch { /* may already be detached */ }
      forgetAttachedTab(tabId);
      throw new Error(`Required CDP domain ${domain} failed: ${msg}`);
    }
  }

  // Optional domains — log failure, continue
  const optionalDomains = ["DOMStorage.enable", "Performance.enable"];
  for (const domain of optionalDomains) {
    try {
      await sendCDPCommand({ tabId }, domain, domain === "Performance.enable" ? { timeDomain: "timeTicks" } : {}, 0);
      result.optional.push({ domain, success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.optional.push({ domain, success: false, error: msg });
      if (__DEV__) console.warn(`[Crawlio] Optional domain ${domain} failed:`, msg);
    }
  }

  tabDomainState.set(tabId, mergeDomainState(tabDomainState.get(tabId), result));

  // If this tab was detached to clear the debugger banner, restore the pieces that only
  // startNetworkCapture installs (stealth, framework hooks, Web Vitals, optional domains).
  // Without this an idle release would silently leave stealth off for the rest of the session.
  await resumeAfterIdleRelease(tabId);

  return result;
}

// --- Fetch Domain Interception ---
async function enableInterception(tabId: number, patterns: InterceptRule[]): Promise<void> {
  await ensureDebugger(tabId);
  interceptRules.set(tabId, patterns);
  await sendCDPCommand({ tabId }, "Fetch.enable", {
    patterns: patterns.map(p => ({ urlPattern: p.urlPattern, requestStage: "Request" })),
  });
}

async function disableInterception(tabId: number): Promise<void> {
  interceptRules.delete(tabId);
  try { await sendCDPCommand({ tabId }, "Fetch.disable", {}, 0); } catch { /* may already be detached */ }
}

// Resolves true when this call started capture, false when it was skipped because capture
// was already running. The distinction matters to the idle-resume path: a skip means this
// tab's injected scripts were NOT reinstalled.
async function startNetworkCapture(tabId: number, opts: { preserveBuffers?: boolean; makePrimary?: boolean } = {}): Promise<boolean> {
  // Double-start guard — reject if already capturing
  if (networkCapturing) {
    if (__DEV__) console.log("[Crawlio] Network capture already active, skipping start");
    return false;
  }
  // Claim synchronously BEFORE any await to prevent double-start race
  networkCapturing = true;

  try {
    // Network capture is normally the foreground/primary tab. An idle resume passes false
    // for a tab that was not primary when it was released, so restoring it cannot steal
    // the foreground from whichever tab holds it now.
  await attachDebugger(tabId, opts.makePrimary ?? true);

  // Initialize capture state BEFORE Network.enable so events are not dropped.
  // as soon as Network.enable returns. The global chrome.debugger.onEvent listener
  // (registered at module scope) checks networkCapturing before processing.
  // Resuming after an idle release keeps the history captured before the detach.
  if (!opts.preserveBuffers) {
    networkEntries.clear();
    wsConnections.clear();
    swRegistrations.clear();
    consoleLogs = [];
    consoleWriteIndex = 0;
    networkCaptureSeq = 0;
  }
  mainDocResponseHeaders = {};

  // --- Required domains: must succeed for capture to work ---
  // init order: Page.enable → Network.enable → Runtime.enable
  // If any required enable fails, reset networkCapturing to avoid stuck state.
  const captureDomainResult: DomainEnableResult = { required: [], optional: [], allRequiredOk: true };
  const captureRequiredDomains = ["Page.enable", "Network.enable", "Runtime.enable", "Log.enable"];
  try {
    for (const domain of captureRequiredDomains) {
      await sendCDPCommand({ tabId }, domain, {}, 2);
      captureDomainResult.required.push({ domain, success: true });
      await CDP_YIELD();
      if (domain === "Page.enable") {
        await populateFrameTree(tabId);
      }
    }
  } catch (err) {
    networkCapturing = false;
    captureDomainResult.allRequiredOk = false;
    const msg = err instanceof Error ? err.message : String(err);
    captureDomainResult.required.push({ domain: captureRequiredDomains[captureDomainResult.required.length], success: false, error: msg });
    tabDomainState.set(tabId, mergeDomainState(tabDomainState.get(tabId), captureDomainResult));
    throw err;
  }

  // --- Optional domains: log failure but continue ---
  const optionalDomains: Array<[string, string, Record<string, unknown>]> = [
    ["DOMStorage", "DOMStorage.enable", {}],
    ["FileChooser", "Page.setInterceptFileChooserDialog", { enabled: true }],
    ["Performance", "Performance.enable", { timeDomain: "timeTicks" }],
    ["Security", "Security.enable", {}],
    ["ServiceWorker", "ServiceWorker.enable", {}],
    ["CSS", "CSS.enable", {}],
    ["IndexedDB", "IndexedDB.enable", {}],
    ["Profiler", "Profiler.enable", {}],
  ];
  for (const [label, command, cmdParams] of optionalDomains) {
    try {
      await sendCDPCommand({ tabId }, command, cmdParams, 0);
      captureDomainResult.optional.push({ domain: command, success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      captureDomainResult.optional.push({ domain: command, success: false, error: msg });
      if (__DEV__) console.warn(`[Crawlio] Optional domain ${label} failed:`, err);
    }
  }
  tabDomainState.set(tabId, mergeDomainState(tabDomainState.get(tabId), captureDomainResult));

  // Web Vitals injection — PerformanceObserver for LCP/CLS/FID (JS-level, not CDP)
  try {
    await sendCDPCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
  if (window.__crawlioPerf) return;
  window.__crawlioPerf = { lcp: null, cls: 0, fid: null };
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    if (entries.length) window.__crawlioPerf.lcp = entries[entries.length - 1].startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__crawlioPerf.cls += entry.value;
    }
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    const entry = list.getEntries()[0];
    if (entry) window.__crawlioPerf.fid = entry.processingStart - entry.startTime;
  }).observe({ type: "first-input", buffered: true });
})()`,
    }, 0);
  } catch (err) {
    if (__DEV__) console.warn("[Crawlio] Web Vitals injection failed:", err);
  }

  // Anti-detection stealth injection
  if (stealthEnabled) {
    try {
      const stealthResult = await sendCDPCommand<{ identifier: string }>({ tabId }, "Page.addScriptToEvaluateOnNewDocument", {
        source: STEALTH_SCRIPT,
      }, 0);
      stealthScriptId = stealthResult?.identifier ?? null;
      // Inject immediately for current page (addScriptToEvaluateOnNewDocument only affects future navigations)
      await sendCDPCommand({ tabId }, "Runtime.evaluate", {
        expression: STEALTH_SCRIPT,
        returnByValue: true,
      }, 0);
    } catch (err) {
      if (__DEV__) console.warn("[Crawlio] Stealth injection failed:", err);
    }
  }

  // Pre-load framework hooks — capture init data before frameworks mount
  if (!frameworkHookScriptId) {
    try {
      const hookResult = await sendCDPCommand<{ identifier: string }>(
        { tabId }, "Page.addScriptToEvaluateOnNewDocument",
        { source: FRAMEWORK_HOOK_SCRIPT }, 0
      );
      frameworkHookScriptId = hookResult.identifier;
    } catch { /* non-fatal */ }
  }
  // Also run immediately for current page
  try {
    await sendCDPCommand({ tabId }, "Runtime.evaluate", {
      expression: FRAMEWORK_HOOK_SCRIPT,
      returnByValue: true,
    }, 0, 3000);
  } catch { /* page may not be ready */ }

  writeStatus({ capturing: true, activeTabId: tabId });
  return true;
  } catch (err) {
    networkCapturing = false; // release on failure
    throw err;
  }
}

async function stopNetworkCapture(): Promise<any[]> {
  if (!networkCapturing) {
    if (__DEV__) console.log("[Crawlio] Network capture not active, returning empty");
    return [];
  }

  networkCapturing = false;
  cssCoverageActive = false;
  jsCoverageActive = false;
  mainDocResponseHeaders = {};
  const entries = Array.from(networkEntries.values()).filter(
    (e): e is NetworkMapEntry & { requestId: string } => !!e.url && !!e.requestId
  ).map(e => {
    if (e.requestHeaders) e.requestHeaders = sanitizeValue(e.requestHeaders) as Record<string, string>;
    if (e.requestBody) e.requestBody = sanitizeValue(e.requestBody) as string;
    return e;
  });

  if (debuggerAttachedTabId !== null) {
    try {
      await sendCDPCommand({ tabId: debuggerAttachedTabId }, "Network.disable", {}, 0);
      await sendCDPCommand({ tabId: debuggerAttachedTabId }, "Runtime.disable", {}, 0);
      await sendCDPCommand({ tabId: debuggerAttachedTabId }, "Log.disable", {}, 0);
    } catch { /* domains may already be disabled or detached */ }
  }

  writeStatus({ capturing: false });
  try {
    await putNetworkEntries(entries);
  } catch { /* IDB write failed — fall back to session storage */
    storageWrite("crawlio:network", entries.slice(-SESSION_NETWORK_CAP));
  }
  persistState().catch(() => {});
  return entries;
}

// CDP event listener
chrome.debugger.onEvent.addListener(async (source, method, params: any) => {
  switch (method) {
    // --- Frame lifecycle events ---
    case "Page.frameAttached": {
      const tabId = source.tabId!;
      const frameId = params.frameId as string;
      const parentFrameId = params.parentFrameId as string | undefined;
      if (!frameId) break;
      const map = getOrCreateFrameMap(tabId);
      if (!map.has(frameId)) {
        const info: FrameInfo = {
          id: frameId,
          parentId: parentFrameId,
          url: "",
          name: "",
          securityOrigin: "",
          children: [],
        };
        map.set(frameId, info);
        if (parentFrameId) {
          const parent = map.get(parentFrameId);
          if (parent) parent.children.push(info);
        }
      }
      break;
    }

    case "Page.frameDetached": {
      const tabId = source.tabId!;
      const frameId = params.frameId as string;
      if (!frameId) break;
      const map = frameTrees.get(tabId);
      if (map) {
        // Clear activeFrameId if detached frame is the active one
        if (activeFrameId === frameId) activeFrameId = null;
        // Remove frame and all descendants
        const removeRecursive = (fid: string) => {
          const frame = map.get(fid);
          if (frame) {
            for (const child of frame.children) removeRecursive(child.id);
            map.delete(fid);
          }
          // Also remove context mapping
          frameContexts.get(tabId)?.delete(fid);
          // Clear activeFrameId if a descendant was active
          if (activeFrameId === fid) activeFrameId = null;
        };
        // Unlink from parent
        const frame = map.get(frameId);
        if (frame?.parentId) {
          const parent = map.get(frame.parentId);
          if (parent) {
            parent.children = parent.children.filter(c => c.id !== frameId);
          }
        }
        removeRecursive(frameId);
      }
      break;
    }

    case "Page.navigatedWithinDocument": {
      // Same-document nav (history.back, pushState, hash change) invalidates backendDOMNodeIds
      const tabId = source.tabId!;
      tabAriaState.delete(tabId);
      break;
    }

    case "Page.frameNavigated": {
      const tabId = source.tabId!;
      const frame = params.frame;
      if (!frame?.id) break;

      // Invalidate refs — backendDOMNodeIds are stale after navigation
      tabAriaState.delete(tabId);

      const map = frameTrees.get(tabId);
      const existing = map?.get(frame.id);
      if (existing) {
        existing.url = frame.url || "";
        existing.name = frame.name || "";
        existing.securityOrigin = frame.securityOrigin || "";
      }
      break;
    }

    case "Runtime.executionContextCreated": {
      const tabId = source.tabId!;
      const ctx = params.context;
      if (!ctx?.id || !ctx.auxData?.frameId) break;
      if (ctx.auxData.isDefault) {
        getOrCreateContextMap(tabId).set(ctx.auxData.frameId, ctx.id);
      }
      break;
    }

    case "Runtime.executionContextDestroyed": {
      const tabId = source.tabId!;
      const ctxId = params.executionContextId as number;
      if (!ctxId) break;
      const ctxMap = frameContexts.get(tabId);
      if (ctxMap) {
        for (const [fid, cid] of ctxMap) {
          if (cid === ctxId) {
            ctxMap.delete(fid);
            // AC-2 fix: clear activeFrameId if destroyed context was the active frame's
            if (activeFrameId === fid) activeFrameId = null;
            break;
          }
        }
      }
      break;
    }

    case "Runtime.executionContextsCleared": {
      const tabId = source.tabId!;
      frameContexts.get(tabId)?.clear();
      // AC-2 fix: all contexts destroyed — activeFrameId is now invalid
      if (tabId === debuggerAttachedTabId) activeFrameId = null;
      break;
    }

    // User interaction capture via CDP binding
    case "Runtime.bindingCalled": {
      if (params.name !== INTERACTION_BINDING_NAME) break;
      if (!activeRecording) break;
      const tabId = source.tabId!;
      if (activeRecording.tabId !== tabId) break;
      try {
        const event = JSON.parse(params.payload);
        const currentPage = activeRecording.pages[activeRecording.pages.length - 1];
        currentPage.interactions.push({
          timestamp: new Date().toISOString(),
          tool: event.type,
          args: {
            ...(event.selector ? { selector: event.selector } : {}),
            ...(event.text ? { text: event.text } : {}),
            ...(event.key ? { key: event.key } : {}),
            ...(event.x !== undefined ? { x: event.x, y: event.y } : {}),
          },
          durationMs: 0,
          pageUrl: event.url || activeRecording.currentPageUrl,
          source: "user",
        });
        activeRecording.totalInteractions++;

        if (activeRecording.totalInteractions >= activeRecording.maxInteractions) {
          autoStopRecording("max_interactions");
        }
      } catch { /* ignore malformed payloads */ }
      break;
    }

    // AC-6: Dialog control
    case "Page.javascriptDialogOpening": {
      const tabId = source.tabId!;
      const count = (dialogCounts.get(tabId) || 0) + 1;
      dialogCounts.set(tabId, count);

      const dialog: PendingDialog = {
        type: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt,
        url: params.url,
        timestamp: new Date().toISOString(),
      };

      if (dialogAutoMode !== "queue") {
        // Auto-handle mode (backwards compatible with AH-3)
        try {
          await sendCDPCommand(
            { tabId }, "Page.handleJavaScriptDialog",
            { accept: dialogAutoMode === "accept", promptText: params.type === "prompt" ? (params.defaultPrompt ?? "") : undefined }, 0
          );
        } catch { /* dialog may have already been handled */ }
      } else {
        // Queue mode — store for MCP tool access
        // Fix: auto-accept existing pending dialog before storing new one (rapid dialog race)
        if (pendingDialog) {
          try {
            await sendCDPCommand(
              { tabId }, "Page.handleJavaScriptDialog",
              { accept: true }, 0
            );
          } catch { /* previous dialog may have been handled */ }
        }
        if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
        pendingDialog = dialog;
        // Safety timeout: auto-accept after 30s to prevent page freeze
        // Fix: capture tabId + sequenceId in closure to prevent stale timeout from accepting wrong dialog
        const dialogTabId = tabId;
        const thisDialogId = ++dialogSequenceId;
        dialogAutoTimeout = setTimeout(async () => {
          if (pendingDialog && thisDialogId === dialogSequenceId) {
            try {
              await sendCDPCommand(
                { tabId: dialogTabId }, "Page.handleJavaScriptDialog",
                { accept: true }, 0
              );
            } catch { /* dialog may have been handled */ }
          }
          if (thisDialogId === dialogSequenceId) {
            pendingDialog = null;
            dialogAutoTimeout = null;
          }
        }, 30000);
      }
      break;
    }

    // AC-11: File chooser interception
    case "Page.fileChooserOpened": {
      pendingFileChooser = {
        mode: params.mode, // "selectSingle" | "selectMultiple"
        frameId: params.frameId,
        backendNodeId: params.backendNodeId,
        timestamp: new Date().toISOString(),
      };
      break;
    }

    case "Network.requestWillBeSent": {
      if (!networkCapturing) return;
      // Scope to connected tab only
      if (source.tabId !== debuggerAttachedTabId) return;
      // Filter chrome-extension:// requests (extension noise)
      if (params.request?.url?.startsWith("chrome-extension://")) return;
      const { requestId, request, timestamp, initiator } = params;
      networkEntries.set(requestId, {
        url: request.url,
        method: request.method,
        status: 0,
        mimeType: "",
        size: 0,
        transferSize: 0,
        durationMs: 0,
        resourceType: params.type || "Other",
        initiator: initiator?.type,
        requestHeaders: request.headers || undefined,
        requestBody: request.postData || undefined,
        requestId,
        _startTime: timestamp,
        _seq: networkCaptureSeq++,
      });
      // FIFO eviction: keep at most 2x SESSION_NETWORK_CAP entries
      if (networkEntries.size > SESSION_NETWORK_CAP * 2) {
        const sorted = [...networkEntries.entries()].sort((a, b) => (a[1]._seq ?? 0) - (b[1]._seq ?? 0));
        const toDelete = sorted.slice(0, networkEntries.size - SESSION_NETWORK_CAP);
        for (const [key] of toDelete) networkEntries.delete(key);
      }
      break;
    }
    case "Network.responseReceived": {
      if (!networkCapturing) return;
      const { requestId, response } = params;
      const entry = networkEntries.get(requestId);
      if (entry) {
        entry.status = response.status;
        entry.mimeType = response.mimeType || "";
      }
      // fw-hardening: capture main document headers for framework detection
      if (params.type === "Document") {
        mainDocResponseHeaders = response.headers || {};
      }
      break;
    }
    case "Network.loadingFinished": {
      if (!networkCapturing) return;
      const { requestId, timestamp, encodedDataLength } = params;
      const entry = networkEntries.get(requestId);
      if (entry) {
        entry.transferSize = encodedDataLength || 0;
        entry.durationMs = (timestamp - (entry._startTime || 0)) * 1000;
        delete entry._startTime;
      }
      flushNetworkToStorage();
      break;
    }
    case "Network.dataReceived": {
      if (!networkCapturing) return;
      const { requestId, dataLength } = params;
      const entry = networkEntries.get(requestId);
      if (entry) {
        entry.size = (entry.size || 0) + (dataLength || 0);
      }
      break;
    }
    case "Network.loadingFailed": {
      if (!networkCapturing) return;
      const { requestId } = params;
      const entry = networkEntries.get(requestId);
      if (entry) {
        entry.status = -1;
        delete entry._startTime;
      }
      flushNetworkToStorage();
      break;
    }

    // --- AC-16: WebSocket monitoring ---
    case "Network.webSocketCreated": {
      if (!networkCapturing) return;
      const { requestId, url, initiator } = params;
      // FIFO eviction on connection count
      if (wsConnections.size >= WS_MAX_CONNECTIONS) {
        let oldestKey: string | null = null;
        let oldestTime = "";
        for (const [key, ws] of wsConnections) {
          if (!oldestTime || ws.createdAt < oldestTime) { oldestTime = ws.createdAt; oldestKey = key; }
        }
        if (oldestKey) wsConnections.delete(oldestKey);
      }
      wsConnections.set(requestId, {
        requestId,
        url,
        initiator: initiator?.type,
        status: "connecting",
        messages: [],
        createdAt: new Date().toISOString(),
      });
      break;
    }
    case "Network.webSocketWillSendHandshakeRequest": {
      // Connection already in "connecting" state — no status change needed
      break;
    }
    case "Network.webSocketHandshakeResponseReceived": {
      if (!networkCapturing) return;
      const ws = wsConnections.get(params.requestId);
      if (ws) ws.status = "open";
      break;
    }
    case "Network.webSocketFrameSent": {
      if (!networkCapturing) return;
      const wsSent = wsConnections.get(params.requestId);
      if (wsSent) {
        if (wsSent.messages.length >= WS_MAX_MESSAGES_PER_CONNECTION) wsSent.messages.shift();
        wsSent.messages.push({
          direction: "sent",
          opcode: params.response?.opcode ?? 1,
          data: params.response?.payloadData ?? "",
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
    case "Network.webSocketFrameReceived": {
      if (!networkCapturing) return;
      const wsRecv = wsConnections.get(params.requestId);
      if (wsRecv) {
        if (wsRecv.messages.length >= WS_MAX_MESSAGES_PER_CONNECTION) wsRecv.messages.shift();
        wsRecv.messages.push({
          direction: "received",
          opcode: params.response?.opcode ?? 1,
          data: params.response?.payloadData ?? "",
          timestamp: new Date().toISOString(),
        });
      }
      break;
    }
    case "Network.webSocketFrameError": {
      if (!networkCapturing) return;
      const wsErr = wsConnections.get(params.requestId);
      if (wsErr) {
        wsErr.status = "error";
        wsErr.errorMessage = params.errorMessage;
      }
      break;
    }
    case "Network.webSocketClosed": {
      if (!networkCapturing) return;
      const wsClosed = wsConnections.get(params.requestId);
      if (wsClosed) {
        wsClosed.status = "closed";
        wsClosed.closedAt = new Date().toISOString();
      }
      break;
    }

    // --- Fetch domain interception ---
    case "Fetch.requestPaused": {
      const tabId = source.tabId!;
      const rules = interceptRules.get(tabId);
      if (!rules?.length) {
        // No rules — continue request unmodified
        try {
          await sendCDPCommand({ tabId }, "Fetch.continueRequest", { requestId: params.requestId }, 0);
        } catch { /* request may have been cancelled */ }
        break;
      }

      const requestUrl = params.request?.url || "";
      const matchedRule = rules.find(r => {
        try {
          // Convert glob urlPattern to regex: * → .*, ? → .
          const escaped = r.urlPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
          return regex.test(requestUrl);
        } catch { /* invalid urlPattern — skip rule */
          return false;
        }
      });

      if (!matchedRule) {
        try {
          await sendCDPCommand({ tabId }, "Fetch.continueRequest", { requestId: params.requestId }, 0);
        } catch { /* request may have been cancelled */ }
        break;
      }

      try {
        switch (matchedRule.action) {
          case "block":
            await sendCDPCommand({ tabId }, "Fetch.failRequest", {
              requestId: params.requestId,
              errorReason: "BlockedByClient",
            }, 0);
            break;

          case "modify": {
            const headers = params.request?.headers || {};
            if (matchedRule.modifyHeaders) {
              Object.assign(headers, matchedRule.modifyHeaders);
            }
            await sendCDPCommand({ tabId }, "Fetch.continueRequest", {
              requestId: params.requestId,
              headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
            }, 0);
            break;
          }

          case "mock": {
            const mock = matchedRule.mockResponse ?? { status: 200, headers: {} as Record<string, string>, body: "" };
            // Per-field defaults: partial mockResponse (e.g. {status:200} without headers) must not throw
            const bodyBytes = new TextEncoder().encode(mock.body || "");
            const bodyB64 = btoa(Array.from(bodyBytes, b => String.fromCharCode(b)).join(""));
            await sendCDPCommand({ tabId }, "Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: mock.status || 200,
              responseHeaders: Object.entries(mock.headers || {}).map(([name, value]) => ({ name, value })),
              body: bodyB64,
            }, 0);
            break;
          }

          default:
            // Unknown action — continue request to prevent leak (every paused request must be resolved)
            await sendCDPCommand({ tabId }, "Fetch.continueRequest", { requestId: params.requestId }, 0);
        }
      } catch {
        // Prevent request leak: if our processing throws before sending CDP command,
        // the request remains paused. Always attempt to continue it as fallback.
        try {
          await sendCDPCommand({ tabId }, "Fetch.continueRequest", { requestId: params.requestId }, 0);
        } catch { /* request already resolved or debugger detached */ }
      }
      break;
    }

    // Browser-level logs (404, CORS, CSP) via Log.enable
    case "Log.entryAdded": {
      const entry = params.entry;
      if (consoleLogs.length >= SESSION_CONSOLE_CAP) consoleLogs.shift();
      consoleLogs.push({
        level: entry.level === "error" ? "error" : entry.level === "warning" ? "warning" : "info",
        text: entry.text || "",
        timestamp: new Date(entry.timestamp).toISOString(),
        url: entry.url,
        lineNumber: entry.lineNumber,
      });
      if (networkCapturing) flushConsoleToStorage();
      break;
    }
    case "Runtime.consoleAPICalled": {
      // Scope to connected tab only
      if (source.tabId !== debuggerAttachedTabId) break;
      // Filter extension-originated console messages
      const sourceUrl = params.stackTrace?.callFrames?.[0]?.url || "";
      if (sourceUrl.startsWith("chrome-extension://")) break;
      const { type, args, timestamp, stackTrace } = params;
      const levelMap: Record<string, string> = {
        error: "error", warn: "warning", warning: "warning",
        info: "info", log: "info", debug: "debug",
      };
      if (consoleLogs.length >= SESSION_CONSOLE_CAP) consoleLogs.shift();
      consoleLogs.push({
        level: levelMap[type] || "info",
        text: args?.map((a: any) => a.value ?? a.description ?? "").join(" ") || "",
        timestamp: new Date(timestamp).toISOString(),
        url: stackTrace?.callFrames?.[0]?.url,
        lineNumber: stackTrace?.callFrames?.[0]?.lineNumber,
      });
      if (networkCapturing) flushConsoleToStorage();
      break;
    }

    // AC-19: ServiceWorker registration tracking
    case "ServiceWorker.workerRegistrationUpdated": {
      const regs = params.registrations as any[];
      if (regs) {
        for (const reg of regs) {
          const existing = swRegistrations.get(reg.registrationId);
          swRegistrations.set(reg.registrationId, {
            registrationId: reg.registrationId,
            scopeURL: reg.scopeURL,
            isDeleted: reg.isDeleted,
            versions: existing?.versions ?? [],
          });
        }
      }
      break;
    }

    // AC-19: ServiceWorker version tracking
    case "ServiceWorker.workerVersionUpdated": {
      const versions = params.versions as any[];
      if (versions) {
        for (const ver of versions) {
          const reg = swRegistrations.get(ver.registrationId);
          if (reg) {
            const idx = reg.versions.findIndex(v => v.versionId === ver.versionId);
            const swVer: SWVersion = {
              versionId: ver.versionId,
              scriptURL: ver.scriptURL,
              runningStatus: ver.runningStatus ?? "stopped",
              status: ver.status ?? "new",
            };
            if (idx >= 0) reg.versions[idx] = swVer;
            else reg.versions.push(swVer);
          }
        }
      }
      break;
    }

    case "Security.visibleSecurityStateChanged": {
      const vs = params.visibleSecurityState;
      if (!vs) break;
      const certState = vs.certificateSecurityState;
      currentSecurityState = {
        securityState: vs.securityState ?? "unknown",
        certificate: certState ? {
          subjectName: certState.subjectName ?? "",
          issuer: certState.issuer ?? "",
          validFrom: certState.validFrom ?? 0,
          validTo: certState.validTo ?? 0,
          protocol: certState.protocol ?? "",
          keyExchange: certState.keyExchange ?? "",
          cipher: certState.cipher ?? "",
          certificateTransparencyCompliance: certState.certificateTransparencyCompliance ?? "unknown",
        } : undefined,
        mixedContent: vs.securityState === "neutral",
        updatedAt: new Date().toISOString(),
      };
      break;
    }
  }
});

// Cleanup on debugger detach with reason tracking
chrome.debugger.onDetach.addListener((source, reason) => {
  // Drop membership for ANY detached tab — primary or a background session tab.
  if (typeof source.tabId === "number") {
    attachedTabs.delete(source.tabId);
    tabDomainState.delete(source.tabId);
    agentCursorInjectedTabs.delete(source.tabId); // re-inject on next attach
  }
  if (source.tabId === debuggerAttachedTabId) {
    // Stop recording BEFORE clearing state — recording needs networkEntries/consoleLogs for finalization
    if (activeRecording && activeRecording.tabId === source.tabId) {
      autoStopRecording("tab_disconnected");
    }
    // Clean up frame data and intercept rules for this tab
    frameTrees.delete(source.tabId!);
    frameContexts.delete(source.tabId!);
    dialogCounts.delete(source.tabId!);
    interceptRules.delete(source.tabId!);
    tabDomainState.delete(source.tabId!);
    interactionCaptureActive.delete(source.tabId!);
    pendingDialog = null;
    pendingFileChooser = null;
    if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
    debuggerAttachedTabId = null;
    activeFrameId = null;
    stealthScriptId = null;
    frameworkHookScriptId = null;
    currentSecurityState = null;
    connectionStartTime = null;
    lastCommandTime = null;
    networkCapturing = false;
    cssCoverageActive = false;
    jsCoverageActive = false;
    consoleLogs = [];
    mainDocResponseHeaders = {};
    networkEntries.clear();
    wsConnections.clear();
    swRegistrations.clear();
    targetSessions.clear();
    browserContexts.clear();
    writeStatus({ capturing: false, activeTabId: null });
    persistState().catch(() => {});
    if (!shouldStayAlive()) stopKeepalive();
    if (__DEV__) console.warn(`[Crawlio] Debugger detached: ${reason}`);
  }
});

// Framework detection + DOM snapshot functions extracted to src/extension/injected/
// Imported at top of file — see framework-detector.ts and dom-snapshot.ts

// --- Silent enrichment: capture on every HTTP(S) navigation ---
const SKIP_URL_PREFIXES = ["chrome://", "chrome-extension://", "about:", "file://", "devtools://"];

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // AC-3: Invalidate opt-out cache on navigation
  if (changeInfo.url || changeInfo.status === "loading") {
    for (const key of optOutCache.keys()) {
      if (key.startsWith(`${tabId}:`)) optOutCache.delete(key);
    }
  }

  // Navigation resets framework state — icon stays as default (no overlay)

  // Main frame load complete only
  if (changeInfo.status !== "complete") return;
  const url = tab.url;
  // Skip non-HTTP and internal URLs
  if (!url || SKIP_URL_PREFIXES.some(p => url.startsWith(p))) return;

  // Auto-probe on page load if no bridge connected
  if (wsBridges.size === 0 && !userDisconnected) {
    requestBridgeDiscovery();
  }

  // Recording: detect page transition + re-inject indicators/capture
  if (activeRecording && activeRecording.tabId === tabId
      && url && url !== activeRecording.currentPageUrl) {
    startNewRecordingPage(url, tab.title);
    showRecordingIndicator(tabId);
    setupInteractionCapture(tabId).catch(() => {});
  }

  // Refresh connectedTab storage so get_connection_status returns current URL/favicon
  if (debuggerAttachedTabId === tabId) {
    const connData = await chrome.storage.session.get("crawlio:connectedTab");
    if (connData["crawlio:connectedTab"]?.tabId === tabId) {
      await chrome.storage.session.set({ "crawlio:connectedTab": {
        tabId: tab.id!, url: tab.url || "", title: tab.title || "Untitled",
        favIconUrl: tab.favIconUrl, windowId: tab.windowId,
      }});
    }
  }

  // Clear IDB on navigation only when actively capturing — avoids wiping data for idle connections
  if (debuggerAttachedTabId === tabId && networkCapturing) {
    clearAll().catch(() => setTimeout(() => clearAll().catch(() => {}), 500));
  }

  try {
    // Framework detection: CDP when debugger attached, else skip
    let framework: any = null;
    if (debuggerAttachedTabId === tabId) {
      try {
        framework = await cdpExecuteFunction<FrameworkDetection>(tabId, detectFrameworkInPage, [mainDocResponseHeaders]);
      } catch { /* best effort */ }
    }

    if (framework && framework.framework !== "Unknown") {
      dispatchFrameworkTelemetry(url, framework);
    }

    // Screenshot after 1.5s delay (best-effort, no debugger needed)
    let screenshot: string | undefined;
    try {
      await new Promise(r => setTimeout(r, 1500));
      // Tab may have closed during the delay — verify it still exists
      await chrome.tabs.get(tabId);
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "jpeg", quality: 60 });
    } catch { /* tab closed, non-focused window, permission denied, etc. */ }

    // CDP integration: if debugger is attached to this tab, include network/console/DOM
    let networkRequests: any[] | undefined;
    let consoleCopy: any[] | undefined;
    let domSnapshotJSON: string | undefined;
    if (debuggerAttachedTabId === tabId) {
      const netEntries = Array.from(networkEntries.values()).filter(e => e.url && !e._startTime);
      if (netEntries.length) networkRequests = netEntries;
      if (consoleLogs.length) consoleCopy = [...consoleLogs];
      try {
        const dom = await cdpExecuteFunction<any>(tabId, captureDOMSnapshot, [10]);
        if (dom) domSnapshotJSON = JSON.stringify(dom);
      } catch { /* best effort */ }
    }

    accumulator.upsert(url, {
      url,
      title: tab.title || "",
      framework,
      screenshot,
      networkRequests,
      consoleLogs: consoleCopy,
      domSnapshotJSON,
      capturedAt: new Date().toISOString(),
    });

    // Write heavy data to IDB, lightweight metadata to session storage
    const capturedAt = new Date().toISOString();
    const fullCapture: Record<string, any> = {
      url,
      title: tab.title || "",
      capturedAt,
    };
    if (framework) fullCapture.framework = framework;
    if (domSnapshotJSON) fullCapture.domSnapshot = domSnapshotJSON;
    if (screenshot) fullCapture.screenshot = screenshot;
    if (consoleCopy?.length) fullCapture.consoleLogs = consoleCopy;

    try {
      await putCapture(fullCapture as any);
      if (networkRequests?.length) await putNetworkEntries(networkRequests.map((e: any) => ({ requestId: e.requestId || String(Math.random()), ...e })));
      if (consoleCopy?.length) await putConsoleLogs(consoleCopy);
    } catch {
      // IDB failed — fall back to session storage for active tab only
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id === tabId) {
        chrome.storage.session.set({ "crawlio:capture": fullCapture });
        if (networkRequests?.length) chrome.storage.session.set({ "crawlio:network": networkRequests.slice(-SESSION_NETWORK_CAP) });
        if (consoleCopy?.length) chrome.storage.session.set({ "crawlio:console": consoleCopy.slice(-SESSION_CONSOLE_CAP) });
      }
    }

    // Always write lightweight metadata to session storage for popup/UI
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id === tabId) {
      storageWrite("crawlio:capture-meta", {
        url,
        title: tab.title || "",
        framework,
        capturedAt,
      });
    }

    // Enrichment is available on-demand via MCP tools — no badge, no auto-POST
  } catch { /* swallow all errors — silent enrichment must never break the extension */ }
});

// Message handler for popup commands
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === "PERMISSIONS_GRANTED") {
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "GET_ENRICHMENT_FOR_TAB") {
    const enrichment = accumulator.get(msg.url);
    if (enrichment) {
      sendResponse({
        capture: {
          url: enrichment.url,
          title: enrichment.title,
          framework: enrichment.framework,
          capturedAt: enrichment.capturedAt,
          screenshot: enrichment.screenshot,
          domSnapshot: enrichment.domSnapshotJSON,
          consoleLogs: enrichment.consoleLogs,
        },
        network: enrichment.networkRequests || [],
        console: enrichment.consoleLogs || [],
      });
    } else {
      crawlioEnrichmentFetchBack(msg.url)
        .then(result => sendResponse(result))
        .catch(() => sendResponse(null));
    }
    return true;
  }

  if (msg.type === "CAPTURE_PAGE") {
    handleCommand({ type: "capture_page", id: "ui" })
      .then(r => sendResponse(r.data))
      .catch(_e => sendResponse(null));
    return true;
  }
  if (msg.type === "DISCONNECT_TAB") {
    (async () => {
      const data = await chrome.storage.session.get("crawlio:connectedTab");
      const conn = data["crawlio:connectedTab"];
      if (conn?.tabId && debuggerAttachedTabId === conn.tabId) {
        // Explicit cleanup — onDetach won't fire correctly since we clear debuggerAttachedTabId
        frameTrees.delete(conn.tabId);
        frameContexts.delete(conn.tabId);
        dialogCounts.delete(conn.tabId);
        interceptRules.delete(conn.tabId);
        tabDomainState.delete(conn.tabId);
        pendingDialog = null;
        pendingFileChooser = null;
        if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
        try { await chrome.debugger.detach({ tabId: conn.tabId }); } catch { /* may already be detached */ }
        debuggerAttachedTabId = null;
        activeFrameId = null;
        stealthScriptId = null;
        frameworkHookScriptId = null;
        currentSecurityState = null;
        connectionStartTime = null;
        lastCommandTime = null;
        networkCapturing = false;
        cssCoverageActive = false;
        jsCoverageActive = false;
        consoleLogs = [];
        mainDocResponseHeaders = {};
        networkEntries.clear();
        wsConnections.clear();
        swRegistrations.clear();
        targetSessions.clear();
        browserContexts.clear();
        try { await clearAll(); } catch { /* IDB clear failed */ }
        resetIcon(conn.tabId);
        clearBadge(conn.tabId);
        setTooltip(conn.tabId, "Crawlio");
      }
      await chrome.storage.session.remove("crawlio:connectedTab");
      writeStatus({ capturing: false, activeTabId: null });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (__DEV__ && msg.type === "START_NETWORK_CAPTURE") {
    const getTab = async () => {
      try {
        return await getConnectedTab();
      } catch {
        // Fallback 1: try active tab in current window
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && activeTab.url?.match(/^https?:\/\//)) {
          chrome.storage.session.set({
            "crawlio:connectedTab": {
              tabId: activeTab.id,
              url: activeTab.url,
              title: activeTab.title || "",
            },
          });
          return activeTab;
        }
        // Fallback 2: query ALL tabs in window, find first HTTP tab
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const httpTab = allTabs.find(t => t.url?.match(/^https?:\/\//) && t.id !== undefined) ?? null;
        if (!httpTab?.id) {
          throw new Error("No HTTP tab available in current window");
        }
        chrome.storage.session.set({
          "crawlio:connectedTab": {
            tabId: httpTab.id,
            url: httpTab.url || "",
            title: httpTab.title || "",
          },
        });
        return httpTab;
      }
    };

    getTab()
      .then(tab => startNetworkCapture(tab.id!))
      .then(() => {
        sendResponse({ ok: true });
        handleCommand({ type: "capture_page", id: "auto" }).catch(() => {});
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (__DEV__ && msg.type === "STOP_NETWORK_CAPTURE") {
    stopNetworkCapture()
      .then(entries => sendResponse(entries))
      .catch(_e => sendResponse([]));
    return true;
  }
  if (msg.type === "TAKE_SCREENSHOT") {
    getConnectedTab()
      .then(tab => takeScreenshotHardened(tab.id!))
      .then(data => sendResponse({ data }))
      .catch(e => sendResponse({ data: null, error: e.message }));
    return true;
  }
  if (msg.type === "GET_ENRICHMENT_COUNT") {
    sendResponse({ count: accumulator.count() });
    return true;
  }
  if (msg.type === "START_BRIDGE") {
    userDisconnected = false;
    bridgeRetryGate.reset();
    requestBridgeDiscovery();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "STOP_BRIDGE") {
    (async () => {
      userDisconnected = true;
      chrome.alarms.clear(RECONNECT_ALARM);
      if (pendingDisconnectTimer) { clearTimeout(pendingDisconnectTimer); pendingDisconnectTimer = null; }
      if (bridgeDiscoveryTimer) { clearTimeout(bridgeDiscoveryTimer); bridgeDiscoveryTimer = null; }
      bridgeRetryGate.reset();

      // Close all WebSocket connections
      for (const socket of wsBridges.values()) {
        try { socket.close(); } catch { /* already closing */ }
      }
      wsBridges.clear();
      connectingPorts.clear();
      activeBridgePort = null;     // no elected bridge while user-disconnected
      for (const t of identityTimers.values()) clearTimeout(t);
      identityTimers.clear();      // drop pending identity-handshake deadlines
      bridgeTrust.clear();         // drop per-port handshake state
      // intentionalClose is a WeakSet keyed by the now-closed sockets — it GCs itself.

      // Disconnect native port
      disconnectNative();

      // Detach debugger if attached
      if (debuggerAttachedTabId) {
        const tabId = debuggerAttachedTabId;
        attachedTabs.delete(tabId);
        frameTrees.delete(tabId);
        frameContexts.delete(tabId);
        dialogCounts.delete(tabId);
        interceptRules.delete(tabId);
        tabDomainState.delete(tabId);
        pendingDialog = null;
        pendingFileChooser = null;
        if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
        try { await chrome.debugger.detach({ tabId }); } catch { /* may already be detached */ }
        debuggerAttachedTabId = null;
        activeFrameId = null;
        stealthScriptId = null;
        frameworkHookScriptId = null;
        currentSecurityState = null;
        connectionStartTime = null;
        lastCommandTime = null;
        networkCapturing = false;
        cssCoverageActive = false;
        jsCoverageActive = false;
        consoleLogs = [];
        mainDocResponseHeaders = {};
        networkEntries.clear();
        wsConnections.clear();
        swRegistrations.clear();
        targetSessions.clear();
        browserContexts.clear();
        try { await clearAll(); } catch { /* IDB clear failed */ }
        resetIcon(tabId);
        clearBadge(tabId);
        setTooltip(tabId, "Crawlio");
      }

      await chrome.storage.session.remove("crawlio:connectedTab");
      await chrome.storage.session.set({ "crawlio:bridgeConnected": false, "crawlio:bridgeCount": 0 });
      writeStatus({ mcpConnected: false, capturing: false, activeTabId: null });
      stopKeepalive();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "GET_FRAME_TREE") {
    (async () => {
      try {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        // Refresh frame tree before returning
        await populateFrameTree(tab.id!);
        const tree = getFrameTree(tab.id!);
        sendResponse({ ok: true, frames: tree });
      } catch (e: unknown) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), frames: [] });
      }
    })();
    return true;
  }
  if (msg.type === "EXECUTE_IN_FRAME") {
    (async () => {
      try {
        const tab = await getConnectedTab();
        await ensureDebugger(tab.id!);
        const frameId = msg.frameId as string;
        const expression = msg.expression as string;
        if (!frameId) { sendResponse({ ok: false, error: "frameId is required" }); return; }
        if (!expression) { sendResponse({ ok: false, error: "expression is required" }); return; }
        const result = await executeInFrame(tab.id!, frameId, expression);
        sendResponse({ ok: true, result });
      } catch (e: unknown) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
});

// Alarm-based reconnect safety-net — survives SW restart when setTimeout timers are lost
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === IDLE_RELEASE_ALARM) {
    maybeIdleRelease().catch((e) => { if (__DEV__) console.warn("[Crawlio] Idle release check failed:", e); });
    return;
  }
  if (alarm.name !== RECONNECT_ALARM) return;
  if (userDisconnected) {
    chrome.alarms.clear(RECONNECT_ALARM);
    return;
  }
  // Already connected — do nothing. Re-election (the NEW_BRIDGE_SCAN_INTERVAL timer)
  // already follows the active session; firing discovery here too was redundant churn.
  // This alarm is purely the SW-restart safety net: only rediscover when disconnected.
  // A connected token side-channel does NOT count — the WS command transport must be up,
  // else we'd never rediscover the bridge while only the native token channel is connected.
  if (wsBridges.size > 0) return;
  requestBridgeDiscovery();
});

// Auto-connect on browser startup (Chrome profile opened)
chrome.runtime.onStartup.addListener(() => {
  if (!userDisconnected) {
    requestBridgeDiscovery();
  }
});

// Start connection (probe-first, no ERR_CONNECTION_REFUSED)
requestBridgeDiscovery();

// H11: Migrate all tabId-keyed state when Chrome replaces a tab (prerender/instant navigation)
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  // Ports can't be migrated — old connection is dead
  activePorts.delete(removedTabId);

  // Migrate frame data (may still be valid for same-page replacement)
  const ft = frameTrees.get(removedTabId);
  if (ft) { frameTrees.set(addedTabId, ft); frameTrees.delete(removedTabId); }

  const fc = frameContexts.get(removedTabId);
  if (fc) { frameContexts.set(addedTabId, fc); frameContexts.delete(removedTabId); }

  // Migrate dialog counts
  const dc = dialogCounts.get(removedTabId);
  if (dc !== undefined) { dialogCounts.set(addedTabId, dc); dialogCounts.delete(removedTabId); }

  // Migrate intercept rules (configuration, survives replacement)
  const ir = interceptRules.get(removedTabId);
  if (ir) { interceptRules.set(addedTabId, ir); interceptRules.delete(removedTabId); }

  // backendDOMNodeIds are per-renderer-process — invalid after tab replacement
  tabAriaState.delete(removedTabId);

  // Keyboard modifier state is per-tab — migrate to new tab ID
  const ks = tabKeyboardState.get(removedTabId);
  if (ks) { tabKeyboardState.set(addedTabId, ks); tabKeyboardState.delete(removedTabId); }

  // Migrate domain state — only if the tab was NOT attached (debugger is lost on replacement,
  // for the primary *and* any attached background session tab).
  if (!attachedTabs.has(removedTabId)) {
    const ds = tabDomainState.get(removedTabId);
    if (ds) { tabDomainState.set(addedTabId, ds); tabDomainState.delete(removedTabId); }
  } else {
    attachedTabs.delete(removedTabId);
    tabDomainState.delete(removedTabId);
  }

  // Debugger attachment is lost on tab replacement
  if (debuggerAttachedTabId === removedTabId) {
    pendingDialog = null;
    pendingFileChooser = null;
    if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
    debuggerAttachedTabId = null;
    activeFrameId = null;
    stealthScriptId = null;
    frameworkHookScriptId = null;
    currentSecurityState = null;
    connectionStartTime = null;
    lastCommandTime = null;
    networkCapturing = false;
    cssCoverageActive = false;
    jsCoverageActive = false;
    consoleLogs = [];
    mainDocResponseHeaders = {};
    networkEntries.clear();
    wsConnections.clear();
    swRegistrations.clear();
    targetSessions.clear();
    browserContexts.clear();
    clearAll().catch(() => setTimeout(() => clearAll().catch(() => {}), 500));
    writeStatus({ capturing: false, activeTabId: null });
    persistState().catch(() => {});
    if (!shouldStayAlive()) stopKeepalive();
    resetIcon(removedTabId);
  }

  // Update connectedTab storage reference
  const data = await chrome.storage.session.get("crawlio:connectedTab");
  if (data["crawlio:connectedTab"]?.tabId === removedTabId) {
    await chrome.storage.session.set({
      "crawlio:connectedTab": { ...data["crawlio:connectedTab"], tabId: addedTabId },
    });
  }
});

// Clean up connected tab if user closes it
chrome.tabs.onRemoved.addListener(async (tabId) => {
  // AC-3: Clean opt-out cache for closed tab
  for (const key of optOutCache.keys()) {
    if (key.startsWith(`${tabId}:`)) optOutCache.delete(key);
  }

  // Clean up port + frame data for closed tab
  activePorts.delete(tabId);
  attachedTabs.delete(tabId);
  agentCursorInjectedTabs.delete(tabId);
  frameTrees.delete(tabId);
  frameContexts.delete(tabId);
  dialogCounts.delete(tabId);
  interceptRules.delete(tabId);
  tabDomainState.delete(tabId);
  tabKeyboardState.delete(tabId);
  tabAriaState.delete(tabId);
  for (const session of agentSessions.values()) {
    if (session.tabId === tabId && session.status !== "closed") {
      session.status = "closed";
      session.updatedAt = new Date().toISOString();
      session.lastError = "tab closed";
    }
  }
  persistAgentSessions().catch(() => {});
  pruneClosedTab(tabId).catch(() => {});

  if (tabId === debuggerAttachedTabId) {
    pendingDialog = null;
    pendingFileChooser = null;
    if (dialogAutoTimeout) { clearTimeout(dialogAutoTimeout); dialogAutoTimeout = null; }
  }

  // Auto-stop recording if recorded tab closed
  if (activeRecording && activeRecording.tabId === tabId) {
    autoStopRecording("tab_closed");
  }

  // H11: Explicitly clear debugger state — don't rely solely on onDetach race
  if (debuggerAttachedTabId === tabId) {
    // Cancel pending debounce timers before clearing data structures
    if (networkWriteTimer) { clearTimeout(networkWriteTimer); networkWriteTimer = null; }
    if (consoleWriteTimer) { clearTimeout(consoleWriteTimer); consoleWriteTimer = null; }
    try { await chrome.debugger.detach({ tabId }); } catch { /* already detached */ }
    debuggerAttachedTabId = null;
    activeFrameId = null;
    stealthScriptId = null;
    frameworkHookScriptId = null;
    currentSecurityState = null;
    connectionStartTime = null;
    lastCommandTime = null;
    networkCapturing = false;
    cssCoverageActive = false;
    jsCoverageActive = false;
    consoleLogs = [];
    consoleWriteIndex = 0;
    mainDocResponseHeaders = {};
    networkEntries.clear();
    wsConnections.clear();
    swRegistrations.clear();
    targetSessions.clear();
    browserContexts.clear();
    clearAll().catch(() => setTimeout(() => clearAll().catch(() => {}), 500));
    persistState().catch(() => {});
    if (!shouldStayAlive()) stopKeepalive();
    resetIcon(); // global reset — tab is gone
  }

  const data = await chrome.storage.session.get("crawlio:connectedTab");
  if (data["crawlio:connectedTab"]?.tabId === tabId) {
    await chrome.storage.session.remove("crawlio:connectedTab");
    writeStatus({ capturing: false, activeTabId: null });
  }
});

// --- Keyboard shortcuts (Phase 2: SEO intelligence) ---
chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case "connect-tab": {
        const tab = await getActiveTab();
        if (!tab.id || !tab.url?.startsWith("http")) return;
        if (debuggerAttachedTabId === tab.id) return; // already connected
        await chrome.storage.session.set({ "crawlio:connectedTab": {
          tabId: tab.id, url: tab.url || "", title: tab.title || "Untitled",
          favIconUrl: tab.favIconUrl, windowId: tab.windowId,
        }});
        await startNetworkCapture(tab.id);
        await persistState().catch(() => {});
        setDynamicIcon("active", tab.id);
        if (__DEV__) console.log(`[Crawlio] Keyboard shortcut: connected to tab ${tab.id}`);
        break;
      }
      case "capture-page": {
        if (!debuggerAttachedTabId) return;
        const screenshot = await takeScreenshotHardened(debuggerAttachedTabId);
        if (screenshot) {
          await chrome.storage.session.set({ "crawlio:keyboard-screenshot": { data: screenshot, capturedAt: new Date().toISOString() } });
        }
        if (__DEV__) console.log("[Crawlio] Keyboard shortcut: capture triggered");
        break;
      }
      case "take-screenshot": {
        if (!debuggerAttachedTabId) return;
        const data = await takeScreenshotHardened(debuggerAttachedTabId);
        if (data && __DEV__) console.log("[Crawlio] Keyboard shortcut: screenshot captured");
        break;
      }
      case "toggle-recording": {
        if (activeRecording) {
          stopRecordingInternal("manual");
          if (__DEV__) console.log("[Crawlio] Keyboard shortcut: recording stopped");
        } else if (__DEV__) {
          console.log("[Crawlio] Keyboard shortcut: use MCP start_recording to begin recording");
        }
        break;
      }
    }
  } catch (err) {
    if (__DEV__) console.warn(`[Crawlio] Keyboard shortcut "${command}" failed:`, err);
  }
});

// --- Tab switch: restore active icon + auto-probe ---
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Auto-probe on tab switch if no bridge connected
  if (wsBridges.size === 0 && !userDisconnected) {
    requestBridgeDiscovery();
  }

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url) return;

    // Recording badge takes priority
    if (activeRecording && activeRecording.tabId === activeInfo.tabId) return;

    // Debugger-attached tab: show active icon state
    if (debuggerAttachedTabId === activeInfo.tabId) {
      setDynamicIcon("active", activeInfo.tabId);
    }
  } catch {
    // Tab may not exist
  }
});
