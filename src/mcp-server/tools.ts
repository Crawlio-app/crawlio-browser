import { z } from "zod";
import { execFile } from "child_process";
import { writeFile, unlink, appendFile, mkdir, stat } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join, dirname, resolve, sep } from "path";
import { randomBytes, randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { promisify } from "util";
import type { WebSocketBridge } from "./websocket-bridge.js";
import type { CrawlioClient } from "./crawlio-client.js";
import { TIMEOUTS } from "../shared/constants.js";
import { MAX_EVAL_EXPRESSION_LENGTH, isProblemCode, type ProblemCode } from "../shared/protocol.js";
import type { PageCapture, FrameworkDetection, NetworkEntry, ConsoleEntry, CookieEntry, RecordingSession } from "../shared/types.js";
import type { PageEvidence, ScrollEvidence, IdleStatus, ComparisonEvidence, Finding, CoverageGap, Observation, DimensionSlot, ComparableMetric, ComparisonScaffold, MethodTrace, StepTrace, ConfidenceLevel, AccessibilitySummary, MobileReadiness, TableCandidate, TableExtraction, NetworkIdleResult, DataExtraction, PageSections, TrackingParseResult, TrackingValidationResult, SnapshotDiffResult, DataLayerState, DuplicateCluster } from "../shared/evidence-types.js";
import { buildDetectTablesJs, buildExtractTableJs, buildDetectSectionsJs } from "./extraction-js.js";
import { shapeListTabs, shapeConnectTab, shapeCapturePage, shapeConsoleLogs, shapeNetworkLog, shapeCookies, shapeInteraction } from "./response-shapers.js";
import { compileRecording } from "./recording-compiler.js";
import { createPickerTools, PICKER_TOOL_TIMEOUTS } from "./pickerOverlay.js";
import { loadEmbeddings, buildQueryEmbedding, semanticSearch, normalizeScores } from "./semantic-search.js";
import { detectDuplicates } from "./tracking-parser.js";
import { validateTrackingEvents } from "./tracking-validator.js";
import { diffSnapshots as computeDiff } from "./snapshot-diff.js";
import { matchFingerprints, buildTechnographicResult } from "./fingerprint-db.js";
import { collectSignals, buildJSGlobalsCheckExpr, META_TAG_EXTRACTION_EXPR } from "../extension/sensors/tech-signal-collector.js";
import type { TechnographicResult } from "../shared/evidence-types.js";
import type { SeoAuditResult } from "../shared/seo-types.js";
import { fetchCruxMetrics } from "./crux-client.js";
import { robotTrainingArtifacts, robotTrainingStart, robotTrainingStatus, robotTrainingStop } from "./robot-training.js";
import { semanticClassify, semanticFind } from "./semantic-grounding.js";
import { executeSandboxedCode } from "./execute-sandbox.js";
import { checkActionPolicy, type ActionPolicy } from "./action-policy.js";
import type { PolicyEnforcedSender } from "./policy-sender.js";

const execFileAsync = promisify(execFile);

type BridgeCommand = Parameters<WebSocketBridge["send"]>[0];

/** Typed bridge response for list_tabs — replaces `as any` cast */
interface BridgeTabsResponse {
  tabs: Array<{ tabId: number; url: string; title: string; windowId?: number; active?: boolean; connected?: boolean; [key: string]: unknown }>;
  connectedTabId?: number | null;
}

// --- Validation schemas ---

const urlSchema = z.string().url().refine(
  url => {
    try {
      const p = new URL(url).protocol;
      return p === "http:" || p === "https:";
    } catch { return false; }
  },
  "URL must use http or https scheme"
);

const selectorSchema = z.string().min(1).max(1000)
  .refine(
    s => !/<script/i.test(s) && !s.includes("javascript:"),
    "Selector must not contain script injection"
  )
  // Control characters and JS line separators cannot appear in a real CSS selector, and
  // each expands six-fold when escaped into the generated program's source.
  .refine(
    s => !/[\u0000-\u001F\u007F\u2028\u2029]/.test(s),
    "Selector must not contain control characters"
  );

const modifiersSchema = z.object({
  ctrl: z.boolean().optional(),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
  meta: z.boolean().optional(),
}).optional();

const agentViewportSchema = z.object({
  width: z.number().int().min(1).max(10000).optional(),
  height: z.number().int().min(1).max(10000).optional(),
  deviceScaleFactor: z.number().min(0).max(10).optional(),
  mobile: z.boolean().optional(),
}).optional();

const agentActionSchema = z.object({
  action: z.enum(["navigate", "click", "hover", "insertText", "type", "fill", "select", "scroll", "key", "press", "command", "evaluate", "move_mouse"]),
  selector: selectorSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  turnId: z.string().min(1).max(100).optional(), // correlate actions within one agent turn
  ref: z.string().min(1).max(100).optional(),
  target: z.object({
    selector: selectorSchema.optional(),
    ref: z.string().min(1).max(100).optional(),
  }).optional(),
  text: z.string().max(10000).optional(),
  value: z.string().max(10000).optional(),
  url: urlSchema.optional(),
  expression: z.string().min(1).max(MAX_EVAL_EXPRESSION_LENGTH).optional(),
  key: z.string().min(1).max(100).optional(),
  command: z.string().min(1).max(100).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().min(1).max(100000).optional(),
  clearFirst: z.boolean().optional(),
  submit: z.boolean().optional(),
}).passthrough();

// --- Permission guard ---

export const PERMISSION_EXEMPT_TOOLS = new Set([
  "ping",
  "get_capabilities",
  "check_permissions",
  "request_permissions",
  "get_connection_status",
  "get_recording_status",
  "recording_status",
  "recording_artifacts",
  "recording_validate_bundle",
  "connect_tab",
  "list_tabs",
  "search",
  "execute",
  "compile_recording",
  // async job control — pure server-side registry reads, never touch the extension
  "get_job_result",
  "list_jobs",
  "cancel_job",
]);

// bridge.send() resolves with msg.data directly — no wrapper layer
interface PermissionCheckResult {
  granted: boolean;
  missing?: { permissions?: string[]; origins?: string[] };
}

export async function ensurePermission(
  bridge: WebSocketBridge,
  toolName: string
): Promise<{ allowed: boolean; error?: string }> {
  try {
    // check_permissions is handled by the extension but not in the ServerCommand union —
    // assertion required until protocol.ts adds the variant
    const result = await bridge.send(
      { type: "check_permissions" } as unknown as Parameters<typeof bridge.send>[0],
      5000
    ) as PermissionCheckResult;
    if (result?.granted) {
      return { allowed: true };
    }
    // Fallback: trigger the popup badge "!" via request_permissions so the user can grant it
    try {
      await bridge.send(
        { type: "request_permissions" } as unknown as Parameters<typeof bridge.send>[0],
        3000
      );
    } catch { /* best-effort — denial error text still returned */ }
    return { allowed: false, error: formatPermissionDenial(result?.missing, toolName) };
  } catch {
    return { allowed: false, error: "Permission check unavailable — extension may be disconnected. Reconnect and try again." };
  }
}

export function formatPermissionDenial(
  missing: { permissions?: string[]; origins?: string[] } | undefined,
  toolName: string
): string {
  const parts: string[] = [];
  if (missing?.permissions?.length) parts.push(`permissions: ${missing.permissions.join(", ")}`);
  if (missing?.origins?.length) parts.push(`origins: ${missing.origins.join(", ")}`);
  const detail = parts.length ? ` (${parts.join("; ")})` : "";
  return (
    `Permission required for "${toolName}"${detail}.\n` +
    `Click the Crawlio extension icon and grant the requested permissions.\n\n` +
    `IMPORTANT: Do not attempt workarounds. Do not try alternative approaches to bypass this permission requirement. ` +
    `The user must grant permissions through the Crawlio popup.`
  );
}

// --- Per-tool timeouts ---

// The code-mode `execute` sandbox runs up to CRAWLIO_EXECUTE_SANDBOX_ASYNC_TIMEOUT_MS
// (default 120s). The server-side per-tool timeout (index.ts) MUST exceed that budget,
// or it aborts long-but-legitimate code-mode workflows (e.g. navigate + OCR on heavy
// pages) at the 30s default long before the sandbox's own limit is reached. Derive it
// from the same env so the two never drift apart.
const EXECUTE_SANDBOX_ASYNC_MS = (() => {
  const v = Number.parseInt(process.env.CRAWLIO_EXECUTE_SANDBOX_ASYNC_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 120000;
})();

export const TOOL_TIMEOUTS: Record<string, number> = {
  ...PICKER_TOOL_TIMEOUTS,
  execute: EXECUTE_SANDBOX_ASYNC_MS + 5000, // was unset → hit the 30s default while the sandbox allowed 120s
  connect_tab: 30000, // was 15000 — cold-start CDP capture-init can exceed 15s on heavy pages
  disconnect_tab: 5000,
  list_tabs: 5000,
  get_connection_status: 5000,
  reconnect_tab: 15000,
  get_capabilities: 5000,
  semantic_find: 15000,
  semantic_classify: 10000,
  agent_session_create: 20000,
  agent_session_list: 5000,
  agent_session_status: 10000,
  agent_session_close: 5000,
  agent_session_snapshot: 30000,
  agent_session_action: 20000,
  agent_session_batch: 60000,
  agent_session_artifacts: 10000,
  agent_session_create_tab: 20000,
  agent_session_claim_tab: 10000,
  agent_session_name: 5000,
  agent_session_finalize: 10000,
  get_user_tabs: 5000,
  robot_training_start: 20000,
  robot_training_status: 10000,
  robot_training_stop: 90000,
  robot_training_artifacts: 10000,
  recording_start: 20000,
  recording_status: 10000,
  recording_stop: 90000,
  recording_artifacts: 10000,
  recording_capture_bundle: 120000,
  recording_validate_bundle: 10000,
  capture_page: 60000,
  detect_framework: 10000,
  start_network_capture: 5000,
  stop_network_capture: TIMEOUTS.NETWORK_CAPTURE,
  get_console_logs: 5000,
  get_cookies: 5000,
  get_dom_snapshot: 15000,
  take_screenshot: TIMEOUTS.SCREENSHOT,
  extract_site: 10000,
  get_crawl_status: 5000,
  get_enrichment: 5000,
  get_crawled_urls: 10000,
  enrich_url: 120000,
  browser_navigate: 30000,
  browser_click: 10000,
  browser_type: 10000,
  browser_press_key: 5000,
  browser_hover: 10000,
  browser_select_option: 10000,
  browser_wait: 35000,
  browser_wait_for: 65000,
  browser_intercept: 10000,
  get_frame_tree: 10000,
  switch_to_frame: 5000,
  switch_to_main_frame: 5000,
  create_tab: 20000,
  close_tab: 5000,
  switch_tab: 5000,
  set_cookie: 5000,
  delete_cookies: 5000,
  export_session_raw: 10000,
  get_storage: 5000,
  set_storage: 5000,
  clear_storage: 5000,
  get_dialog: 5000,
  handle_dialog: 5000,
  get_response_body: 5000,
  replay_request: 30000,
  set_viewport: 5000,
  set_user_agent: 5000,
  emulate_device: 10000,
  print_to_pdf: 65000,
  browser_scroll: 10000,
  browser_double_click: 10000,
  browser_drag: 15000,
  browser_file_upload: 10000,
  set_geolocation: 5000,
  browser_fill_form: 15000,
  browser_evaluate: 10000,
  browser_snapshot: 15000,
  get_accessibility_tree: 15000,
  get_performance_metrics: 10000,
  get_websocket_connections: 5000,
  get_websocket_messages: 5000,
  set_stealth_mode: 5000,
  emulate_network: 10000,
  set_cache_disabled: 5000,
  set_extra_headers: 5000,
  get_security_state: 5000,
  ignore_certificate_errors: 5000,
  list_service_workers: 5000,
  stop_service_worker: 10000,
  bypass_service_worker: 5000,
  set_outer_html: 10000,
  set_attribute: 5000,
  remove_attribute: 5000,
  remove_node: 5000,
  start_css_coverage: 5000,
  stop_css_coverage: 10000,
  get_computed_style: 5000,
  detect_fonts: 10000,
  force_pseudo_state: 5000,
  start_js_coverage: 5000,
  stop_js_coverage: 15000,
  get_databases: 10000,
  query_object_store: 10000,
  clear_database: 10000,
  get_targets: 5000,
  attach_to_target: 10000,
  create_browser_context: 10000,
  get_dom_counters: 5000,
  force_gc: 10000,
  take_heap_snapshot: 30000,
  highlight_element: 10000,
  show_layout_shifts: 5000,
  show_paint_rects: 5000,
  start_recording: 10000,
  stop_recording: 10000,
  get_recording_status: 5000,
  compile_recording: 5000,
  ocr_screenshot: 30000,
  wait_for_network_idle: 35000,
  detect_tables: 15000,
  extract_table: 15000,
  extract_data: 30000,
  detect_sections: 15000,
  parse_tracking_pixels: 10000,
  validate_tracking: 10000,
  inspect_datalayer: 10000,
  detect_technologies: 20000,
  diff_snapshot: 15000,
  inject_serp_overlay: 15000,
  clear_serp_overlay: 10000,
  seo_audit: 20000,
  check_robots_txt: 15000,
  check_sitemap: 15000,
  compare_raw_rendered: 30000,
  set_seo_intelligence: 5000,
  get_seo_intelligence: 5000,
  set_idle_release: 5000,
  get_idle_release: 5000,
  crux_metrics: 15000,
};

// --- Structured response helpers ---

/** JSON.stringify with circular reference protection (WeakSet-based) */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value ?? {}, (_key, val) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}

export function toolSuccess(content: unknown) {
  return { content: [{ type: "text" as const, text: safeStringify(content) }], isError: false };
}

/**
 * CDP's Runtime.evaluate takes an expression, so a program with a bare top-level `return`
 * is wrapped in an async IIFE. A program that is ALREADY an expression must be left alone —
 * wrapping an IIFE would discard its value, since the wrapper itself never returns.
 *
 * Leading comments are stripped before the test so a sentinel-prefixed extraction program
 * still reads as an expression, while a hand-written `/* note *\/ return x` is still wrapped.
 */
export function wrapEvaluateExpression(expression: string): string {
  const withoutLeadingComments = expression.replace(/^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$)))+/, "");
  // Detect against the stripped program: after `/* note */` the `return` follows a comment
  // terminator rather than a line start, which the original text would not match.
  const hasTopLevelReturn = /(?:^|[;\n{])\s*return\s/m.test(withoutLeadingComments);
  const isExpression = withoutLeadingComments.trimStart().startsWith("(");
  return hasTopLevelReturn && !isExpression ? `(async () => { ${expression} })()` : expression;
}

export function toolError(message: string, problem?: ProblemCode) {
  // The code is prefixed into the text (rather than added as a field) because the MCP tool
  // result shape is fixed — this keeps it machine-greppable without breaking the contract.
  const text = problem ? `[problem:${problem}] ${message}` : message;
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** Read the problem code the bridge attached to a rejected command, if any. */
export function problemOf(error: unknown): ProblemCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).problem;
  return isProblemCode(code) ? code : undefined;
}

// --- Actionability helpers ---

/** Progressive backoff schedule for actionability retries */
export const ACTIONABILITY_BACKOFF = [0, 20, 100, 100, 500];

/**
 * Code-mode `saveArtifact()` — the sandbox's only path to persist bulk data to disk.
 *
 * WHY: the execute sandbox can otherwise surface data only through its `return` value,
 * which flows into the assistant's context — impractical for large extractions (e.g. tens
 * of thousands of rows). Browser-side egress is worse: fetch() to a localhost sink is
 * silently blocked by Chrome Private Network Access, and reading the session cookie for a
 * server-side fetch is (correctly) refused as credential materialization. This channel lets
 * in-page authed fetches accumulate in the worker and be written straight to disk.
 *
 * SECURITY: mirrors export_session_raw's confinement. The write is restricted to
 * CRAWLIO_ARTIFACT_DIR (default ~/.crawlio/artifacts), the name must be a safe relative
 * path (no traversal, no absolute/home paths, limited charset), and total bytes are capped.
 * Write-only; no read/delete/exec. Nothing here can escape the artifacts directory.
 */
// Resolved at call-time (not module load) so CRAWLIO_ARTIFACT_DIR can be overridden per run/test.
export function resolveArtifactDir(): string {
  return process.env.CRAWLIO_ARTIFACT_DIR
    ? resolve(process.env.CRAWLIO_ARTIFACT_DIR)
    : join(homedir(), ".crawlio", "artifacts");
}
function resolveMaxArtifactBytes(): number {
  const raw = process.env.CRAWLIO_ARTIFACT_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512 * 1024 * 1024; // 512MB default
}

export async function saveArtifactToDisk(
  name: string,
  contents: string,
  opts?: { append?: boolean },
): Promise<{ path: string; bytes: number }> {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("saveArtifact: name (a relative file path) is required");
  }
  // Reject traversal, absolute/home-anchored paths, and anything outside a safe charset.
  if (
    name.startsWith("/") ||
    name.startsWith("~") ||
    name.startsWith("\\") ||
    /(^|[\\/])\.\.([\\/]|$)/.test(name) ||
    /[^A-Za-z0-9._/-]/.test(name)
  ) {
    throw new Error("saveArtifact: name must be a safe relative path ([A-Za-z0-9._/-], no '..')");
  }
  const dir = resolveArtifactDir();
  const outPath = resolve(dir, name);
  if (outPath !== dir && !outPath.startsWith(dir + sep)) {
    throw new Error("saveArtifact: resolved path escapes the artifacts directory");
  }
  const body = Buffer.from(String(contents ?? ""), "utf-8");
  const append = opts?.append === true;
  const maxBytes = resolveMaxArtifactBytes();
  let existing = 0;
  if (append) {
    try { existing = (await stat(outPath)).size; } catch { /* new file */ }
  }
  if (existing + body.byteLength > maxBytes) {
    throw new Error(`saveArtifact: artifact would exceed ${maxBytes} bytes (set CRAWLIO_ARTIFACT_MAX_BYTES to raise)`);
  }
  await mkdir(dirname(outPath), { recursive: true });
  if (append) await appendFile(outPath, body);
  else await writeFile(outPath, body);
  const { size } = await stat(outPath);
  return { path: outPath, bytes: size };
}

/** Cache for buildSmartObject — keyed by page URL to avoid redundant detect_framework calls */
let smartObjectCache: { url: string; smart: Record<string, unknown> } | null = null;

/**
 * Module-level findings accumulator — persists across smart object rebuilds within a session.
 * LIMITATION: stdio-only. In portal mode (multiple MCP clients per process), findings from
 * one session bleed into another. Portal mode needs per-transport scoping via a session map.
 */
let sessionFindings: Finding[] = [];

/**
 * Module-level coverage gaps — merged from extractPage calls within a session.
 * Same stdio-only limitation as sessionFindings above.
 */
let sessionGaps: CoverageGap[] = [];

/**
 * Async "fire-and-poll" job registry for code-mode `execute({ background: true })`.
 * The execute handler kicks off executeSandboxedCode WITHOUT awaiting, registers the
 * promise here under a jobId, and returns immediately — decoupling long/unattended runs
 * (e.g. heavy navigate + OCR) from the per-tool call timeout. The sandbox Worker already
 * runs detached to completion and self-terminates on its 120s hard cap (execute-sandbox.ts),
 * so this only retains the promise + result. Polled via get_job_result / list_jobs; killed
 * via cancel_job (aborts the per-job AbortController → worker.terminate()).
 *
 * Same stdio-only LIMITATION as sessionFindings above: a portal-mode (multi-client) process
 * would leak jobs across clients; per-transport scoping is a follow-up.
 */
type JobStatus = "running" | "done" | "error" | "cancelled";
interface JobRecord {
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  value?: unknown;
  console?: string[];
  error?: string;
  controller?: AbortController;
}
const jobRegistry = new Map<string, JobRecord>();
const JOB_TTL_MS = 10 * 60_000; // drop finished jobs 10 min after they settle

/** Lazy sweep — evict finished jobs older than the TTL. Called on registration + list. */
function sweepJobs(now = Date.now()): void {
  for (const [id, job] of jobRegistry) {
    if (job.status !== "running" && job.finishedAt !== undefined && now - job.finishedAt > JOB_TTL_MS) {
      jobRegistry.delete(id);
    }
  }
}

/** Summarize a raw DOM snapshot into stats (nodeCount, elementCount, textLength, depth) */
function summarizeDomSnapshot(data: Record<string, unknown>): { nodeCount: number; elementCount: number; textLength: number; depth: number } {
  let nodeCount = 0;
  let elementCount = 0;
  let textLength = 0;
  let maxDepth = 0;
  function walk(node: Record<string, unknown>, depth: number) {
    nodeCount++;
    if (depth > maxDepth) maxDepth = depth;
    if (typeof node.tag === "string") elementCount++;
    if (typeof node.text === "string") textLength += (node.text as string).length;
    const children = node.children as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(children)) {
      for (const child of children) walk(child, depth + 1);
    }
  }
  if (typeof data === "object" && data !== null) {
    if (Array.isArray(data.children)) {
      walk(data as Record<string, unknown>, 0);
    } else if (typeof data.tag === "string") {
      walk(data, 0);
    }
  }
  return { nodeCount, elementCount, textLength, depth: maxDepth };
}

/** Summarize a raw accessibility tree into an AccessibilitySummary */
function summarizeAccessibility(raw: Record<string, unknown>): AccessibilitySummary {
  const tree = (raw.tree ?? raw.nodes ?? []) as Array<Record<string, unknown>>;
  let nodeCount = typeof raw.nodeCount === "number" ? raw.nodeCount : 0;
  let landmarkCount = 0;
  let imagesWithoutAlt = 0;
  const headingStructure: Array<{ level: number; text: string }> = [];
  const landmarkRoles = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region"]);

  function walk(nodes: Array<Record<string, unknown>>) {
    for (const node of nodes) {
      nodeCount++;
      const role = String(node.role ?? "");
      if (landmarkRoles.has(role)) landmarkCount++;
      if (role === "img" || role === "image") {
        const name = String(node.name ?? "");
        if (!name) imagesWithoutAlt++;
      }
      if (role === "heading") {
        const level = typeof node.level === "number" ? node.level : 0;
        const text = String(node.name ?? "").substring(0, 120);
        if (level > 0) headingStructure.push({ level, text });
      }
      if (Array.isArray(node.children)) walk(node.children as Array<Record<string, unknown>>);
    }
  }

  if (tree.length > 0) {
    nodeCount = 0;
    walk(tree);
  }

  return { nodeCount, landmarkCount, imagesWithoutAlt, headingStructure: headingStructure.slice(0, 30) };
}

/**
 * Check if an element is actionable: exists, visible, has dimensions, not disabled.
 * Single browser_evaluate call — combines all checks in one JS expression.
 */
export async function checkActionability(
  bridge: Pick<WebSocketBridge, "send">, selector: string
): Promise<{ actionable: boolean; reason?: string }> {
  const result = await bridge.send({
    type: "browser_evaluate",
    _internal: true,
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { actionable: false, reason: 'Element not found' };
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { actionable: false, reason: 'Element has zero size' };
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') return { actionable: false, reason: 'Element is hidden (visibility)' };
      if (style.display === 'none') return { actionable: false, reason: 'Element is hidden (display:none)' };
      if (style.opacity === '0') return { actionable: false, reason: 'Element is hidden (zero opacity)' };
      if (style.pointerEvents === 'none') return { actionable: false, reason: 'Element has pointer-events: none' };
      let n = el; while (n) { if (n.disabled || n.getAttribute?.('aria-disabled') === 'true') return { actionable: false, reason: 'Element is disabled' }; n = n.parentElement; }
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r2 = el.getBoundingClientRect();
      const cx = r2.x + r2.width / 2;
      const cy = r2.y + r2.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit)) return { actionable: false, reason: 'Element is covered by another element' };
      }
      return { actionable: true };
    })()`
  }, 5000) as { result?: { actionable: boolean; reason?: string }; actionable?: boolean; reason?: string };
  // browser_evaluate wraps value in { result, type } — unwrap
  return (result.result ?? result) as { actionable: boolean; reason?: string };
}

/**
 * Poll until element is actionable, using progressive backoff.
 * Budget-style timeout — total wall time, not fixed retry count.
 */
export async function pollActionability(
  bridge: Pick<WebSocketBridge, "send">, selector: string, timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  let lastReason = "";
  while (Date.now() - start < timeoutMs) {
    const delay = ACTIONABILITY_BACKOFF[Math.min(attempt, ACTIONABILITY_BACKOFF.length - 1)];
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      const check = await checkActionability(bridge, selector);
      if (check.actionable) return;
      lastReason = check.reason ?? "unknown";
    } catch {
      lastReason = "bridge communication failure";
    }
    attempt++;
  }
  throw new Error(`Element "${selector}" not actionable after ${timeoutMs}ms: ${lastReason}`);
}

/**
 * Wrap a mutative tool handler with pre-flight actionability polling and post-action settling.
 * Retries on "element not found" up to 3 times with [20, 100, 500]ms backoff.
 */
function withAutoSettle<T extends Record<string, unknown>>(
  bridge: WebSocketBridge,
  opts: { preFlightSelector?: (args: T) => string | undefined; settleMs: number },
  handler: (args: T) => Promise<unknown>,
): (args: T) => Promise<unknown> {
  const RETRY_BACKOFF = [20, 100, 500];
  return async (args: T) => {
    const selector = opts.preFlightSelector?.(args);
    if (selector) {
      await pollActionability(bridge, selector);
    }

    let lastError: Error | null = null;
    for (let retry = 0; retry <= RETRY_BACKOFF.length; retry++) {
      try {
        const result = await handler(args);
        if (opts.settleMs > 0) {
          await new Promise(r => setTimeout(r, opts.settleMs));
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("No element") || msg.includes("not visible") || msg.includes("no node found")) {
          lastError = e instanceof Error ? e : new Error(msg);
          if (retry < RETRY_BACKOFF.length) {
            await new Promise(r => setTimeout(r, RETRY_BACKOFF[retry]));
            continue;
          }
        }
        throw e;
      }
    }
    throw lastError ?? new Error("Action failed after retries");
  };
}

// --- Tool definitions ---

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface CodeModeToolOptions {
  getActionPolicy?: () => ActionPolicy | null;
}

export function createTools(bridge: WebSocketBridge, crawlio: CrawlioClient): Tool[] {
  return [
    // --- AI orchestration tools ---
    {
      name: "connect_tab",
      description: "Pin a specific browser tab for all subsequent commands. Optional — without this, tools auto-connect to the active tab. Three modes: (1) provide a URL to find or create a tab, (2) provide a tabId to connect to a specific tab, (3) no args to pin the active tab. Starts CDP capture automatically. Pass background:true to connect + drive the tab WITHOUT stealing the user's active tab/window focus.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to — finds existing tab or creates new one" },
          tabId: { type: "number", description: "Specific tab ID to connect to (use list_tabs to discover IDs)" },
          background: { type: "boolean", description: "Connect + drive the tab without activating it or focusing its window (no focus-steal). The tab opens/loads in the background; input and screenshots use CDP so they work without foreground focus." },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          url: urlSchema.optional(),
          tabId: z.number().int().positive().optional(),
          background: z.boolean().optional(),
        });
        const parsed = schema.parse(args);
        const params: Record<string, unknown> = { type: "connect_tab" };
        if (parsed.url) params.url = parsed.url;
        if (parsed.tabId) params.tabId = parsed.tabId;
        if (parsed.background) params.background = true;
        try {
          const data = await bridge.send(params as BridgeCommand, TOOL_TIMEOUTS.connect_tab);
          return toolSuccess(shapeConnectTab(data as Record<string, unknown>));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // A CDP attach can only target an http(s) page. In active-tab / tabId mode the
          // attach silently stalls to the bridge timeout when the target is a chrome://,
          // extension, New Tab, or Web Store page (not debuggable) — or right after a
          // service-worker cold start. Turn that opaque timeout into actionable guidance
          // instead of a bare "timeout".
          if (!parsed.url) {
            return toolError(
              `connect_tab could not attach (${msg}). The target tab may be a chrome://, extension, New Tab, or Web Store page — Chrome does not permit debugging those. Switch to an http(s) tab and retry, or pass { url } to open a fresh connectable tab.`
            );
          }
          return toolError(`connect_tab failed: ${msg}`, problemOf(e));
        }
      },
    },
    {
      name: "disconnect_tab",
      description: "Disconnect from the current tab. Detaches CDP debugger, stops capture, and clears connection state. Safe to call even if not connected.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "disconnect_tab" }, TOOL_TIMEOUTS.disconnect_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "list_tabs",
      description: "List all open HTTP/HTTPS browser tabs with their IDs, URLs, titles, and which tab is currently connected. Use this to discover tab IDs for connect_tab.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "list_tabs" }, TOOL_TIMEOUTS.list_tabs) as BridgeTabsResponse;
        return toolSuccess(shapeListTabs(data));
      },
    },
    {
      name: "get_connection_status",
      description: "Get current connection state: whether a tab is connected, CDP debugger attached, MCP server connected, and capture status. Use to check if connect_tab is needed.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "get_connection_status" }, TOOL_TIMEOUTS.get_connection_status);
        return toolSuccess(data);
      },
    },
    {
      name: "reconnect_tab",
      description: "Force reconnect to the connected tab — detach CDP debugger and reattach, re-enabling all domains. Use when tools fail with stale connection or timeout errors.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "reconnect_tab" }, TOOL_TIMEOUTS.reconnect_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "get_capabilities",
      description: "List all tools and their current status based on CDP connection state. Shows which tools are available, which use fallbacks, and which are unavailable. Use to understand what you can do before calling tools.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "get_capabilities" }, TOOL_TIMEOUTS.get_capabilities);
        return toolSuccess(data);
      },
    },
    {
      name: "semantic_find",
      description: "Find page candidate refs for a natural-language query using Crawlio's local semantic grounding seam. Provider outputs are advisory and include provenance; they do not authorize actions.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language target, e.g. 'continue button' or 'email field'" },
          context: { type: "object", description: "Optional serialized GroundingContext with candidateActions/pageSnapshot/evidenceRefs" },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const parsed = z.object({
          query: z.string().min(1).max(1000),
          context: z.record(z.unknown()).optional(),
        }).parse(args);
        const data = await semanticFind(bridge, parsed.query, parsed.context);
        return toolSuccess(data);
      },
    },
    {
      name: "semantic_classify",
      description: "Classify text against caller-provided labels using Crawlio's local semantic grounding seam. Provider outputs are advisory and provenance-stamped.",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Text to classify" },
          labels: { type: "array", items: { type: "string" }, description: "Candidate labels to rank" },
        },
        required: ["input", "labels"],
      },
      handler: async (args) => {
        const parsed = z.object({
          input: z.string().min(1).max(5000),
          labels: z.array(z.string().min(1).max(200)).min(1).max(100),
        }).parse(args);
        const data = await semanticClassify(parsed.input, parsed.labels);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_create",
      description: "Create an agent-owned browser session in a background tab. The session has its own ID and is not tied to the foreground connected tab. Actions use semantic DOM/CDP operations and do not activate the tab by default.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to open in the agent-owned tab" },
          tabId: { type: "number", description: "Attach an agent session to an existing HTTP/HTTPS tab instead of creating one" },
          name: { type: "string", description: "Optional human-readable session label" },
          sessionId: { type: "string", description: "Optional caller-provided stable session id" },
          active: { type: "boolean", description: "Activate the tab on creation (default: false)" },
          background: { type: "boolean", description: "Mark the session as background-owned (default: true)" },
          viewport: {
            type: "object",
            properties: {
              width: { type: "number" },
              height: { type: "number" },
              deviceScaleFactor: { type: "number" },
              mobile: { type: "boolean" },
            },
            description: "Optional viewport emulation for this session",
          },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          url: urlSchema.optional(),
          tabId: z.number().int().positive().optional(),
          name: z.string().min(1).max(200).optional(),
          sessionId: z.string().min(1).max(100).optional(),
          active: z.boolean().default(false),
          background: z.boolean().default(true),
          viewport: agentViewportSchema,
        }).refine(d => d.url || d.tabId, { message: "url or tabId is required" });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "agent_session_create", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_create);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_list",
      description: "List agent-owned browser sessions. By default returns active/error sessions and omits closed sessions.",
      inputSchema: {
        type: "object",
        properties: {
          includeClosed: { type: "boolean", description: "Include closed sessions (default: false)" },
        },
      },
      handler: async (args) => {
        const parsed = z.object({ includeClosed: z.boolean().default(false) }).parse(args);
        const data = await bridge.send({ type: "agent_session_list", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_list);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_status",
      description: "Get status for an agent-owned browser session, including tab metadata, action count, error state, and optional page summary/artifacts.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          includePage: { type: "boolean", description: "Include page title/url/text/link/form summary (default: false)" },
          includeArtifacts: { type: "boolean", description: "Include artifact metadata (default: false)" },
          includeData: { type: "boolean", description: "Include stored artifact payloads when includeArtifacts=true (default: false)" },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          includePage: z.boolean().default(false),
          includeArtifacts: z.boolean().default(false),
          includeData: z.boolean().default(false),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_status", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_status);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_close",
      description: "Close an agent-owned browser session. By default also closes its backing tab.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          closeTab: { type: "boolean", description: "Close the backing tab (default: true)" },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          closeTab: z.boolean().default(true),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_close", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_close);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_snapshot",
      description: "Capture a snapshot from an agent-owned browser session without activating the tab. Modes: aria, screenshot, page, or all. ARIA snapshots populate refs for later agent_session_action calls.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          mode: { type: "string", enum: ["aria", "screenshot", "page", "all"], description: "Snapshot mode (default: aria)" },
          interactive: { type: "boolean", description: "ARIA mode: only include interactive nodes" },
          compact: { type: "boolean", description: "ARIA mode: compact structural output" },
          maxDepth: { type: "number", description: "ARIA max depth (0-50)" },
          selector: { type: "string", description: "Optional CSS selector to snapshot a subtree" },
          includeData: { type: "boolean", description: "Store payloads in session artifacts and return screenshot/ARIA/page data (default: true)" },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          mode: z.enum(["aria", "screenshot", "page", "all"]).default("aria"),
          interactive: z.boolean().default(false),
          compact: z.boolean().default(false),
          maxDepth: z.number().int().min(0).max(50).optional(),
          selector: selectorSchema.optional(),
          includeData: z.boolean().default(true),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_snapshot", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_snapshot);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_action",
      description: "Run one semantic action inside an agent-owned browser session without activating the tab. Prefer selector targets; refs from agent_session_snapshot also work for AX-backed elements. Supported actions include navigate, click, hover, insertText/type/fill, select, scroll, key/press/command, and evaluate.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          action: { type: "string", enum: ["navigate", "click", "hover", "insertText", "type", "fill", "select", "scroll", "key", "press", "command", "evaluate", "move_mouse"] },
          selector: { type: "string", description: "CSS selector target" },
          x: { type: "number", description: "Viewport X for move_mouse (when no selector/ref)" },
          y: { type: "number", description: "Viewport Y for move_mouse (when no selector/ref)" },
          ref: { type: "string", description: "Ref from agent_session_snapshot" },
          target: {
            type: "object",
            properties: {
              selector: { type: "string" },
              ref: { type: "string" },
            },
            description: "Alternative target wrapper",
          },
          text: { type: "string", description: "Text for insertText/type/fill" },
          value: { type: "string", description: "Value for fill/select" },
          url: { type: "string", description: "URL for navigate" },
          expression: { type: "string", description: "Expression for evaluate" },
          key: { type: "string", description: "Key for key/press/command actions" },
          command: { type: "string", description: "Command name, e.g. submit or selectAll" },
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" },
          amount: { type: "number", description: "Scroll amount in pixels" },
          clearFirst: { type: "boolean", description: "Replace existing editable text" },
          submit: { type: "boolean", description: "Submit after text entry" },
        },
        required: ["sessionId", "action"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
        }).merge(agentActionSchema).parse(args);
        const data = await bridge.send({ type: "agent_session_action", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_action);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_batch",
      description: "Run a sequential batch of semantic actions inside an agent-owned browser session. Use this for background workflows that should keep running without the user watching the browser.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          actions: {
            type: "array",
            items: { type: "object" },
            description: "Actions using the same shape as agent_session_action, without sessionId",
          },
          continueOnError: { type: "boolean", description: "Continue after a failed step (default: false)" },
        },
        required: ["sessionId", "actions"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          actions: z.array(agentActionSchema).min(1).max(50),
          continueOnError: z.boolean().default(false),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_batch", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_batch);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_artifacts",
      description: "List artifacts captured by an agent-owned browser session, including snapshots, screenshots, page summaries, and action logs. Payload data is omitted unless includeData=true.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          kind: { type: "string", enum: ["snapshot", "screenshot", "page", "action"], description: "Filter by artifact kind" },
          limit: { type: "number", description: "Max artifacts to return (default: 20)" },
          includeData: { type: "boolean", description: "Include stored artifact payloads (default: false)" },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          kind: z.enum(["snapshot", "screenshot", "page", "action"]).optional(),
          limit: z.number().int().min(1).max(40).default(20),
          includeData: z.boolean().default(false),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_artifacts", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_artifacts);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_create_tab",
      description: "Open a new tab inside an agent session's tab group, turning the session into a fleet of tabs. The tab is created in the background and CDP-attached without disturbing the foreground connected tab. Requires the tabs permission; the Chrome tab-group chip is best-effort (shown only when the optional tabGroups permission is granted).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          url: { type: "string", description: "HTTP/HTTPS URL to open (default: about:blank)" },
          active: { type: "boolean", description: "Activate the new tab (default: false)" },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          url: urlSchema.optional(),
          active: z.boolean().default(false),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_create_tab", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_create_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_claim_tab",
      description: "Adopt an existing user tab into an agent session's tab group so the agent can drive it. Rejects non-HTTP tabs and tabs already owned by another session. Requires the tabs permission; the Chrome tab-group chip is best-effort (shown only when the optional tabGroups permission is granted).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          tabId: { type: "number", description: "Existing HTTP/HTTPS tab to adopt into the session" },
        },
        required: ["sessionId", "tabId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          tabId: z.number().int().positive(),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_claim_tab", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_claim_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_name",
      description: "Set the title of an agent session's tab group (the label shown on the Chrome tab-group chip). Requires the tabs permission; the Chrome tab-group chip is best-effort (shown only when the optional tabGroups permission is granted).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          name: { type: "string", description: "Tab-group title" },
        },
        required: ["sessionId", "name"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          name: z.string().min(1).max(200),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_name", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_name);
        return toolSuccess(data);
      },
    },
    {
      name: "agent_session_finalize",
      description: "End an agent session by disposing of its tabs. keep[].status 'handoff' returns a tab to the user; 'deliverable' moves it into a dedicated '✅ Crawlio' group. Tabs the agent created and did not keep are closed; adopted user tabs are released (never closed). Requires the tabs permission; the Chrome tab-group chip is best-effort (shown only when the optional tabGroups permission is granted).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Agent session id" },
          keep: {
            type: "array",
            description: "Tabs to keep and how. Tabs omitted here are closed (agent-created) or released (user-owned).",
            items: {
              type: "object",
              properties: {
                tabId: { type: "number" },
                status: { type: "string", enum: ["handoff", "deliverable"] },
              },
              required: ["tabId", "status"],
            },
          },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const parsed = z.object({
          sessionId: z.string().min(1).max(100),
          keep: z.array(z.object({
            tabId: z.number().int().positive(),
            status: z.enum(["handoff", "deliverable"]),
          })).default([]),
        }).parse(args);
        const data = await bridge.send({ type: "agent_session_finalize", ...parsed } as BridgeCommand, TOOL_TIMEOUTS.agent_session_finalize);
        return toolSuccess(data);
      },
    },
    {
      name: "get_user_tabs",
      description: "List all of the user's open tabs across every window, most-recently-accessed first, with window and tab-group membership. Broader than list_tabs (includes non-HTTP and ungrouped tabs). Requires the tabs permission.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "get_user_tabs" } as BridgeCommand, TOOL_TIMEOUTS.get_user_tabs);
        return toolSuccess(data);
      },
    },
    {
      name: "robot_training_start",
      description: "Start a native robot-training capture run. Opens a fresh connected Chrome tab, starts CDP network capture and session recording, injects the event-driven state monitor, and writes a manifest into a run directory. Use this before a human-guided demonstration that will later be replayed by agents or synthesized into an API contract.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to open in a fresh recording tab" },
          runId: { type: "string", description: "Optional stable run id. Defaults to rt_<timestamp>_<random>" },
          outputDir: { type: "string", description: "Optional absolute or relative artifact directory. Defaults to runs/<target>-<timestamp>/<runId>" },
          maxDurationSec: { type: "number", description: "Recording auto-stop duration in seconds (10-600, default extension limit)" },
          maxInteractions: { type: "number", description: "Recording auto-stop interaction count (1-500)" },
          active: { type: "boolean", description: "Open the training tab in the foreground for manual demonstration (default: true)" },
          injectMonitor: { type: "boolean", description: "Inject the event-driven DOM/storage monitor (default: true)" },
        },
        required: ["url"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          url: urlSchema,
          runId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
          outputDir: z.string().min(1).max(2000).optional(),
          maxDurationSec: z.number().min(10).max(600).optional(),
          maxInteractions: z.number().min(1).max(500).optional(),
          active: z.boolean().default(true),
          injectMonitor: z.boolean().default(true),
        });
        const parsed = schema.parse(args);
        const data = await robotTrainingStart(bridge, parsed);
        return toolSuccess(data);
      },
    },
    {
      name: "robot_training_status",
      description: "Report active robot-training runs and the underlying browser recording status. Use while the human is demonstrating a flow or before stopping a run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Optional run id to filter" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          runId: z.string().min(1).max(100).optional(),
        }).parse(args);
        const data = await robotTrainingStatus(bridge, parsed.runId);
        return toolSuccess(data);
      },
    },
    {
      name: "robot_training_stop",
      description: "Stop a robot-training run and persist the full capture bundle: raw-dump.json, recording.json, network.json, bodies.json, state-log.json, state.json, flows.jsonl, and manifest.json. Response bodies are fetched before network capture is stopped so the run can be synthesized into OpenAPI or replay code.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "Run id returned by robot_training_start" },
          fetchBodies: { type: "boolean", description: "Fetch response bodies for captured XHR/fetch/document requests (default: true)" },
          closeTab: { type: "boolean", description: "Close the training tab after dumping artifacts (default: false)" },
        },
        required: ["runId"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          runId: z.string().min(1).max(100),
          fetchBodies: z.boolean().default(true),
          closeTab: z.boolean().default(false),
        }).parse(args);
        const data = await robotTrainingStop(bridge, parsed);
        return toolSuccess(data);
      },
    },
    {
      name: "robot_training_artifacts",
      description: "List files in a robot-training artifact directory. Use after robot_training_stop to discover recording, network, body, state, and flows.jsonl files for robot training or OpenAPI synthesis.",
      inputSchema: {
        type: "object",
        properties: {
          outputDir: { type: "string", description: "Artifact directory returned by robot_training_start/stop" },
        },
        required: ["outputDir"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          outputDir: z.string().min(1).max(2000),
        }).parse(args);
        const data = await robotTrainingArtifacts(parsed);
        return toolSuccess(data);
      },
    },
    {
      name: "recording_start",
      description: "Start a canonical RecordingBundle v1 capture. Opens a fresh connected Chrome tab, starts CDP network capture, starts session recording, injects the event-driven state monitor, and writes manifest.json.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to open in a fresh recording tab" },
          bundleID: { type: "string", description: "Optional stable bundle id. Defaults to rec/rt timestamp id" },
          outputDir: { type: "string", description: "Optional bundle artifact directory" },
          maxDurationSec: { type: "number", description: "Recording auto-stop duration in seconds (10-600)" },
          maxInteractions: { type: "number", description: "Recording auto-stop interaction count (1-500)" },
          active: { type: "boolean", description: "Open the recording tab in the foreground (default: true)" },
          injectMonitor: { type: "boolean", description: "Inject event-driven DOM/storage monitor (default: true)" },
        },
        required: ["url"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          url: urlSchema,
          bundleID: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
          outputDir: z.string().min(1).max(2000).optional(),
          maxDurationSec: z.number().min(10).max(600).optional(),
          maxInteractions: z.number().min(1).max(500).optional(),
          active: z.boolean().default(true),
          injectMonitor: z.boolean().default(true),
        }).parse(args);
        const data = await robotTrainingStart(bridge, { ...parsed, runId: parsed.bundleID });
        return toolSuccess({ ...data, schemaVersion: "crawlio.recordingBundle.v1" });
      },
    },
    {
      name: "recording_status",
      description: "Report active canonical RecordingBundle captures and the underlying browser recording status.",
      inputSchema: {
        type: "object",
        properties: {
          bundleID: { type: "string", description: "Optional bundle id to filter" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({ bundleID: z.string().min(1).max(100).optional() }).parse(args);
        const data = await robotTrainingStatus(bridge, parsed.bundleID);
        return toolSuccess(data);
      },
    },
    {
      name: "recording_stop",
      description: "Stop a canonical RecordingBundle capture. Dumps stateLog first, stops recording, fetches response bodies by requestId while CDP Network is still enabled, then stops network capture and writes all bundle artifacts.",
      inputSchema: {
        type: "object",
        properties: {
          bundleID: { type: "string", description: "Bundle id returned by recording_start" },
          fetchBodies: { type: "boolean", description: "Fetch response bodies before stopping network capture (default: true)" },
          closeTab: { type: "boolean", description: "Close the recording tab after writing artifacts (default: false)" },
        },
        required: ["bundleID"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          bundleID: z.string().min(1).max(100),
          fetchBodies: z.boolean().default(true),
          closeTab: z.boolean().default(false),
        }).parse(args);
        const data = await robotTrainingStop(bridge, { runId: parsed.bundleID, fetchBodies: parsed.fetchBodies, closeTab: parsed.closeTab });
        return toolSuccess(data);
      },
    },
    {
      name: "recording_artifacts",
      description: "List files in a canonical RecordingBundle directory without loading large bodies into the MCP response.",
      inputSchema: {
        type: "object",
        properties: {
          outputDir: { type: "string", description: "Bundle artifact directory returned by recording_start/stop" },
        },
        required: ["outputDir"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({ outputDir: z.string().min(1).max(2000) }).parse(args);
        const data = await robotTrainingArtifacts(parsed);
        return toolSuccess(data);
      },
    },
    {
      name: "recording_capture_bundle",
      description: "One-shot canonical capture for automated flows: starts a bundle, optionally waits for network idle, then stops and writes RecordingBundle v1 artifacts. For human demos prefer recording_start then recording_stop.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP/HTTPS URL to capture" },
          bundleID: { type: "string", description: "Optional stable bundle id" },
          outputDir: { type: "string", description: "Optional bundle artifact directory" },
          idleTime: { type: "number", description: "Quiet window before stop in ms (default 500)" },
          timeout: { type: "number", description: "Network idle timeout in ms (default 15000)" },
          fetchBodies: { type: "boolean", description: "Fetch response bodies before network teardown (default: true)" },
        },
        required: ["url"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          url: urlSchema,
          bundleID: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
          outputDir: z.string().min(1).max(2000).optional(),
          idleTime: z.number().int().min(100).max(5000).default(500),
          timeout: z.number().int().min(1000).max(30000).default(15000),
          fetchBodies: z.boolean().default(true),
        }).parse(args);
        const started = await robotTrainingStart(bridge, { url: parsed.url, runId: parsed.bundleID, outputDir: parsed.outputDir, active: true });
        await bridge.send({ type: "wait_for_network_idle", idleTime: parsed.idleTime, timeout: parsed.timeout } as BridgeCommand, TOOL_TIMEOUTS.wait_for_network_idle).catch(() => null);
        const runId = String((started as { runId?: unknown }).runId ?? parsed.bundleID ?? "");
        const stopped = await robotTrainingStop(bridge, { runId, fetchBodies: parsed.fetchBodies });
        return toolSuccess({ started, stopped });
      },
    },
    {
      name: "recording_validate_bundle",
      description: "Validate that a canonical RecordingBundle directory contains the required v1 artifacts.",
      inputSchema: {
        type: "object",
        properties: {
          outputDir: { type: "string", description: "Bundle artifact directory" },
        },
        required: ["outputDir"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({ outputDir: z.string().min(1).max(2000) }).parse(args);
        const data = await robotTrainingArtifacts(parsed) as { artifacts?: Array<{ name: string }> };
        const names = new Set((data.artifacts ?? []).map(a => a.name));
        const required = ["manifest.json", "recording.json", "network.json", "bodies.json", "state-log.json", "state.json", "flows.jsonl"];
        const missing = required.filter(name => !names.has(name));
        return toolSuccess({ ok: missing.length === 0, missing, outputDir: parsed.outputDir });
      },
    },
    // --- Data capture tools ---
    {
      name: "capture_page",
      description: "Capture comprehensive browser data for the active tab: framework detection, network requests, console logs, and DOM snapshot. Optionally sends results to Crawlio.",
      inputSchema: {
        type: "object",
        properties: {
          sendToCrawlio: { type: "boolean", description: "Also POST results to Crawlio ControlServer (default: true)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({ sendToCrawlio: z.boolean().optional() });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "capture_page" }, TOOL_TIMEOUTS.capture_page) as PageCapture;
        if (!data || typeof data.url !== "string") throw new Error("Bridge returned invalid capture_page response (missing url)");
        if (parsed.sendToCrawlio !== false) {
          try {
            await crawlio.postEnrichment(data.url, {
              framework: data.framework,
              networkRequests: data.networkRequests,
              consoleLogs: data.consoleLogs,
              domSnapshotJSON: data.domSnapshot ? JSON.stringify(data.domSnapshot) : undefined,
            });
          } catch (e) {
            console.error("[Tools] Failed to send to Crawlio:", e);
          }
        }
        return toolSuccess(shapeCapturePage(data));
      },
    },
    {
      name: "detect_framework",
      description: "Detect the JavaScript framework used by the active tab (Next.js, Nuxt, React, Vue, Svelte, Angular, Gatsby, Remix, Astro, etc.)",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "detect_framework" }, TOOL_TIMEOUTS.detect_framework) as FrameworkDetection;
        return toolSuccess(data);
      },
    },
    {
      name: "start_network_capture",
      description: "Start capturing network requests on the active tab via Chrome DevTools Protocol. Call stop_network_capture to retrieve results.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        await bridge.send({ type: "start_network_capture" }, TOOL_TIMEOUTS.start_network_capture);
        return toolSuccess({ status: "Network capture started" });
      },
    },
    {
      name: "stop_network_capture",
      description: "Stop network capture and return all captured requests with timing, size, and type information.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "stop_network_capture" }, TOOL_TIMEOUTS.stop_network_capture) as NetworkEntry[];
        if (!Array.isArray(data)) throw new Error("Bridge returned invalid stop_network_capture response (expected array)");
        return toolSuccess(shapeNetworkLog(data));
      },
    },
    {
      name: "get_console_logs",
      description: "Get console logs (errors, warnings, info, debug) from the active tab.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "get_console_logs" }, TOOL_TIMEOUTS.get_console_logs) as ConsoleEntry[];
        if (!Array.isArray(data)) throw new Error("Bridge returned invalid get_console_logs response (expected array)");
        return toolSuccess(shapeConsoleLogs(data));
      },
    },
    {
      name: "get_cookies",
      description: "Get cookies for the active tab's page via CDP Network.getCookies with document.cookie fallback. Returns domain-scoped cookies with sensitive values (session, csrf, auth, jwt) redacted.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        try {
          const data = await bridge.send({ type: "get_cookies" }, TOOL_TIMEOUTS.get_cookies) as { cookies: CookieEntry[]; fallbackUsed: boolean };
          if (!data || !Array.isArray(data.cookies)) throw new Error("Bridge returned invalid get_cookies response (missing cookies array)");
          return toolSuccess(shapeCookies(data));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`get_cookies failed: ${msg}. CDP domain: Network. Suggestion: use reconnect_tab to re-establish the CDP connection.`, problemOf(e));
        }
      },
    },
    {
      name: "export_session_raw",
      description: "Export the active tab's cookies to ~/.crawlio/<domain>-session.json WITHOUT redaction, so you can reuse your own authenticated session across runs. Writes the raw CDP cookie array to disk — the file contains live credentials, so treat it like a password and keep it out of version control. The output path is confined to your home directory. Optionally filter by a specific domain.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Domain to filter cookies for (e.g. 'example.com'). Defaults to the active tab's base domain." },
          outputPath: { type: "string", description: "Override the output file path; must be inside your home directory. Defaults to ~/.crawlio/<domain>-session.json" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          domain: z.string().optional(),
          outputPath: z.string().optional(),
        });
        const parsed = schema.parse(args);
        try {
          const data = await bridge.send(
            { type: "export_session_raw", domain: parsed.domain } as unknown as Parameters<typeof bridge.send>[0],
            TOOL_TIMEOUTS.export_session_raw
          ) as { cookies: unknown[]; count: number; domain: string };

          if (!data || !Array.isArray(data.cookies)) throw new Error("Bridge returned invalid export_session_raw response");

          const safeName = (data.domain ?? "session").replace(/[^a-z0-9.-]/gi, "_");
          // SECURITY: this writes the UNREDACTED cookie array to disk. A caller-supplied
          // outputPath left unconstrained is an arbitrary file-write/overwrite primitive
          // (clobber a dotfile, drop a LaunchAgent, etc.) — the mkdir below is recursive.
          // Confine the write to the user's home directory, the only place a session-export
          // convenience file legitimately belongs. The default already lives under ~/.crawlio.
          const home = homedir();
          const outPath = parsed.outputPath ? resolve(parsed.outputPath) : join(home, ".crawlio", `${safeName}-session.json`);
          if (outPath !== home && !outPath.startsWith(home + sep)) {
            return toolError(`export_session_raw: outputPath must be within your home directory (${home})`);
          }

          const { mkdir } = await import("fs/promises");
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(outPath, JSON.stringify(data.cookies, null, 2), "utf-8");

          return toolSuccess({
            exported: data.count,
            domain: data.domain,
            path: outPath,
            note: "Cookie values are unredacted. Keep this file private — it grants full session access.",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`export_session_raw failed: ${msg}`, problemOf(e));
        }
      },
    },
    {
      name: "get_dom_snapshot",
      description: "Get a simplified DOM snapshot of the active tab (strips script/style/svg, captures tag/attrs/text/children). Returns stats summary by default; set summarize=false for full tree.",
      inputSchema: {
        type: "object",
        properties: {
          maxDepth: { type: "number", description: "Maximum depth of DOM tree to capture (default: 10)" },
          summarize: { type: "boolean", description: "Return stats summary instead of raw tree (default: true)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          maxDepth: z.number().int().min(1).max(50).default(10),
          summarize: z.boolean().default(true),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "get_dom_snapshot", maxDepth: parsed.maxDepth }, TOOL_TIMEOUTS.get_dom_snapshot) as Record<string, unknown>;
        if (parsed.summarize) {
          return toolSuccess(summarizeDomSnapshot(data));
        }
        return toolSuccess(data);
      },
    },
    {
      name: "take_screenshot",
      description: "Take a screenshot of the active tab. Returns base64-encoded PNG.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "take_screenshot" }, TOOL_TIMEOUTS.take_screenshot) as { data: string };
        if (!data || typeof data.data !== "string") throw new Error("Bridge returned invalid take_screenshot response (missing data)");
        return { content: [{ type: "image" as const, data: data.data, mimeType: "image/png" }], isError: false };
      },
    },
    {
      name: "extract_site",
      description: "Start a Crawlio crawl of the active tab's URL. Requires Crawlio to be running.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to crawl (default: active tab URL)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({ url: urlSchema.optional() });
        const parsed = schema.parse(args);
        let url = parsed.url;
        if (!url) {
          const tab = await bridge.send({ type: "get_active_tab" }, TOOL_TIMEOUTS.extract_site) as { url: string };
          url = tab.url;
        }
        const result = await crawlio.startCrawl(url!);
        return toolSuccess(result);
      },
    },
    {
      name: "get_crawl_status",
      description: "Get the current Crawlio crawl status (progress, speed, state).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const status = await crawlio.getStatus();
        return toolSuccess(status);
      },
    },
    {
      name: "get_enrichment",
      description: "Get browser enrichment data stored in Crawlio for a URL (framework, network, console, DOM).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to query enrichment for (omit for all)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({ url: urlSchema.optional() });
        const parsed = schema.parse(args);
        // Try extension accumulator first (works without desktop app)
        try {
          const bridgeData = await bridge.send({ type: "get_enrichment", url: parsed.url } as BridgeCommand, 5000) as Record<string, unknown> | null;
          if (bridgeData) return toolSuccess(bridgeData);
        } catch { /* bridge unavailable, fall through */ }
        // Fall back to Crawlio desktop app
        const data = await crawlio.getEnrichment(parsed.url);
        return toolSuccess(data);
      },
    },
    {
      name: "get_crawled_urls",
      description: "Get URLs crawled by Crawlio with their status, content type, and size. Supports filtering by status (queued/downloading/completed/failed) and type (html/css/js/image). Returns paginated results.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: queued, downloading, parsing, localizing, completed, failed, cancelled" },
          type: { type: "string", description: "Filter by content type substring (e.g. html, css, javascript, image)" },
          limit: { type: "number", description: "Max results to return (default: 100)" },
          offset: { type: "number", description: "Offset for pagination (default: 0)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          status: z.enum(["queued", "downloading", "parsing", "localizing", "completed", "failed", "cancelled"]).optional(),
          type: z.string().max(50).optional(),
          limit: z.number().int().min(1).max(1000).default(100),
          offset: z.number().int().min(0).default(0),
        });
        const parsed = schema.parse(args);
        const data = await crawlio.getCrawledURLs({
          status: parsed.status,
          type: parsed.type,
          limit: parsed.limit,
          offset: parsed.offset,
        });
        return toolSuccess(data);
      },
    },
    {
      name: "enrich_url",
      description: "Navigate to a URL, capture browser intelligence (framework, network, console, DOM), and send enrichment to Crawlio — all in one call. Compound tool: connects tab if needed, navigates, waits for hydration, captures, and posts enrichment. Returns a compact summary (not the full capture).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to and enrich" },
          waitMs: { type: "number", description: "Milliseconds to wait after navigation for SPA hydration (default: 500, max: 5000)" },
        },
        required: ["url"],
      },
      handler: async (args) => {
        const schema = z.object({
          url: urlSchema,
          waitMs: z.number().int().min(0).max(5000).default(500),
        });
        const parsed = schema.parse(args);

        const connStatus = await bridge.send({ type: "get_connection_status" }, 5000) as { connected?: boolean };
        if (!connStatus.connected) {
          await bridge.send({ type: "connect_tab" } as BridgeCommand, 15000);
        }

        await bridge.send({ type: "browser_navigate", url: parsed.url } as BridgeCommand, 45000);

        if (parsed.waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, parsed.waitMs));
        }

        const capture = await bridge.send({ type: "capture_page" }, 45000) as PageCapture;

        let enrichmentSent = false;
        try {
          await crawlio.postEnrichment(capture.url || parsed.url, {
            framework: capture.framework,
            networkRequests: capture.networkRequests,
            consoleLogs: capture.consoleLogs,
            domSnapshotJSON: capture.domSnapshot ? JSON.stringify(capture.domSnapshot) : undefined,
          });
          enrichmentSent = true;
        } catch (e) {
          console.error("[enrich_url] Failed to send enrichment to Crawlio:", e);
        }

        const summary = {
          url: capture.url || parsed.url,
          title: capture.title || null,
          framework: capture.framework || null,
          networkRequestCount: capture.networkRequests?.length ?? 0,
          consoleLogCount: capture.consoleLogs?.length ?? 0,
          hasDomSnapshot: !!capture.domSnapshot,
          enrichmentSent,
          capturedAt: new Date().toISOString(),
        };

        return toolSuccess(summary);
      },
    },
    // --- Browser interaction tools ---
    {
      name: "browser_navigate",
      description: "Navigate the active tab to a URL. Waits for page load to complete, then settles 1000ms for SPA hydration before returning.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
        },
        required: ["url"],
      },
      handler: withAutoSettle<Record<string, unknown>>(
        bridge,
        { settleMs: 1000 },
        async (args) => {
          const schema = z.object({ url: urlSchema });
          const parsed = schema.parse(args);
          const result = await bridge.send({ type: "browser_navigate", url: parsed.url }, TOOL_TIMEOUTS.browser_navigate);
          return toolSuccess(result);
        },
      ),
    },
    {
      name: "browser_click",
      description: "Click an element on the active tab. Target by ref (from browser_snapshot, preferred) or CSS selector. Auto-waits for element to be visible and enabled before acting. Settles 500ms after action for SPA re-renders.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot (e.g., 'e3'). Preferred over selector." },
          selector: { type: "string", description: "CSS selector of element to click" },
          button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)" },
          modifiers: {
            type: "object",
            properties: {
              ctrl: { type: "boolean" },
              alt: { type: "boolean" },
              shift: { type: "boolean" },
              meta: { type: "boolean" },
            },
            description: "Modifier keys to hold during click",
          },
        },
      },
      handler: withAutoSettle<Record<string, unknown>>(
        bridge,
        { preFlightSelector: (a) => a.selector as string | undefined, settleMs: 500 },
        async (args) => {
          const schema = z.object({
            ref: z.string().optional(),
            selector: selectorSchema.optional(),
            button: z.enum(["left", "right", "middle"]).default("left"),
            modifiers: modifiersSchema,
          }).refine(d => d.ref || d.selector, { message: "ref or selector is required" });
          const parsed = schema.parse(args);
          const result = await bridge.send({
            type: "browser_click",
            ref: parsed.ref,
            selector: parsed.selector,
            button: parsed.button,
            modifiers: parsed.modifiers,
          }, TOOL_TIMEOUTS.browser_click);
          return toolSuccess(shapeInteraction(result));
        },
      ),
    },
    {
      name: "browser_type",
      description: "Type text into an editable element. Uses atomic Input.insertText by default (no double-character bugs on SPAs). Set slowly=true for per-character key events. Set submit=true to press Enter after typing.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot (e.g., 'e3'). Preferred over selector." },
          selector: { type: "string", description: "CSS selector of element to type into" },
          text: { type: "string", description: "Text to type" },
          clearFirst: { type: "boolean", description: "Clear existing text before typing (default: false)" },
          slowly: { type: "boolean", description: "Type character-by-character with key events instead of atomic insert (default: false)" },
          submit: { type: "boolean", description: "Press Enter after typing (default: false)" },
          modifiers: {
            type: "object",
            properties: {
              ctrl: { type: "boolean" },
              alt: { type: "boolean" },
              shift: { type: "boolean" },
              meta: { type: "boolean" },
            },
            description: "Modifier keys to hold during typing",
          },
        },
        required: ["text"],
      },
      handler: withAutoSettle<Record<string, unknown>>(
        bridge,
        { preFlightSelector: (a) => a.selector as string | undefined, settleMs: 300 },
        async (args) => {
          const schema = z.object({
            ref: z.string().optional(),
            selector: selectorSchema.optional(),
            text: z.string().min(1).max(10000),
            clearFirst: z.boolean().default(false),
            slowly: z.boolean().default(false),
            submit: z.boolean().default(false),
            modifiers: modifiersSchema,
          }).refine(d => d.ref || d.selector, { message: "ref or selector is required" });
          const parsed = schema.parse(args);
          const result = await bridge.send({
            type: "browser_type",
            ref: parsed.ref,
            selector: parsed.selector,
            text: parsed.text,
            clearFirst: parsed.clearFirst,
            slowly: parsed.slowly,
            submit: parsed.submit,
            modifiers: parsed.modifiers,
          }, TOOL_TIMEOUTS.browser_type);
          return toolSuccess(shapeInteraction(result));
        },
      ),
    },
    {
      name: "browser_press_key",
      description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, Backspace, etc.). Dispatches keyDown + keyUp events via CDP. Supports modifier keys.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name (e.g. Enter, Tab, Escape, ArrowDown, Backspace, Space, Home, End, F1-F12)" },
          modifiers: {
            type: "object",
            properties: {
              ctrl: { type: "boolean" },
              alt: { type: "boolean" },
              shift: { type: "boolean" },
              meta: { type: "boolean" },
            },
            description: "Modifier keys to hold during key press",
          },
        },
        required: ["key"],
      },
      handler: async (args) => {
        const schema = z.object({
          key: z.string().min(1).max(50),
          modifiers: modifiersSchema,
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_press_key",
          key: parsed.key,
          modifiers: parsed.modifiers,
        }, TOOL_TIMEOUTS.browser_press_key);
        return toolSuccess(shapeInteraction(result));
      },
    },
    {
      name: "browser_hover",
      description: "Hover over an element on the active tab. Target by ref (from browser_snapshot, preferred) or CSS selector. Dispatches a mouseMoved event to the element's center coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot (e.g., 'e3'). Preferred over selector." },
          selector: { type: "string", description: "CSS selector of element to hover over" },
          modifiers: {
            type: "object",
            properties: {
              ctrl: { type: "boolean" },
              alt: { type: "boolean" },
              shift: { type: "boolean" },
              meta: { type: "boolean" },
            },
            description: "Modifier keys to hold during hover",
          },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          ref: z.string().optional(),
          selector: selectorSchema.optional(),
          modifiers: modifiersSchema,
        }).refine(d => d.ref || d.selector, { message: "ref or selector is required" });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_hover",
          ref: parsed.ref,
          selector: parsed.selector,
          modifiers: parsed.modifiers,
        }, TOOL_TIMEOUTS.browser_hover);
        return toolSuccess(shapeInteraction(result));
      },
    },
    {
      name: "browser_select_option",
      description: "Select an option in a <select> element by value. Target by ref (from browser_snapshot, preferred) or CSS selector. Auto-waits for element to be visible and enabled before acting. Settles 500ms after selection.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot (e.g., 'e3'). Preferred over selector." },
          selector: { type: "string", description: "CSS selector of the <select> element" },
          value: { type: "string", description: "Option value to select" },
        },
        required: ["value"],
      },
      handler: withAutoSettle<Record<string, unknown>>(
        bridge,
        { preFlightSelector: (a) => a.selector as string | undefined, settleMs: 500 },
        async (args) => {
          const schema = z.object({
            ref: z.string().optional(),
            selector: selectorSchema.optional(),
            value: z.string().max(1000),
          }).refine(d => d.ref || d.selector, { message: "ref or selector is required" });
          const parsed = schema.parse(args);
          const result = await bridge.send({
            type: "browser_select_option",
            ref: parsed.ref,
            selector: parsed.selector,
            value: parsed.value,
          }, TOOL_TIMEOUTS.browser_select_option);
          return toolSuccess(shapeInteraction(result));
        },
      ),
    },
    {
      name: "browser_wait",
      description: "Wait for a specified number of seconds (max 30). Useful for waiting for animations, network requests, or page transitions.",
      inputSchema: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "Number of seconds to wait (max 30)" },
        },
        required: ["seconds"],
      },
      handler: async (args) => {
        const schema = z.object({ seconds: z.number().min(0.1).max(30) });
        const parsed = schema.parse(args);
        const result = await bridge.send({ type: "browser_wait", seconds: parsed.seconds }, TOOL_TIMEOUTS.browser_wait);
        return toolSuccess(result);
      },
    },
    {
      name: "browser_fill_form",
      description: "Fill multiple form fields at once. Each field is targeted by ref (from browser_snapshot). Supports textbox, checkbox, radio, and combobox types. Returns post-fill snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "Element ref from browser_snapshot (e.g., 'e3')" },
                type: { type: "string", enum: ["textbox", "searchbox", "checkbox", "radio", "combobox"], description: "Field type (default: textbox)" },
                value: { type: "string", description: "Value to fill (text for textbox/combobox, ignored for checkbox/radio toggle)" },
              },
              required: ["ref", "value"],
            },
            description: "Array of fields to fill",
          },
        },
        required: ["fields"],
      },
      handler: async (args) => {
        const schema = z.object({
          fields: z.array(z.object({
            ref: z.string(),
            type: z.enum(["textbox", "searchbox", "checkbox", "radio", "combobox"]).default("textbox"),
            value: z.string(),
          })).min(1).max(50),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_fill_form",
          fields: parsed.fields,
        }, TOOL_TIMEOUTS.browser_fill_form ?? 15000);
        return toolSuccess(shapeInteraction(result));
      },
    },
    {
      name: "browser_evaluate",
      description: "Execute a JavaScript expression in the page context and return the result. Useful for reading page state, checking values, or performing calculations.",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: `JavaScript expression to evaluate (max ${MAX_EVAL_EXPRESSION_LENGTH} chars)` },
        },
        required: ["expression"],
      },
      handler: async (args) => {
        const schema = z.object({
          expression: z.string().min(1).max(MAX_EVAL_EXPRESSION_LENGTH),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_evaluate",
          expression: parsed.expression,
        }, TOOL_TIMEOUTS.browser_evaluate ?? 10000);
        return toolSuccess(result);
      },
    },
    // --- ARIA Snapshot tool ---
    {
      name: "browser_snapshot",
      description: "Capture accessibility snapshot of the current page. Returns a compact ARIA tree with ref strings (e.g., [ref=e1]) for interactive elements. Use refs with browser_click, browser_type, browser_hover to target elements without constructing CSS selectors. Refs are valid until the page navigates or significant DOM changes occur — call browser_snapshot again after navigation. Options: interactive=true for 60-80% token reduction (interactive elements only), compact=true to remove empty structural branches, maxDepth to limit tree depth, selector to scope to a CSS subtree.",
      inputSchema: {
        type: "object",
        properties: {
          interactive: { type: "boolean", description: "Interactive-only mode: show only buttons, links, inputs, etc. 60-80% token reduction." },
          compact: { type: "boolean", description: "Remove structural elements with no interactive descendants." },
          maxDepth: { type: "number", description: "Maximum tree depth (0 = root only, default: unlimited)." },
          selector: { type: "string", description: "CSS selector to scope snapshot to a subtree (e.g., '#main', '.content')." },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          interactive: z.boolean().optional(),
          compact: z.boolean().optional(),
          maxDepth: z.number().int().min(0).max(50).optional(),
          selector: z.string().max(500).optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "browser_snapshot",
          ...(parsed.interactive !== undefined && { interactive: parsed.interactive }),
          ...(parsed.compact !== undefined && { compact: parsed.compact }),
          ...(parsed.maxDepth !== undefined && { maxDepth: parsed.maxDepth }),
          ...(parsed.selector !== undefined && { selector: parsed.selector }),
        }, TOOL_TIMEOUTS.browser_snapshot);
        return toolSuccess(data);
      },
    },
    // --- Snapshot diffing tool ---
    {
      name: "diff_snapshot",
      description: "Compare the current ARIA snapshot against a previous one using Myers line-level diff. Returns a unified diff with addition/removal stats. If no baseline is provided, diffs against the last cached snapshot (from the most recent browser_snapshot call). Use this to verify interaction effects — click a button, then diff to see what changed.",
      inputSchema: {
        type: "object",
        properties: {
          baseline: { type: "string", description: "Previous snapshot text to diff against. If omitted, uses the last cached snapshot." },
          selector: { type: "string", description: "CSS selector to scope the current snapshot to a subtree." },
          compact: { type: "boolean", description: "Remove structural elements with no interactive descendants from current snapshot." },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          baseline: z.string().optional(),
          selector: z.string().max(500).optional(),
          compact: z.boolean().optional(),
        });
        const parsed = schema.parse(args);

        // Get baseline + current from the extension
        const extensionResult = await bridge.send({
          type: "diff_snapshot",
          ...(parsed.baseline !== undefined && { baseline: parsed.baseline }),
        }, TOOL_TIMEOUTS.browser_snapshot);

        const { baseline, current } = extensionResult as { baseline: string; current: string };

        // Compute diff on the MCP server side
        const result = computeDiff(baseline, current);
        return toolSuccess(result);
      },
    },
    // --- Element waiting tool ---
    {
      name: "browser_wait_for",
      description: "Wait for an element matching a CSS selector to reach a specific state. States: 'attached' (exists in DOM), 'visible' (visible and has dimensions), 'hidden' (not visible or not in DOM), 'detached' (removed from DOM). Returns when condition is met or timeout expires.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to wait for" },
          state: { type: "string", enum: ["attached", "visible", "hidden", "detached"], description: "Target state (default: visible)" },
          timeout: { type: "number", description: "Max wait time in ms (default: 30000, max: 60000)" },
        },
        required: ["selector"],
      },
      handler: async (args) => {
        const schema = z.object({
          selector: selectorSchema,
          state: z.enum(["attached", "visible", "hidden", "detached"]).default("visible"),
          timeout: z.number().int().min(100).max(60000).default(30000),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "wait_for_selector",
          selector: parsed.selector,
          state: parsed.state,
          timeout: parsed.timeout,
        }, TOOL_TIMEOUTS.browser_wait_for);
        return toolSuccess(result);
      },
    },
    // --- Network interception tool ---
    {
      name: "browser_intercept",
      description: "Intercept network requests on the active tab via CDP Fetch domain. Can block, modify headers, or mock responses for matching URL patterns. Call with action='disable' to stop interception.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["enable", "disable"], description: "Enable or disable interception (default: enable)" },
          patterns: {
            type: "array",
            description: "Interception rules (required when action=enable)",
            items: {
              type: "object",
              properties: {
                urlPattern: { type: "string", description: "Glob-style URL pattern (e.g. '*://example.com/*', '*.js')" },
                action: { type: "string", enum: ["block", "modify", "mock"], description: "What to do with matching requests" },
                modifyHeaders: { type: "object", description: "Headers to add/override (for action=modify)" },
                mockResponse: {
                  type: "object",
                  description: "Mock response (for action=mock)",
                  properties: {
                    status: { type: "number", description: "HTTP status code" },
                    headers: { type: "object", description: "Response headers" },
                    body: { type: "string", description: "Response body" },
                  },
                },
              },
              required: ["urlPattern", "action"],
            },
          },
        },
      },
      handler: async (args) => {
        const patternSchema = z.object({
          urlPattern: z.string().min(1).max(2000),
          action: z.enum(["block", "modify", "mock"]),
          modifyHeaders: z.record(z.string()).optional(),
          mockResponse: z.object({
            status: z.number().int().min(100).max(599).optional(),
            headers: z.record(z.string()).optional(),
            body: z.string().optional(),
          }).optional(),
        });
        const schema = z.object({
          action: z.enum(["enable", "disable"]).default("enable"),
          patterns: z.array(patternSchema).optional(),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_intercept",
          action: parsed.action,
          patterns: parsed.patterns,
        }, TOOL_TIMEOUTS.browser_intercept);
        return toolSuccess(result);
      },
    },
    // --- Frame execution context tools ---
    {
      name: "get_frame_tree",
      description: "Get the frame hierarchy of the current page. Returns all frames (main + iframes) with their IDs, URLs, names, and parent relationships. Use frameId with switch_to_frame to execute JS in a specific frame.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "get_frame_tree" }, TOOL_TIMEOUTS.get_frame_tree);
        return toolSuccess(data);
      },
    },
    {
      name: "switch_to_frame",
      description: "Switch execution context to a specific frame by its frameId (from get_frame_tree). Subsequent browser_evaluate, browser_click, browser_type, and browser_wait_for calls will run in this frame until switched back.",
      inputSchema: {
        type: "object",
        properties: {
          frameId: { type: "string", description: "Frame ID from get_frame_tree" },
        },
        required: ["frameId"],
      },
      handler: async (args) => {
        const schema = z.object({ frameId: z.string().min(1) });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "switch_to_frame", frameId: parsed.frameId }, TOOL_TIMEOUTS.switch_to_frame);
        return toolSuccess(data);
      },
    },
    {
      name: "switch_to_main_frame",
      description: "Switch execution context back to the main (top-level) frame. Use after switch_to_frame to return to the main page context.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "switch_to_main_frame" }, TOOL_TIMEOUTS.switch_to_main_frame);
        return toolSuccess(data);
      },
    },
    // --- Tab management tools ---
    {
      name: "create_tab",
      description: "Create a new browser tab with the given URL. Pass connect:true to auto-attach CDP and start capturing — the tab is immediately ready for interaction (screenshot, evaluate, navigate, etc).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open in the new tab" },
          active: { type: "boolean", description: "Whether to make the new tab active/focused (default: true)" },
          connect: { type: "boolean", description: "Auto-connect CDP debugger after creation — tab is ready for interaction immediately (default: false)" },
        },
        required: ["url"],
      },
      handler: async (args) => {
        const schema = z.object({
          url: urlSchema,
          active: z.boolean().default(true),
          connect: z.boolean().default(false),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "create_tab",
          url: parsed.url,
          active: parsed.active,
          connect: parsed.connect,
        }, TOOL_TIMEOUTS.create_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "close_tab",
      description: "Close a browser tab by its ID. If the tab is currently connected for CDP capture, it will be disconnected first. Returns success/failure.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "Tab ID to close (from list_tabs)" },
        },
        required: ["tabId"],
      },
      handler: async (args) => {
        const schema = z.object({ tabId: z.number().int().positive() });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "close_tab", tabId: parsed.tabId }, TOOL_TIMEOUTS.close_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "switch_tab",
      description: "Switch browser focus to a specific tab by its ID. Makes the tab active/visible. Does NOT connect CDP — use connect_tab after switching if needed.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "Tab ID to activate (from list_tabs)" },
        },
        required: ["tabId"],
      },
      handler: async (args) => {
        const schema = z.object({ tabId: z.number().int().positive() });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "switch_tab", tabId: parsed.tabId }, TOOL_TIMEOUTS.switch_tab);
        return toolSuccess(data);
      },
    },
    {
      name: "set_cookie",
      description: "Set a browser cookie. Requires name, value, and domain at minimum. The cookie is set via CDP Network.setCookie, not document.cookie, so httpOnly cookies can be set.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Cookie name" },
          value: { type: "string", description: "Cookie value" },
          domain: { type: "string", description: "Cookie domain (e.g., '.example.com')" },
          path: { type: "string", description: "Cookie path (default: '/')" },
          secure: { type: "boolean", description: "Secure flag (default: false)" },
          httpOnly: { type: "boolean", description: "HttpOnly flag (default: false)" },
          sameSite: { type: "string", enum: ["Strict", "Lax", "None"], description: "SameSite attribute" },
          expires: { type: "number", description: "Expiry as Unix timestamp (seconds). Omit for session cookie." },
        },
        required: ["name", "value", "domain"],
      },
      handler: async (args) => {
        const schema = z.object({
          name: z.string().min(1),
          value: z.string(),
          domain: z.string().min(1),
          path: z.string().optional(),
          secure: z.boolean().optional(),
          httpOnly: z.boolean().optional(),
          sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
          expires: z.number().optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "set_cookie", ...parsed }, TOOL_TIMEOUTS.set_cookie);
        return toolSuccess(data);
      },
    },
    {
      name: "delete_cookies",
      description: "Delete browser cookies matching the given criteria. At minimum, name is required. Optionally scope by domain and path.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Cookie name to delete" },
          domain: { type: "string", description: "Domain scope (optional)" },
          path: { type: "string", description: "Path scope (optional)" },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const schema = z.object({
          name: z.string().min(1),
          domain: z.string().optional(),
          path: z.string().optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({ type: "delete_cookies", ...parsed }, TOOL_TIMEOUTS.delete_cookies);
        return toolSuccess(data);
      },
    },
    {
      name: "get_storage",
      description: "Read localStorage or sessionStorage items for the current page. Returns all items as key-value pairs, or a single item if key is specified.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["local", "session"], description: "Storage type (default: local)" },
          key: { type: "string", description: "Specific key to retrieve (optional — returns all if omitted)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          type: z.enum(["local", "session"]).optional(),
          key: z.string().optional(),
        });
        const parsed = schema.parse(args);
        try {
          const data = await bridge.send({
            type: "get_storage",
            storageType: parsed.type ?? "local",
            key: parsed.key,
          }, TOOL_TIMEOUTS.get_storage);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`get_storage failed: ${msg}. CDP domain: DOMStorage. Suggestion: use reconnect_tab to re-establish the CDP connection.`, problemOf(e));
        }
      },
    },
    {
      name: "set_storage",
      description: "Set a localStorage or sessionStorage item for the current page.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["local", "session"], description: "Storage type (default: local)" },
          key: { type: "string", description: "Storage key" },
          value: { type: "string", description: "Storage value" },
        },
        required: ["key", "value"],
      },
      handler: async (args) => {
        const schema = z.object({
          type: z.enum(["local", "session"]).optional(),
          key: z.string().min(1),
          value: z.string(),
        });
        const parsed = schema.parse(args);
        try {
          const data = await bridge.send({
            type: "set_storage",
            storageType: parsed.type ?? "local",
            key: parsed.key,
            value: parsed.value,
          }, TOOL_TIMEOUTS.set_storage);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`set_storage failed: ${msg}. CDP domain: DOMStorage. Suggestion: use reconnect_tab to re-establish the CDP connection.`, problemOf(e));
        }
      },
    },
    {
      name: "clear_storage",
      description: "Clear all localStorage or sessionStorage items for the current page.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["local", "session"], description: "Storage type (default: local)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          type: z.enum(["local", "session"]).optional(),
        });
        const parsed = schema.parse(args);
        try {
          const data = await bridge.send({
            type: "clear_storage",
            storageType: parsed.type ?? "local",
          }, TOOL_TIMEOUTS.clear_storage);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`clear_storage failed: ${msg}. CDP domain: DOMStorage. Suggestion: use reconnect_tab to re-establish the CDP connection.`, problemOf(e));
        }
      },
    },
    // Dialog control
    {
      name: "get_dialog",
      description: "Get the current pending JavaScript dialog (alert/confirm/prompt/beforeunload). Returns null if no dialog is open. Use handle_dialog to accept or dismiss it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({ type: "get_dialog" }, TOOL_TIMEOUTS.get_dialog);
        return toolSuccess(data);
      },
    },
    {
      name: "handle_dialog",
      description: "Accept or dismiss the current JavaScript dialog. For 'prompt' dialogs, optionally provide text to enter. For 'beforeunload' dialogs, accept=true allows navigation, accept=false stays on page.",
      inputSchema: {
        type: "object",
        properties: {
          accept: { type: "boolean", description: "true to accept/OK, false to dismiss/Cancel" },
          promptText: { type: "string", description: "Text to enter for prompt dialogs (ignored for alert/confirm)" },
        },
        required: ["accept"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          accept: z.boolean(),
          promptText: z.string().optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "handle_dialog",
          accept: parsed.accept,
          promptText: parsed.promptText,
        }, TOOL_TIMEOUTS.handle_dialog);
        return toolSuccess(data);
      },
    },
    {
      name: "get_response_body",
      description: "Get the response body for a network request by URL or requestId. The request must have been captured during the current network capture session. Returns body as text (HTML/JSON/CSS) or base64 (binary content like images).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL of the request to get the body for (matches against captured network requests)" },
          requestId: { type: "string", description: "Specific requestId if known (from network capture events)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          url: z.string().optional(),
          requestId: z.string().min(1).optional(),
        }).refine(d => d.url || d.requestId, "Either url or requestId must be provided");
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "get_response_body",
          url: parsed.url,
          requestId: parsed.requestId,
        }, TOOL_TIMEOUTS.get_response_body);
        return toolSuccess(data);
      },
    },
    // Network replay
    {
      name: "replay_request",
      description: "Re-fire a previously captured network request with optional modifications. Requires active network capture. Specify the request by URL. Optionally override headers, body, or method. Returns the new response status, headers, and body. Useful for API testing, auth token replay, and form submission testing.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL of the captured request to replay" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], description: "Override HTTP method" },
          headers: { type: "object", description: "Override or add headers (merged with original captured headers)" },
          body: { type: "string", description: "Override request body (for POST/PUT)" },
          followRedirects: { type: "boolean", description: "Follow 3xx redirects (default: true)" },
        },
        required: ["url"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          url: z.string().url(),
          method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]).optional(),
          headers: z.record(z.string()).optional(),
          body: z.string().optional(),
          followRedirects: z.boolean().optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "replay_request",
          url: parsed.url,
          method: parsed.method,
          headers: parsed.headers,
          body: parsed.body,
          followRedirects: parsed.followRedirects,
        }, TOOL_TIMEOUTS.replay_request);
        return toolSuccess(data);
      },
    },
    // Viewport & device emulation
    {
      name: "set_viewport",
      description: "Set the browser viewport dimensions. Affects page layout and media queries. Does not affect the actual browser window size.",
      inputSchema: {
        type: "object",
        properties: {
          width: { type: "number", description: "Viewport width in pixels" },
          height: { type: "number", description: "Viewport height in pixels" },
          deviceScaleFactor: { type: "number", description: "Device scale factor / DPI (default: 1)" },
          mobile: { type: "boolean", description: "Whether to emulate mobile viewport (default: false)" },
        },
        required: ["width", "height"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          width: z.number().int().min(1).max(10000),
          height: z.number().int().min(1).max(10000),
          deviceScaleFactor: z.number().min(0).max(10).optional(),
          mobile: z.boolean().optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "set_viewport",
          width: parsed.width,
          height: parsed.height,
          deviceScaleFactor: parsed.deviceScaleFactor ?? 1,
          mobile: parsed.mobile ?? false,
        }, TOOL_TIMEOUTS.set_viewport);
        return toolSuccess(data);
      },
    },
    {
      name: "set_user_agent",
      description: "Override the browser's User-Agent string. Affects all subsequent requests and navigator.userAgent.",
      inputSchema: {
        type: "object",
        properties: {
          userAgent: { type: "string", description: "Custom User-Agent string" },
        },
        required: ["userAgent"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          userAgent: z.string().min(1).max(1000),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "set_user_agent",
          userAgent: parsed.userAgent,
        }, TOOL_TIMEOUTS.set_user_agent);
        return toolSuccess(data);
      },
    },
    {
      name: "emulate_device",
      description: "Emulate a specific device by name. Sets viewport, scale factor, user agent, and mobile flag to match the device. Supported: 'iPhone 14', 'iPhone 14 Pro Max', 'iPhone SE', 'iPad Pro 11', 'iPad Mini', 'Pixel 7', 'Galaxy S24', 'Desktop 1920x1080', 'Desktop 1440x900', 'Desktop 1366x768'.",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "Device name (e.g., 'iPhone 14')" },
        },
        required: ["device"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          device: z.enum(["iPhone 14", "iPhone 14 Pro Max", "iPhone SE", "iPad Pro 11", "iPad Mini", "Pixel 7", "Galaxy S24", "Desktop 1920x1080", "Desktop 1440x900", "Desktop 1366x768"]),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "emulate_device",
          device: parsed.device,
        }, TOOL_TIMEOUTS.emulate_device);
        return toolSuccess(data);
      },
    },
    // PDF generation
    {
      name: "print_to_pdf",
      description: "Generate a PDF of the current page. Returns base64-encoded PDF data. Supports landscape/portrait orientation, custom scale, margins, page ranges, paper size, and preset formats (letter, legal, tabloid, a3, a4, a5).",
      inputSchema: {
        type: "object",
        properties: {
          landscape: { type: "boolean", description: "Paper orientation (default: false = portrait)" },
          scale: { type: "number", description: "Scale of the page rendering (default: 1, range: 0.1 to 2)" },
          paperWidth: { type: "number", description: "Paper width in inches (default: 8.5)" },
          paperHeight: { type: "number", description: "Paper height in inches (default: 11)" },
          marginTop: { type: "number", description: "Top margin in inches (default: 0.4)" },
          marginBottom: { type: "number", description: "Bottom margin in inches (default: 0.4)" },
          marginLeft: { type: "number", description: "Left margin in inches (default: 0.4)" },
          marginRight: { type: "number", description: "Right margin in inches (default: 0.4)" },
          pageRanges: { type: "string", description: "Page ranges to print, e.g. '1-3, 5' (default: all)" },
          printBackground: { type: "boolean", description: "Print background graphics (default: true)" },
          displayHeaderFooter: { type: "boolean", description: "Display header and footer (default: false)" },
          format: { type: "string", description: "Preset paper size: 'letter', 'legal', 'tabloid', 'a3', 'a4', 'a5'. Overrides paperWidth/paperHeight." },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          landscape: z.boolean().optional(),
          scale: z.number().min(0.1).max(2).optional(),
          paperWidth: z.number().positive().optional(),
          paperHeight: z.number().positive().optional(),
          marginTop: z.number().min(0).optional(),
          marginBottom: z.number().min(0).optional(),
          marginLeft: z.number().min(0).optional(),
          marginRight: z.number().min(0).optional(),
          pageRanges: z.string().optional(),
          printBackground: z.boolean().optional(),
          displayHeaderFooter: z.boolean().optional(),
          format: z.enum(["letter", "legal", "tabloid", "a3", "a4", "a5"]).optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "print_to_pdf",
          ...parsed,
        }, TOOL_TIMEOUTS.print_to_pdf);
        return toolSuccess(data);
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll the page or scroll an element into view. Use ref (preferred) or selector to scroll an element into view. Use deltaX/deltaY for additional scroll offset after positioning. Returns post-scroll snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot to scroll into view (e.g., 'e3'). Preferred over selector." },
          selector: { type: "string", description: "CSS selector to scroll into view first" },
          deltaX: { type: "number", description: "Horizontal scroll delta in pixels (default: 0)" },
          deltaY: { type: "number", description: "Vertical scroll delta in pixels (default: 0)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          ref: z.string().optional(),
          selector: selectorSchema.optional(),
          deltaX: z.number().default(0),
          deltaY: z.number().default(0),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_scroll",
          ...parsed,
        }, TOOL_TIMEOUTS.browser_scroll);
        return toolSuccess(shapeInteraction(result));
      },
    },
    {
      name: "browser_double_click",
      description: "Double-click on an element. Target by ref (from browser_snapshot, preferred) or CSS selector. Dispatches two click pairs with clickCount 1 then 2 (chromedriver pattern).",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref from browser_snapshot (e.g., 'e3'). Preferred over selector." },
          selector: { type: "string", description: "CSS selector of the element to double-click" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          ref: z.string().optional(),
          selector: selectorSchema.optional(),
        }).refine(d => d.ref || d.selector, { message: "ref or selector is required" });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_double_click",
          ref: parsed.ref,
          selector: parsed.selector,
        }, TOOL_TIMEOUTS.browser_double_click);
        return toolSuccess(shapeInteraction(result));
      },
    },
    {
      name: "browser_drag",
      description: "Drag from one element to another. Target by refs (from browser_snapshot, preferred) or CSS selectors. Simulates mousedown on source, interpolated mousemove steps to target, mouseup on target.",
      inputSchema: {
        type: "object",
        properties: {
          refFrom: { type: "string", description: "Element ref for drag start position (from browser_snapshot)." },
          refTo: { type: "string", description: "Element ref for drag end position (from browser_snapshot)." },
          from: { type: "string", description: "CSS selector of the drag source element" },
          to: { type: "string", description: "CSS selector of the drop target element" },
          steps: { type: "number", description: "Number of intermediate mousemove events (default: 10)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          refFrom: z.string().optional(),
          refTo: z.string().optional(),
          from: selectorSchema.optional(),
          to: selectorSchema.optional(),
          steps: z.number().int().min(1).max(100).default(10),
        }).refine(d => d.refFrom || d.from, { message: "refFrom or from is required" })
          .refine(d => d.refTo || d.to, { message: "refTo or to is required" });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_drag",
          refFrom: parsed.refFrom,
          refTo: parsed.refTo,
          from: parsed.from,
          to: parsed.to,
          steps: parsed.steps,
        }, TOOL_TIMEOUTS.browser_drag);
        return toolSuccess(shapeInteraction(result));
      },
    },
    {
      name: "browser_file_upload",
      description: "Upload files to a file input element. The element must be an <input type='file'>. Files are specified by their absolute paths on the local machine.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the <input type='file'> element" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Array of absolute file paths to upload",
          },
        },
        required: ["selector", "files"],
      },
      handler: async (args) => {
        const schema = z.object({
          selector: selectorSchema,
          files: z.array(z.string().min(1)).min(1).max(100),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_file_upload",
          selector: parsed.selector,
          files: parsed.files,
        }, TOOL_TIMEOUTS.browser_file_upload);
        return toolSuccess(shapeInteraction(result));
      },
    },
    // Accessibility tree
    {
      name: "get_accessibility_tree",
      description: "Get the accessibility tree (AXTree) of the current page. Returns a simplified tree with role, name, value, description, and children for each node. Useful for understanding page structure from a screen-reader perspective. Optionally limit depth to reduce output size.",
      inputSchema: {
        type: "object",
        properties: {
          depth: { type: "number", description: "Maximum tree depth to return (default: 10, max: 50)" },
          root: { type: "string", description: "CSS selector for subtree root (default: entire page)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          depth: z.number().int().min(1).max(50).default(10),
          root: selectorSchema.optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "get_accessibility_tree",
          depth: parsed.depth,
          root: parsed.root,
        }, TOOL_TIMEOUTS.get_accessibility_tree);
        return toolSuccess(data);
      },
    },
    {
      name: "set_geolocation",
      description: "Override the browser's geolocation. Affects navigator.geolocation.getCurrentPosition() and watchPosition(). Pass no arguments to clear the override and revert to real location.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", description: "Latitude in degrees (-90 to 90)" },
          longitude: { type: "number", description: "Longitude in degrees (-180 to 180)" },
          accuracy: { type: "number", description: "Accuracy in meters (default: 1)" },
        },
      },
      handler: async (args) => {
        const schema = z.object({
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          accuracy: z.number().min(0).optional(),
        }).refine(
          (d) => (d.latitude === undefined) === (d.longitude === undefined),
          { message: "Both latitude and longitude must be provided together, or both omitted to clear" },
        );
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "set_geolocation",
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          accuracy: parsed.accuracy,
        }, TOOL_TIMEOUTS.set_geolocation);
        return toolSuccess(result);
      },
    },
    // Performance metrics
    {
      name: "get_performance_metrics",
      description: "Get performance metrics for the current page. Includes Chrome's built-in metrics (DOM nodes, JS heap, layout counts, script duration) and Web Vitals (LCP, CLS, FID). Useful for performance auditing and optimization.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({
          type: "get_performance_metrics",
        }, TOOL_TIMEOUTS.get_performance_metrics);
        return toolSuccess(data);
      },
    },
    // WebSocket monitoring
    {
      name: "get_websocket_connections",
      description: "List all WebSocket connections observed since network capture started. Shows connection URL, status (connecting/open/closed/error), and message count. Requires active network capture.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["connecting", "open", "closed", "error"], description: "Filter by connection status (optional)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          status: z.enum(["connecting", "open", "closed", "error"]).optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "get_websocket_connections",
          ...(parsed.status && { status: parsed.status }),
        }, TOOL_TIMEOUTS.get_websocket_connections);
        return toolSuccess(data);
      },
    },
    {
      name: "get_websocket_messages",
      description: "Get WebSocket messages for a specific connection or all connections. Returns message direction (sent/received), opcode, data payload, and timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", description: "WebSocket requestId (from get_websocket_connections). Omit for messages from all connections." },
          limit: { type: "number", description: "Maximum messages to return (default: 50, max: 500)" },
          direction: { type: "string", enum: ["sent", "received"], description: "Filter by direction (optional)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          requestId: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(500).optional(),
          direction: z.enum(["sent", "received"]).optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "get_websocket_messages",
          ...parsed,
        }, TOOL_TIMEOUTS.get_websocket_messages);
        return toolSuccess(data);
      },
    },
    {
      name: "set_stealth_mode",
      description: "Enable or disable anti-detection stealth mode. When enabled, patches navigator.webdriver, plugins, WebGL renderer, and other automation signals to avoid bot detection. Disabled by default. Call with enabled: true to activate.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "true to enable stealth (default), false to disable" },
        },
        required: ["enabled"],
      },
      handler: async (args: Record<string, unknown>) => {
        const enabled = z.boolean().parse(args.enabled);
        const data = await bridge.send({
          type: "set_stealth_mode",
          enabled,
        }, TOOL_TIMEOUTS.set_stealth_mode);
        return toolSuccess(data);
      },
    },

    // --- Network conditions & headers ---

    {
      name: "emulate_network",
      description: "Emulate network conditions (throttling). Use a preset name or custom values. Presets: offline, slow-3g, fast-3g, 4g, wifi. Call with no args to clear throttling.",
      inputSchema: {
        type: "object",
        properties: {
          preset: { type: "string", enum: ["offline", "slow-3g", "fast-3g", "4g", "wifi"], description: "Network preset name" },
          downloadKbps: { type: "number", description: "Download speed in Kbps (overrides preset)" },
          uploadKbps: { type: "number", description: "Upload speed in Kbps (overrides preset)" },
          latencyMs: { type: "number", description: "Added latency in milliseconds (overrides preset)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const preset = args.preset !== undefined ? z.enum(["offline", "slow-3g", "fast-3g", "4g", "wifi"]).parse(args.preset) : undefined;
        const downloadKbps = args.downloadKbps !== undefined ? z.number().min(0).parse(args.downloadKbps) : undefined;
        const uploadKbps = args.uploadKbps !== undefined ? z.number().min(0).parse(args.uploadKbps) : undefined;
        const latencyMs = args.latencyMs !== undefined ? z.number().min(0).parse(args.latencyMs) : undefined;
        const data = await bridge.send({
          type: "emulate_network",
          ...(preset !== undefined && { preset }),
          ...(downloadKbps !== undefined && { downloadKbps }),
          ...(uploadKbps !== undefined && { uploadKbps }),
          ...(latencyMs !== undefined && { latencyMs }),
        }, TOOL_TIMEOUTS.emulate_network);
        return toolSuccess(data);
      },
    },

    {
      name: "set_cache_disabled",
      description: "Enable or disable browser cache. When disabled, the browser will not serve cached resources.",
      inputSchema: {
        type: "object",
        properties: {
          disabled: { type: "boolean", description: "true to disable cache, false to re-enable" },
        },
        required: ["disabled"],
      },
      handler: async (args: Record<string, unknown>) => {
        const disabled = z.boolean().parse(args.disabled);
        const data = await bridge.send({
          type: "set_cache_disabled",
          disabled,
        }, TOOL_TIMEOUTS.set_cache_disabled);
        return toolSuccess(data);
      },
    },

    {
      name: "set_extra_headers",
      description: "Set extra HTTP headers to be sent with every request. Pass an empty object to clear. Useful for auth tokens, custom X-headers, A/B test variants.",
      inputSchema: {
        type: "object",
        properties: {
          headers: { type: "object", description: "Header name→value pairs (e.g., { 'Authorization': 'Bearer ...' })" },
        },
        required: ["headers"],
      },
      handler: async (args: Record<string, unknown>) => {
        const headers = z.record(z.string()).parse(args.headers);
        const data = await bridge.send({
          type: "set_extra_headers",
          headers,
        }, TOOL_TIMEOUTS.set_extra_headers);
        return toolSuccess(data);
      },
    },

    {
      name: "get_security_state",
      description: "Get the current page's security state including TLS certificate details, protocol, cipher, and mixed content status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await bridge.send({
          type: "get_security_state",
        }, TOOL_TIMEOUTS.get_security_state);
        return toolSuccess(data);
      },
    },

    {
      name: "ignore_certificate_errors",
      description: "Enable or disable ignoring certificate errors. When enabled, self-signed and expired certificates will not block navigation. Useful for testing staging environments.",
      inputSchema: {
        type: "object",
        properties: {
          ignore: { type: "boolean", description: "true to ignore cert errors, false to enforce" },
        },
        required: ["ignore"],
      },
      handler: async (args: Record<string, unknown>) => {
        const ignore = z.boolean().parse(args.ignore);
        const data = await bridge.send({
          type: "ignore_certificate_errors",
          ignore,
        }, TOOL_TIMEOUTS.ignore_certificate_errors);
        return toolSuccess(data);
      },
    },

    // Service worker control

    {
      name: "list_service_workers",
      description: "List all service worker registrations for the current page. Shows scope URL, script URL, running status, and lifecycle state.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({
          type: "list_service_workers",
        }, TOOL_TIMEOUTS.list_service_workers);
        return toolSuccess(data);
      },
    },

    {
      name: "stop_service_worker",
      description: "Stop and unregister a specific service worker by registrationId, or stop ALL service workers if no ID provided.",
      inputSchema: {
        type: "object",
        properties: {
          registrationId: { type: "string", description: "Registration ID to stop (from list_service_workers). Omit to stop all." },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          registrationId: z.string().min(1).optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "stop_service_worker",
          ...(parsed.registrationId && { registrationId: parsed.registrationId }),
        }, TOOL_TIMEOUTS.stop_service_worker);
        return toolSuccess(data);
      },
    },

    {
      name: "bypass_service_worker",
      description: "Enable or disable service worker bypass. When enabled, page loads skip the service worker and fetch from network directly. Also forces SW update on page load.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "true to bypass service workers, false to restore normal behavior" },
        },
        required: ["enabled"],
      },
      handler: async (args: Record<string, unknown>) => {
        const enabled = z.boolean().parse(args.enabled);
        const data = await bridge.send({
          type: "bypass_service_worker",
          enabled,
        }, TOOL_TIMEOUTS.bypass_service_worker);
        return toolSuccess(data);
      },
    },

    // --- DOM Manipulation ---

    {
      name: "set_outer_html",
      description: "Replace an element's outer HTML. The element matching the selector is completely replaced with the provided HTML string.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element to replace" },
          html: { type: "string", description: "New outer HTML to set" },
          dangerous: { type: "boolean", description: "Set to true to allow HTML containing <script>, <iframe>, or event handlers" },
        },
        required: ["selector", "html"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selector: selectorSchema,
          html: z.string().min(1).max(1_000_000),
          dangerous: z.boolean().optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "set_outer_html",
          selector: parsed.selector,
          html: parsed.html,
          dangerous: parsed.dangerous,
        }, TOOL_TIMEOUTS.set_outer_html);
        return toolSuccess(data);
      },
    },
    {
      name: "set_attribute",
      description: "Set an attribute on an element. Creates the attribute if it doesn't exist, updates it if it does.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          name: { type: "string", description: "Attribute name" },
          value: { type: "string", description: "Attribute value" },
        },
        required: ["selector", "name", "value"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selector: selectorSchema,
          name: z.string().min(1).max(200),
          value: z.string().max(10_000),
        }).parse(args);
        const data = await bridge.send({
          type: "set_attribute",
          selector: parsed.selector,
          name: parsed.name,
          value: parsed.value,
        }, TOOL_TIMEOUTS.set_attribute);
        return toolSuccess(data);
      },
    },
    {
      name: "remove_attribute",
      description: "Remove an attribute from an element.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          name: { type: "string", description: "Attribute name to remove" },
        },
        required: ["selector", "name"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selector: selectorSchema,
          name: z.string().min(1).max(200),
        }).parse(args);
        const data = await bridge.send({
          type: "remove_attribute",
          selector: parsed.selector,
          name: parsed.name,
        }, TOOL_TIMEOUTS.remove_attribute);
        return toolSuccess(data);
      },
    },
    {
      name: "remove_node",
      description: "Remove an element and all its children from the DOM.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element to remove" },
        },
        required: ["selector"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selector: selectorSchema,
        }).parse(args);
        const data = await bridge.send({
          type: "remove_node",
          selector: parsed.selector,
        }, TOOL_TIMEOUTS.remove_node);
        return toolSuccess(data);
      },
    },

    // --- CSS Coverage & Pseudo-State ---

    {
      name: "start_css_coverage",
      description: "Start tracking CSS rule usage. Navigate pages and interact with elements, then call stop_css_coverage to get results showing which CSS rules were used.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await bridge.send({ type: "start_css_coverage" }, TOOL_TIMEOUTS.start_css_coverage);
        return toolSuccess(data);
      },
    },
    {
      name: "stop_css_coverage",
      description: "Stop CSS coverage tracking and return results. Each entry shows a CSS rule range, its stylesheet, and whether it was used.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await bridge.send({ type: "stop_css_coverage" }, TOOL_TIMEOUTS.stop_css_coverage);
        return toolSuccess(data);
      },
    },

    // --- JS Code Coverage ---

    {
      name: "start_js_coverage",
      description: "Start tracking JavaScript code coverage. Navigate and interact with the page, then call stop_js_coverage to see which code was executed. Use detailed=true for block-level granularity.",
      inputSchema: {
        type: "object",
        properties: {
          detailed: { type: "boolean", description: "Enable block-level coverage (more granular but more data). Default: false" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const data = await bridge.send({ type: "start_js_coverage", detailed: args.detailed }, TOOL_TIMEOUTS.start_js_coverage);
        return toolSuccess(data);
      },
    },
    {
      name: "stop_js_coverage",
      description: "Stop JS coverage tracking and return results. Shows per-script coverage with function-level or block-level ranges and execution counts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await bridge.send({ type: "stop_js_coverage" }, TOOL_TIMEOUTS.stop_js_coverage);
        return toolSuccess(data);
      },
    },
    {
      name: "get_computed_style",
      description: "Get the computed CSS style for an element. Returns all resolved CSS property values. Optionally filter to specific properties.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          properties: { type: "array", items: { type: "string" }, description: "Filter to these property names (optional, returns all if omitted)" },
        },
        required: ["selector"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selector: selectorSchema,
          properties: z.array(z.string()).optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "get_computed_style",
          selector: parsed.selector,
          properties: parsed.properties,
        }, TOOL_TIMEOUTS.get_computed_style);
        return toolSuccess(data);
      },
    },
    {
      name: "detect_fonts",
      description: "Detect all fonts on the page. Returns loaded FontFace objects with family/weight/style/status/source/provider, @font-face CSS rules, font usage on key elements (computed font-family, font-size, font-weight), and a summary with provider and format breakdowns.",
      inputSchema: {
        type: "object",
        properties: {
          selectors: {
            type: "array",
            items: { type: "string" },
            description: "CSS selectors to sample for font usage (default: body, h1-h3, p, a, button, input, span)",
          },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selectors: z.array(z.string()).optional(),
        }).parse(args);
        try {
          const data = await bridge.send({
            type: "detect_fonts",
            selectors: parsed.selectors,
          }, TOOL_TIMEOUTS.detect_fonts);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`detect_fonts failed: ${msg}. Suggestion: ensure a tab is connected and try reconnect_tab.`, problemOf(e));
        }
      },
    },
    {
      name: "force_pseudo_state",
      description: "Force CSS pseudo-states on an element (e.g., :hover, :focus, :active). Useful for testing styles without mouse interaction. Call with empty states array to clear.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          states: { type: "array", items: { type: "string", enum: ["active", "focus", "hover", "visited", "focus-within", "focus-visible"] }, description: "Pseudo-states to force" },
        },
        required: ["selector", "states"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          selector: selectorSchema,
          states: z.array(z.enum(["active", "focus", "hover", "visited", "focus-within", "focus-visible"])),
        }).parse(args);
        const data = await bridge.send({
          type: "force_pseudo_state",
          selector: parsed.selector,
          states: parsed.states,
        }, TOOL_TIMEOUTS.force_pseudo_state);
        return toolSuccess(data);
      },
    },
    // IndexedDB operations
    {
      name: "get_databases",
      description: "List all IndexedDB databases for the current page's origin. Shows database names and their object stores with schemas.",
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Security origin to query (defaults to current page origin)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          origin: z.string().optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "get_databases",
          origin: parsed.origin,
        }, TOOL_TIMEOUTS.get_databases);
        return toolSuccess(data);
      },
    },
    {
      name: "query_object_store",
      description: "Query data from an IndexedDB object store. Returns key-value entries with pagination.",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string", description: "Database name" },
          store: { type: "string", description: "Object store name" },
          limit: { type: "number", description: "Maximum entries to return (default: 25, max: 100)" },
          skip: { type: "number", description: "Number of entries to skip (for pagination, default: 0)" },
          index: { type: "string", description: "Index name to query through (optional)" },
        },
        required: ["database", "store"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          database: z.string().min(1),
          store: z.string().min(1),
          limit: z.number().int().min(1).max(100).optional(),
          skip: z.number().int().min(0).optional(),
          index: z.string().optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "query_object_store",
          database: parsed.database,
          store: parsed.store,
          limit: parsed.limit,
          skip: parsed.skip,
          index: parsed.index,
        }, TOOL_TIMEOUTS.query_object_store);
        return toolSuccess(data);
      },
    },
    {
      name: "clear_database",
      description: "Clear an IndexedDB object store, or delete an entire database. If only database is specified, deletes the whole database. If store is also specified, clears just that store.",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string", description: "Database name" },
          store: { type: "string", description: "Object store to clear (optional — omit to delete entire database)" },
        },
        required: ["database"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          database: z.string().min(1),
          store: z.string().min(1).optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "clear_database",
          database: parsed.database,
          store: parsed.store,
        }, TOOL_TIMEOUTS.clear_database);
        return toolSuccess(data);
      },
    },

    // --- Target & Session Management ---

    {
      name: "get_targets",
      description: "List all Chrome targets (pages, service workers, extensions, etc.). Shows target ID, type, title, URL, and attachment status. Lower-level than list_tabs — shows non-tab targets like service workers and browser contexts.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["page", "service_worker", "background_page", "browser", "other"], description: "Filter by target type (optional)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          type: z.enum(["page", "service_worker", "background_page", "browser", "other"]).optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "get_targets",
          targetType: parsed.type,
        }, TOOL_TIMEOUTS.get_targets);
        return toolSuccess(data);
      },
    },
    {
      name: "attach_to_target",
      description: "Attach to a CDP target by targetId. Returns a sessionId for sending CDP commands to that target. Useful for debugging service workers, popups, or other non-tab targets.",
      inputSchema: {
        type: "object",
        properties: {
          targetId: { type: "string", description: "Target ID from get_targets" },
        },
        required: ["targetId"],
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          targetId: z.string().min(1),
        }).parse(args);
        const data = await bridge.send({
          type: "attach_to_target",
          targetId: parsed.targetId,
        }, TOOL_TIMEOUTS.attach_to_target);
        return toolSuccess(data);
      },
    },
    {
      name: "create_browser_context",
      description: "Create an isolated browser context (incognito-like). Targets created in this context have separate cookies, cache, and storage. Call with no args to create, or pass contextId to dispose.",
      inputSchema: {
        type: "object",
        properties: {
          dispose: { type: "string", description: "Browser context ID to dispose (if disposing instead of creating)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = z.object({
          dispose: z.string().min(1).optional(),
        }).parse(args);
        const data = await bridge.send({
          type: "create_browser_context",
          dispose: parsed.dispose,
        }, TOOL_TIMEOUTS.create_browser_context);
        return toolSuccess(data);
      },
    },

    // Memory & Heap Analysis
    {
      name: "get_dom_counters",
      description: "Get DOM object counters: number of documents, DOM nodes, and JS event listeners. Useful for detecting memory leaks (growing counters over time).",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args: Record<string, unknown>) => {
        const data = await bridge.send({
          type: "get_dom_counters",
        }, TOOL_TIMEOUTS.get_dom_counters);
        return toolSuccess(data);
      },
    },
    {
      name: "force_gc",
      description: "Force JavaScript garbage collection. Useful before taking memory measurements to get accurate baseline. Uses HeapProfiler.collectGarbage for V8-level GC. Returns post-GC DOM counters.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args: Record<string, unknown>) => {
        const data = await bridge.send({
          type: "force_gc",
        }, TOOL_TIMEOUTS.force_gc);
        return toolSuccess(data);
      },
    },
    {
      name: "take_heap_snapshot",
      description: "Take a V8 heap snapshot summary. Returns node/edge counts and snapshot size. NOTE: Full heap snapshots can be very large — this returns metadata summary only.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (_args: Record<string, unknown>) => {
        const data = await bridge.send({
          type: "take_heap_snapshot",
        }, TOOL_TIMEOUTS.take_heap_snapshot);
        return toolSuccess(data);
      },
    },
    // --- Overlay & Visual Debug tools ---
    {
      name: "highlight_element",
      description: "Highlight an element with a colored overlay. The highlight persists until cleared or another element is highlighted. Useful for visual documentation in screenshots. Pass no selector to clear.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of element to highlight (omit to clear)" },
          color: { type: "string", description: "Hex color for highlight (default: #6FA8DC). Format: #RRGGBB or #RRGGBBAA" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          selector: selectorSchema.optional(),
          color: z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Must be hex color #RRGGBB or #RRGGBBAA").optional(),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "highlight_element",
          selector: parsed.selector,
          color: parsed.color,
        } as BridgeCommand, TOOL_TIMEOUTS.highlight_element);
        return toolSuccess(data);
      },
    },
    {
      name: "show_layout_shifts",
      description: "Toggle layout shift region visualization. When enabled, areas that cause Cumulative Layout Shift (CLS) are highlighted with blue overlays. Useful for debugging CLS issues.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "true to show layout shift regions, false to hide" },
        },
        required: ["enabled"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({ enabled: z.boolean() });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "show_layout_shifts",
          enabled: parsed.enabled,
        } as BridgeCommand, TOOL_TIMEOUTS.show_layout_shifts);
        return toolSuccess(data);
      },
    },
    {
      name: "show_paint_rects",
      description: "Toggle paint flashing. When enabled, areas that are repainted are highlighted with green overlays. Useful for identifying unnecessary repaints and rendering performance issues.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "true to show paint rects, false to hide" },
        },
        required: ["enabled"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({ enabled: z.boolean() });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "show_paint_rects",
          enabled: parsed.enabled,
        } as BridgeCommand, TOOL_TIMEOUTS.show_paint_rects);
        return toolSuccess(data);
      },
    },
    // --- Session Recording tools ---
    {
      name: "start_recording",
      description: "Start recording a browser session. Captures all tool interactions, page navigations, network requests, and console logs organized by page. Recording auto-stops after maxDurationSec (default 600s) or maxInteractions (default 500). A tab must be connected first.",
      inputSchema: {
        type: "object",
        properties: {
          maxDurationSec: { type: "number", description: "Max recording duration in seconds (10-600, default: 600)" },
          maxInteractions: { type: "number", description: "Max interaction count before auto-stop (1-500, default: 500)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          maxDurationSec: z.number().min(10).max(600).optional(),
          maxInteractions: z.number().min(1).max(500).optional(),
        });
        const parsed = schema.parse(args);
        try {
          const data = await bridge.send({
            type: "start_recording",
            maxDurationSec: parsed.maxDurationSec,
            maxInteractions: parsed.maxInteractions,
          } as BridgeCommand, TOOL_TIMEOUTS.start_recording);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`start_recording failed: ${msg}. Suggestion: ensure a tab is connected via connect_tab first.`, problemOf(e));
        }
      },
    },
    {
      name: "stop_recording",
      description: "Stop the active recording session and return the complete session data. Returns a RecordingSession JSON with all pages, interactions (tool calls with args/results/timing), network requests, and console logs partitioned by page. If the recording was auto-stopped (duration/interaction limit/tab closed), returns that session.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        try {
          const data = await bridge.send({ type: "stop_recording" } as BridgeCommand, TOOL_TIMEOUTS.stop_recording);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`stop_recording failed: ${msg}`, problemOf(e));
        }
      },
    },
    {
      name: "get_recording_status",
      description: "Check the current recording status. Returns whether a recording is active, session ID, duration, page count, interaction count, and current page URL.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        try {
          const data = await bridge.send({ type: "get_recording_status" } as BridgeCommand, TOOL_TIMEOUTS.get_recording_status);
          return toolSuccess(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`get_recording_status failed: ${msg}`, problemOf(e));
        }
      },
    },
    {
      name: "compile_recording",
      description: "Compile a recording session into a replayable SKILL.md markdown file. Takes the session JSON from stop_recording output and produces executable skill markdown with smart.* and bridge.send() calls. Pure computation — no browser access required.",
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "object",
            description: "The RecordingSession object returned by stop_recording",
          },
          name: {
            type: "string",
            description: "Name for the skill (will be kebab-cased)",
          },
          description: {
            type: "string",
            description: "Optional description for the skill frontmatter",
          },
        },
        required: ["session", "name"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          session: z.object({
            id: z.string(),
            startedAt: z.string(),
            stoppedAt: z.string().optional(),
            duration: z.number(),
            pages: z.array(z.object({
              url: z.string(),
              title: z.string().optional(),
              enteredAt: z.string(),
              interactions: z.array(z.any()),
            }).passthrough()),
            metadata: z.object({
              tabId: z.number(),
              initialUrl: z.string(),
              stopReason: z.string(),
            }).passthrough(),
          }).passthrough(),
          name: z.string().min(1),
          description: z.string().optional(),
        });

        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          return toolError(`Invalid arguments: ${parsed.error.issues.map(i => i.message).join(", ")}`);
        }

        try {
          const result = compileRecording(
            parsed.data.session as unknown as RecordingSession,
            { name: parsed.data.name, description: parsed.data.description },
          );
          return toolSuccess(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`compile_recording failed: ${msg}`, problemOf(e));
        }
      },
    },
    {
      name: "ocr_screenshot",
      description: "Extract text from the current page using macOS Vision.framework OCR. Takes a screenshot via CDP, runs native text recognition (VNRecognizeTextRequest), and returns recognized text with confidence scores and bounding regions. Works on canvas elements, images, anti-scraping sites, and any visual content invisible to DOM extraction.",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "Capture full scrollable page (default: viewport only)" },
          selector: { type: "string", description: "CSS selector — screenshot only this element" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        if (process.platform !== "darwin") {
          return toolError("ocr_screenshot requires macOS (Vision.framework). On other platforms, use browser_evaluate with a JS OCR library.");
        }

        const schema = z.object({
          fullPage: z.boolean().default(false),
          selector: selectorSchema.optional(),
        });
        const parsed = schema.parse(args);

        // Capture screenshot via bridge
        const screenshotParams: Record<string, unknown> = { type: "take_screenshot" };
        if (parsed.fullPage) screenshotParams.fullPage = true;
        if (parsed.selector) screenshotParams.selector = parsed.selector;

        let tmpPath = "";
        try {
          const data = await bridge.send(screenshotParams as BridgeCommand, TOOL_TIMEOUTS.ocr_screenshot) as { data: string };
          if (!data?.data) {
            return toolError("Screenshot capture failed — no image data returned");
          }

          // Write PNG to temp file
          tmpPath = join(tmpdir(), `crawlio-ocr-${randomBytes(6).toString("hex")}.png`);
          await writeFile(tmpPath, Buffer.from(data.data, "base64"));

          // Resolve shim path relative to package root
          const shimPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ocr-shim.swift");

          const { stdout, stderr } = await execFileAsync("swift", [shimPath, tmpPath], { timeout: 25000 });

          if (!stdout.trim()) {
            return toolError(`OCR produced no output${stderr ? `: ${stderr.trim()}` : ""}`);
          }

          const result = JSON.parse(stdout.trim());
          if (result.error) {
            return toolError(`OCR failed: ${result.error}`);
          }

          // Shape response: limit regions if too many
          if (result.regions && result.regions.length > 20) {
            result.regions = result.regions
              .sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence)
              .slice(0, 20);
            result.regionsLimited = true;
          }

          return toolSuccess(result);
        } catch (e: unknown) {
          // execFile errors include stderr when process exits non-zero
          const execErr = e as { stderr?: string };
          if (execErr?.stderr) {
            try {
              const parsed = JSON.parse(execErr.stderr?.trim() ?? "");
              if (parsed.error) return toolError(`OCR failed: ${parsed.error}`);
            } catch { /* not JSON, fall through */ }
          }
          const msg = e instanceof Error ? e.message : String(e);
          return toolError(`OCR failed: ${msg}`, problemOf(e));
        } finally {
          if (tmpPath) unlink(tmpPath).catch(() => {});
        }
      },
    },
    // --- Network idle detection (Phase 11) ---
    {
      name: "wait_for_network_idle",
      description: "Wait for all network requests to complete (idle detection). Uses CDP Network domain event tracking — catches ALL request types (fetch, XHR, images, CSS, fonts, scripts). Returns when no requests are pending for the specified idle window, or on timeout.",
      inputSchema: {
        type: "object",
        properties: {
          timeout: { type: "number", description: "Max wait in ms (default 15000, max 30000)" },
          idleTime: { type: "number", description: "Quiet window before declaring idle in ms (default 500, max 5000)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          timeout: z.number().int().min(100).max(30000).default(15000),
          idleTime: z.number().int().min(100).max(5000).default(500),
        });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "wait_for_network_idle",
          timeout: parsed.timeout,
          idleTime: parsed.idleTime,
        }, TOOL_TIMEOUTS.wait_for_network_idle);
        return toolSuccess(data);
      },
    },
    // --- Structured data extraction (Phase 11 — full-mode tools) ---
    {
      name: "detect_tables",
      description: "Detect repeating data patterns (tables, lists, grids, card layouts) on the page. Native <table> elements are found first (strategy 'table-rows', with header rows promoted to column names by extract_table); div-soup layouts are found via class-frequency scoring with geometric row-height filtering (strategy 'sibling-repeated-blocks'). Returns ranked candidates with selectors, row counts, sample text, confidence (0..1), strategy, and warnings. Use extract_table to extract data from a candidate.",
      inputSchema: {
        type: "object",
        properties: {
          maxCandidates: { type: "number", description: "Maximum candidates to return (default 5, max 20)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          maxCandidates: z.number().int().min(1).max(20).default(5),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_evaluate",
          expression: buildDetectTablesJs(parsed),
        }, TOOL_TIMEOUTS.detect_tables);
        const data = result as { result?: unknown };
        return toolSuccess(data?.result ?? []);
      },
    },
    {
      name: "extract_table",
      description: "Extract structured data from a container element. Pass a selector from detect_tables. Native <table> containers get header-promoted column names (thead th) plus <name>_url companion columns for link-bearing cells; other containers use recursive path-keyed extraction with semantic column naming (link-first ordering, content hints like price/source_domain). Returns columns (name + original path + fill rate) and rows as key-value objects.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the container element" },
          maxRows: { type: "number", description: "Maximum rows to extract (default 200, max 1000)" },
        },
        required: ["selector"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          selector: selectorSchema,
          maxRows: z.number().int().min(1).max(1000).default(200),
        });
        const parsed = schema.parse(args);
        const selector = parsed.selector;
        const result = await bridge.send({
          type: "browser_evaluate",
          expression: buildExtractTableJs(selector, { maxRows: parsed.maxRows }),
        }, TOOL_TIMEOUTS.extract_table);
        const data = result as { result?: unknown };
        return toolSuccess(data?.result ?? { selector, columns: [], rows: [], totalRows: 0, truncated: false });
      },
    },
    {
      name: "extract_data",
      description: "Compound extraction: detect tables + extract each + collect JSON-LD structured data from the page. Returns all tables with columns/rows plus any schema.org/JSON-LD data. Combines detect_tables, extract_table, and JSON-LD extraction in one call.",
      inputSchema: {
        type: "object",
        properties: {
          maxTables: { type: "number", description: "Maximum tables to extract (default 3, max 10)" },
          maxRowsPerTable: { type: "number", description: "Maximum rows per table (default 200, max 1000)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          maxTables: z.number().int().min(1).max(10).default(3),
          maxRowsPerTable: z.number().int().min(1).max(1000).default(200),
        });
        const parsed = schema.parse(args);
        const maxTables = parsed.maxTables;
        const maxRowsPerTable = parsed.maxRowsPerTable;

        // Get current URL
        const status = await bridge.send({ type: "get_connection_status" }, 5000) as { connectedTab?: { url?: string } };
        const url = status?.connectedTab?.url || "";

        // Detect tables
        const detectResult = await bridge.send({
          type: "browser_evaluate",
          expression: buildDetectTablesJs({ maxCandidates: maxTables }),
        }, TOOL_TIMEOUTS.detect_tables) as { result?: Array<{ selector: string; score: number; rowCount: number }> };

        const candidates = (detectResult as { result?: Array<{ selector: string }> })?.result ?? [];

        // Extract each candidate
        const tables: Array<Record<string, unknown>> = [];
        const skipped: Array<{ selector: string; error: string }> = [];
        for (const candidate of candidates) {
          // candidate.selector is derived from the page, so a single pathological one
          // must not fail the whole call and discard the tables already extracted.
          try {
            const extractResult = await bridge.send({
              type: "browser_evaluate",
              expression: buildExtractTableJs(candidate.selector, { maxRows: maxRowsPerTable }),
            }, TOOL_TIMEOUTS.extract_table) as { result?: Record<string, unknown> };

            const extraction = (extractResult as { result?: { columns?: unknown[]; rows?: unknown[] } })?.result;
            if (extraction && (extraction.columns?.length ?? 0) >= 2 && (extraction.rows?.length ?? 0) >= 2) {
              tables.push(extraction);
            }
          } catch (err) {
            skipped.push({ selector: candidate.selector, error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Extract JSON-LD
        const jsonLdResult = await bridge.send({
          type: "browser_evaluate",
          expression: `(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const result = [];
      scripts.forEach(s => { try { result.push(JSON.parse(s.textContent)); } catch {} });
      return result;
    })()`,
        }, 5000) as { result?: unknown[] };

        return toolSuccess({
          tables,
          structuredData: (jsonLdResult as { result?: unknown[] })?.result ?? [],
          url,
          ...(skipped.length > 0 && { skipped }),
        });
      },
    },
    // --- Structured page perception: section detection ---
    {
      name: "detect_sections",
      description: "Detect the page's structural regions from the live DOM: semantic tags (section/article/aside/header/main/footer/nav/form), ARIA landmark roles (banner/navigation/main/contentinfo/complementary/search/form/region), data-component/data-testid/data-section/data-block/data-module attributes, and PascalCase/BEM class-name hints. Returns a depth-capped SectionNode tree — each node has role, source, name (aria-label > data-component > first heading), a CSS selector with a selectorVerified uniqueness flag, bounding box, inViewport, interactiveCount, textLength, and headings. Sections deliberately emit selectors, NOT [ref=eN] snapshot handles (refs are snapshot-scoped and go stale between runs); to interact inside a chosen region, compose with browser_snapshot({ selector }) to mint fresh interaction refs scoped to it.",
      inputSchema: {
        type: "object",
        properties: {
          maxDepth: { type: "number", description: "Maximum nesting depth of the section tree (default 2, max 5)" },
          maxSections: { type: "number", description: "Maximum total sections to return (default 40, max 100)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          maxDepth: z.number().int().min(1).max(5).default(2),
          maxSections: z.number().int().min(1).max(100).default(40),
        });
        const parsed = schema.parse(args);
        const result = await bridge.send({
          type: "browser_evaluate",
          expression: buildDetectSectionsJs(parsed),
        }, TOOL_TIMEOUTS.detect_sections);
        const data = result as { result?: unknown };
        return toolSuccess(data?.result ?? { url: "", viewport: { width: 0, height: 0 }, sections: [], totalDetected: 0, truncated: false });
      },
    },
    // --- Detection Wedge: Tracking Pixel Parser ---
    {
      name: "parse_tracking_pixels",
      description: "Parse captured network requests to detect tracking pixel fires from Facebook, GA4, TikTok, LinkedIn, and Pinterest. Extracts pixel IDs, event names, parameters, and vendor classification from NetworkEntry data. Operates on already-captured network data — no additional page interaction required.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await bridge.send({ type: "parse_tracking_pixels" }, TOOL_TIMEOUTS.parse_tracking_pixels) as TrackingParseResult;
        return toolSuccess(data);
      },
    },
    // --- Detection Wedge: Tracking Event Validation ---
    {
      name: "validate_tracking",
      description: "Validate tracking pixel events against per-vendor parameter schemas. Checks for missing required/recommended parameters, invalid types, duplicate events, missing PageView, and possible event name typos. Uses parsed tracking data from parse_tracking_pixels. Returns issues with error/warning/info severity and actionable recommendations. Operates on already-captured network data.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const parseResult = await bridge.send({ type: "parse_tracking_pixels" }, TOOL_TIMEOUTS.validate_tracking) as TrackingParseResult;
        const result = validateTrackingEvents(parseResult);
        return toolSuccess(result);
      },
    },
    // --- Detection Wedge: DataLayer Inspection ---
    {
      name: "inspect_datalayer",
      description: "Inspect tracker runtime state via CDP Runtime.evaluate. Probes Facebook fbq (loaded, version, pixelIds, queue), GA4 dataLayer (events, gtag/ga presence), GTM containers (GTM-/G- IDs), and TikTok ttq (loaded, queue). Returns DataLayerState with null for absent trackers. Requires debugger attached — no content script needed.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await bridge.send({ type: "inspect_datalayer" }, TOOL_TIMEOUTS.inspect_datalayer) as DataLayerState;
        return toolSuccess(data);
      },
    },
    // --- Detection Wedge: Technographic Fingerprint Detection ---
    {
      name: "detect_technologies",
      description: "Detect technologies on the current page using CDP-captured signals matched against a curated fingerprint database (~200 technologies). Collects response headers, script URLs, JS globals, meta tags, cookies, and page URL — then runs additive confidence scoring (per-pattern weights summed, capped at 100). Returns technologies with numeric confidence, version, categories, and matched signals for full transparency. Requires debugger attached.",
      inputSchema: {
        type: "object",
        properties: {
          confidenceThreshold: { type: "number", description: "Minimum confidence to include in results (default 1, range 0-100)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          confidenceThreshold: z.number().int().min(0).max(100).default(1),
        });
        const parsed = schema.parse(args);

        // Run capture_page to get network entries, cookies, and framework data
        const capture = await bridge.send({ type: "capture_page" }, TOOL_TIMEOUTS.detect_technologies) as PageCapture;
        const pageUrl = capture?.url || "";

        // Parallel: meta tags, JS globals, HTML snippet from page context
        const [metaResult, jsResult, htmlResult] = await Promise.all([
          bridge.send({ type: "browser_evaluate", expression: META_TAG_EXTRACTION_EXPR }, 5000).catch(() => ({ result: {} })),
          bridge.send({ type: "browser_evaluate", expression: buildJSGlobalsCheckExpr() }, 5000).catch(() => ({ result: {} })),
          bridge.send({ type: "browser_evaluate", expression: "document.documentElement.outerHTML.substring(0, 50000)" }, 5000).catch(() => ({ result: "" })),
        ]) as [
          { result: Record<string, string> },
          { result: Record<string, string | null> },
          { result: string },
        ];

        const signals = collectSignals({
          networkEntries: capture.networkRequests || [],
          cookies: capture.cookies || [],
          metaTags: metaResult.result as Record<string, string>,
          jsGlobals: jsResult.result as Record<string, string | null>,
          url: pageUrl,
          html: typeof htmlResult.result === "string" ? htmlResult.result : undefined,
        });

        const detections = matchFingerprints(signals);
        const filtered = parsed.confidenceThreshold > 0
          ? detections.filter(d => d.confidence >= parsed.confidenceThreshold)
          : detections;
        const result = buildTechnographicResult(filtered, signals, 50);
        return toolSuccess(result);
      },
    },
    // --- CDP SERP Overlay (Phase 3) ---
    {
      name: "inject_serp_overlay",
      description: "Inject SEO overlay widgets into a Google SERP page using CDP + shadow DOM isolation. Requires debugger attached to a tab showing a Google search results page. Widgets: badge (per-result framework/perf), header (top bar with query info), sidebar (aggregated metrics panel). All rendering uses shadow DOM — no style conflicts with Google's page.",
      inputSchema: {
        type: "object",
        properties: {
          widgets: {
            type: "array",
            items: { type: "string", enum: ["badge", "header", "sidebar"] },
            description: "Widget types to inject (default: all three)",
          },
          data: {
            type: "object",
            description: "Per-hostname data for badges. Keys are hostnames, values are { framework?: string, perfScore?: number }",
          },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          widgets: z.array(z.enum(["badge", "header", "sidebar"])).default(["badge", "header", "sidebar"]),
          data: z.record(z.unknown()).optional(),
        });
        const parsed = schema.parse(args);

        // Verify we're on a Google SERP
        const status = await bridge.send({ type: "get_connection_status" }, 5000) as {
          connectedTab?: { url?: string };
        };
        const url = status?.connectedTab?.url || "";
        const serpMatch = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/search\?/i.test(url);
        if (!serpMatch) {
          return toolError("Not on a Google SERP. Navigate to a Google search results page first.");
        }

        // Extract query from URL
        let query = "";
        try {
          const params = new URL(url).searchParams;
          query = params.get("q") || "";
        } catch { /* no query */ }

        const result = await bridge.send({
          type: "inject_serp_overlay",
          widgets: parsed.widgets,
          query,
          data: parsed.data || {},
        }, TOOL_TIMEOUTS.inject_serp_overlay);

        return toolSuccess(result);
      },
    },
    {
      name: "clear_serp_overlay",
      description: "Remove all Crawlio SERP overlay widgets (badges, header bar, sidebar) from the current page. Safe to call even if no overlay is present.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const result = await bridge.send({
          type: "clear_serp_overlay",
        }, TOOL_TIMEOUTS.clear_serp_overlay);
        return toolSuccess(result);
      },
    },
    // --- On-Page SEO Analysis (Phase 4) ---
    {
      name: "seo_audit",
      description: "Run a comprehensive on-page SEO audit on the connected page via CDP. Extracts 11 dimensions: meta tags, heading structure, link profile, images, structured data, Open Graph, Twitter Cards, canonical/hreflang, robots directives, content metrics, and technical signals. Returns a scored audit with actionable issues. Requires debugger attached.",
      inputSchema: {
        type: "object",
        properties: {
          sections: {
            type: "array",
            items: { type: "string", enum: ["meta", "headings", "links", "images", "structuredData", "openGraph", "twitterCard", "canonical", "robots", "content", "technical"] },
            description: "Optional: only audit specific sections. Omit to run all 11.",
          },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          sections: z.array(z.string()).optional(),
        });
        const parsed = schema.parse(args);
        const sections = parsed.sections;

        const result = await bridge.send({
          type: "browser_evaluate",
          expression: `(() => {
  const url = location.href;
  const auditedAt = new Date().toISOString();
  const sections = ${JSON.stringify(sections || null)};
  const shouldRun = (s) => !sections || sections.includes(s);

  // --- Meta Tags ---
  function auditMeta() {
    const title = document.title || null;
    const descEl = document.querySelector('meta[name="description"]');
    const description = descEl ? descEl.getAttribute("content") : null;
    const robotsEl = document.querySelector('meta[name="robots"]');
    const robots = robotsEl ? robotsEl.getAttribute("content") : null;
    const viewportEl = document.querySelector('meta[name="viewport"]');
    const viewport = viewportEl ? viewportEl.getAttribute("content") : null;
    const charsetEl = document.querySelector('meta[charset]') || document.querySelector('meta[http-equiv="Content-Type"]');
    const charset = charsetEl ? (charsetEl.getAttribute("charset") || charsetEl.getAttribute("content")) : null;
    const authorEl = document.querySelector('meta[name="author"]');
    const author = authorEl ? authorEl.getAttribute("content") : null;
    const genEl = document.querySelector('meta[name="generator"]');
    const generator = genEl ? genEl.getAttribute("content") : null;
    return {
      title, titleLength: title ? title.length : 0,
      description, descriptionLength: description ? description.length : 0,
      robots, viewport, charset, author, generator
    };
  }

  // --- Headings ---
  function auditHeadings() {
    const hierarchy = [];
    let prevLevel = 0;
    let valid = true;
    const h1Texts = [];
    const els = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const el of els) {
      const lvl = parseInt(el.tagName.charAt(1), 10);
      const text = (el.textContent || "").trim().slice(0, 200);
      hierarchy.push({ level: lvl, text });
      if (lvl === 1) h1Texts.push(text);
      if (lvl > prevLevel + 1 && prevLevel > 0) valid = false;
      prevLevel = lvl;
    }
    return {
      h1Count: h1Texts.length,
      h1Texts,
      hierarchy,
      hasValidHierarchy: valid,
      totalHeadings: hierarchy.length
    };
  }

  // --- Links ---
  function auditLinks() {
    const anchors = document.querySelectorAll("a[href]");
    const pageHost = location.hostname;
    const links = [];
    let internal = 0, external = 0, nofollow = 0, ugc = 0, sponsored = 0, broken = 0, dofollow = 0;
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const rel = (a.getAttribute("rel") || "").toLowerCase();
      const text = (a.textContent || "").trim().slice(0, 100);
      let isExternal = false;
      try {
        const u = new URL(href, location.href);
        isExternal = u.hostname !== pageHost;
      } catch { isExternal = false; }
      const isNofollow = rel.includes("nofollow");
      if (isExternal) external++; else internal++;
      if (isNofollow) nofollow++;
      if (rel.includes("ugc")) ugc++;
      if (rel.includes("sponsored")) sponsored++;
      if (!isNofollow && !rel.includes("ugc") && !rel.includes("sponsored")) dofollow++;
      if (!href || href === "#" || href === "javascript:void(0)") broken++;
      if (!seen.has(href)) seen.add(href);
      if (links.length < 200) links.push({ href, text, rel, isExternal, isNofollow });
    }
    return { total: anchors.length, internal, external, dofollow, nofollow, ugc, sponsored, broken, unique: seen.size, links };
  }

  // --- Images ---
  function auditImages() {
    const imgs = document.querySelectorAll("img");
    const images = [];
    let withAlt = 0, withoutAlt = 0, lazyLoaded = 0, withDimensions = 0;
    for (const img of imgs) {
      const alt = img.getAttribute("alt");
      const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
      const loading = img.getAttribute("loading");
      const w = img.naturalWidth || img.width || null;
      const h = img.naturalHeight || img.height || null;
      if (alt !== null && alt !== "") withAlt++; else withoutAlt++;
      if (loading === "lazy" || img.getAttribute("data-src")) lazyLoaded++;
      if (w && h) withDimensions++;
      if (images.length < 100) images.push({ src: src.slice(0, 500), alt, width: w || null, height: h || null, loading });
    }
    return { total: imgs.length, withAlt, withoutAlt, lazyLoaded, withDimensions, images };
  }

  // --- Structured Data ---
  function auditStructuredData() {
    const jsonLd = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { jsonLd.push(JSON.parse(s.textContent || "")); } catch {}
    }
    const microdataCount = document.querySelectorAll("[itemscope]").length;
    const rdfaCount = document.querySelectorAll("[typeof]").length;
    return { jsonLd, microdataCount, rdfaCount, totalItems: jsonLd.length + microdataCount + rdfaCount };
  }

  // --- Open Graph ---
  function auditOpenGraph() {
    const allTags = {};
    for (const m of document.querySelectorAll('meta[property^="og:"]')) {
      const prop = m.getAttribute("property");
      const content = m.getAttribute("content");
      if (prop && content) allTags[prop.replace("og:", "")] = content;
    }
    return {
      title: allTags["title"] || null,
      description: allTags["description"] || null,
      image: allTags["image"] || null,
      url: allTags["url"] || null,
      type: allTags["type"] || null,
      siteName: allTags["site_name"] || null,
      allTags
    };
  }

  // --- Twitter Cards ---
  function auditTwitterCard() {
    const allTags = {};
    for (const m of document.querySelectorAll('meta[name^="twitter:"], meta[property^="twitter:"]')) {
      const name = m.getAttribute("name") || m.getAttribute("property");
      const content = m.getAttribute("content");
      if (name && content) allTags[name.replace("twitter:", "")] = content;
    }
    return {
      card: allTags["card"] || null,
      title: allTags["title"] || null,
      description: allTags["description"] || null,
      image: allTags["image"] || null,
      site: allTags["site"] || null,
      allTags
    };
  }

  // --- Canonical & Hreflang ---
  function auditCanonical() {
    const canonEl = document.querySelector('link[rel="canonical"]');
    const canonical = canonEl ? canonEl.getAttribute("href") : null;
    const hreflangTags = [];
    for (const el of document.querySelectorAll('link[hreflang]')) {
      hreflangTags.push({ lang: el.getAttribute("hreflang") || "", href: el.getAttribute("href") || "" });
    }
    return {
      canonical,
      isCanonicalSelf: canonical ? canonical === url || canonical === location.pathname : false,
      hreflangTags
    };
  }

  // --- Robots ---
  function auditRobots() {
    const robotsEl = document.querySelector('meta[name="robots"]');
    const metaRobots = robotsEl ? robotsEl.getAttribute("content") : null;
    const directives = metaRobots ? metaRobots.split(",").map(d => d.trim().toLowerCase()) : [];
    return {
      metaRobots,
      xRobotsTag: null,
      isIndexable: !directives.includes("noindex"),
      isFollowable: !directives.includes("nofollow"),
      directives
    };
  }

  // --- Content Metrics ---
  function auditContent() {
    const body = document.body;
    const text = (body ? body.innerText : "") || "";
    const htmlLength = (body ? body.innerHTML : "").length || 1;
    const words = text.split(/\\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const textLength = text.length;
    const textToHtmlRatio = Math.round((textLength / htmlLength) * 100) / 100;
    const readingTimeMinutes = Math.round((wordCount / 200) * 10) / 10;
    return { wordCount, textToHtmlRatio, readingTimeMinutes };
  }

  // --- Technical ---
  function auditTechnical() {
    const doctype = document.doctype ? document.doctype.name : null;
    const lang = document.documentElement.getAttribute("lang");
    const charsetEl = document.querySelector('meta[charset]');
    const charset = charsetEl ? charsetEl.getAttribute("charset") : null;
    const viewportEl = document.querySelector('meta[name="viewport"]');
    const viewportMeta = viewportEl ? viewportEl.getAttribute("content") : null;
    const hasHttps = location.protocol === "https:";
    const hasFavicon = !!document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    return { doctype, lang, charset, viewportMeta, hasHttps, hasFavicon };
  }

  // --- Scoring & Issues ---
  function calculateScore(audit) {
    const issues = [];
    let total = 0, earned = 0;

    // Meta (weight 15)
    if (shouldRun("meta")) {
      total += 15;
      let s = 15;
      if (!audit.meta.title) { s -= 5; issues.push({ code: "missing-title", severity: "error", message: "Page has no title tag", dimension: "meta" }); }
      else if (audit.meta.titleLength > 60) { s -= 2; issues.push({ code: "title-too-long", severity: "warning", message: "Title is " + audit.meta.titleLength + " chars (recommended: 50-60)", dimension: "meta" }); }
      else if (audit.meta.titleLength < 10) { s -= 2; issues.push({ code: "title-too-short", severity: "warning", message: "Title is only " + audit.meta.titleLength + " chars", dimension: "meta" }); }
      if (!audit.meta.description) { s -= 5; issues.push({ code: "missing-description", severity: "error", message: "Page has no meta description", dimension: "meta" }); }
      else if (audit.meta.descriptionLength > 160) { s -= 2; issues.push({ code: "description-too-long", severity: "warning", message: "Meta description is " + audit.meta.descriptionLength + " chars (recommended: 120-160)", dimension: "meta" }); }
      if (!audit.meta.viewport) { s -= 3; issues.push({ code: "missing-viewport", severity: "error", message: "No viewport meta tag", dimension: "meta" }); }
      earned += Math.max(0, s);
    }

    // Headings (weight 10)
    if (shouldRun("headings")) {
      total += 10;
      let s = 10;
      if (audit.headings.h1Count === 0) { s -= 5; issues.push({ code: "missing-h1", severity: "error", message: "Page has no H1 heading", dimension: "headings" }); }
      else if (audit.headings.h1Count > 1) { s -= 3; issues.push({ code: "multiple-h1", severity: "warning", message: "Page has " + audit.headings.h1Count + " H1 headings (recommended: 1)", dimension: "headings" }); }
      if (!audit.headings.hasValidHierarchy) { s -= 2; issues.push({ code: "heading-hierarchy", severity: "warning", message: "Heading hierarchy has gaps (e.g. H1 followed by H3)", dimension: "headings" }); }
      earned += Math.max(0, s);
    }

    // Links (weight 10)
    if (shouldRun("links")) {
      total += 10;
      let s = 10;
      if (audit.links.broken > 0) { s -= Math.min(5, audit.links.broken); issues.push({ code: "broken-links", severity: "warning", message: audit.links.broken + " broken/empty links found", dimension: "links" }); }
      if (audit.links.total === 0) { s -= 3; issues.push({ code: "no-links", severity: "info", message: "Page has no links", dimension: "links" }); }
      earned += Math.max(0, s);
    }

    // Images (weight 10)
    if (shouldRun("images")) {
      total += 10;
      let s = 10;
      if (audit.images.withoutAlt > 0) {
        const pct = Math.round((audit.images.withoutAlt / Math.max(1, audit.images.total)) * 100);
        s -= Math.min(8, Math.ceil(pct / 12));
        issues.push({ code: "images-missing-alt", severity: pct > 50 ? "error" : "warning", message: audit.images.withoutAlt + " of " + audit.images.total + " images missing alt text (" + pct + "%)", dimension: "images" });
      }
      earned += Math.max(0, s);
    }

    // Structured Data (weight 8)
    if (shouldRun("structuredData")) {
      total += 8;
      let s = 8;
      if (audit.structuredData.totalItems === 0) { s -= 4; issues.push({ code: "no-structured-data", severity: "info", message: "No structured data (JSON-LD, microdata, or RDFa) found", dimension: "structuredData" }); }
      earned += Math.max(0, s);
    }

    // Open Graph (weight 8)
    if (shouldRun("openGraph")) {
      total += 8;
      let s = 8;
      if (!audit.openGraph.title) { s -= 3; issues.push({ code: "missing-og-title", severity: "warning", message: "No og:title meta tag", dimension: "openGraph" }); }
      if (!audit.openGraph.description) { s -= 2; issues.push({ code: "missing-og-description", severity: "warning", message: "No og:description meta tag", dimension: "openGraph" }); }
      if (!audit.openGraph.image) { s -= 3; issues.push({ code: "missing-og-image", severity: "warning", message: "No og:image meta tag", dimension: "openGraph" }); }
      earned += Math.max(0, s);
    }

    // Twitter Card (weight 5)
    if (shouldRun("twitterCard")) {
      total += 5;
      let s = 5;
      if (!audit.twitterCard.card) { s -= 3; issues.push({ code: "missing-twitter-card", severity: "info", message: "No twitter:card meta tag", dimension: "twitterCard" }); }
      earned += Math.max(0, s);
    }

    // Canonical (weight 10)
    if (shouldRun("canonical")) {
      total += 10;
      let s = 10;
      if (!audit.canonical.canonical) { s -= 5; issues.push({ code: "missing-canonical", severity: "warning", message: "No canonical URL defined", dimension: "canonical" }); }
      earned += Math.max(0, s);
    }

    // Robots (weight 8)
    if (shouldRun("robots")) {
      total += 8;
      let s = 8;
      if (!audit.robots.isIndexable) { s -= 4; issues.push({ code: "noindex", severity: "info", message: "Page has noindex directive", dimension: "robots" }); }
      if (!audit.robots.isFollowable) { s -= 2; issues.push({ code: "nofollow", severity: "info", message: "Page has nofollow directive", dimension: "robots" }); }
      earned += Math.max(0, s);
    }

    // Content (weight 8)
    if (shouldRun("content")) {
      total += 8;
      let s = 8;
      if (audit.content.wordCount < 300) { s -= 4; issues.push({ code: "thin-content", severity: "warning", message: "Low word count (" + audit.content.wordCount + "). Consider adding more content (300+ words recommended)", dimension: "content" }); }
      if (audit.content.textToHtmlRatio < 0.1) { s -= 2; issues.push({ code: "low-text-ratio", severity: "warning", message: "Text-to-HTML ratio is " + (audit.content.textToHtmlRatio * 100).toFixed(1) + "% (10%+ recommended)", dimension: "content" }); }
      earned += Math.max(0, s);
    }

    // Technical (weight 8)
    if (shouldRun("technical")) {
      total += 8;
      let s = 8;
      if (!audit.technical.hasHttps) { s -= 4; issues.push({ code: "no-https", severity: "error", message: "Page not served over HTTPS", dimension: "technical" }); }
      if (!audit.technical.lang) { s -= 2; issues.push({ code: "missing-lang", severity: "warning", message: "No lang attribute on <html> element", dimension: "technical" }); }
      if (!audit.technical.hasFavicon) { s -= 1; issues.push({ code: "missing-favicon", severity: "info", message: "No favicon link tag found", dimension: "technical" }); }
      earned += Math.max(0, s);
    }

    return { score: total > 0 ? Math.round((earned / total) * 100) : 0, issues };
  }

  const audit = {};
  if (shouldRun("meta")) audit.meta = auditMeta();
  if (shouldRun("headings")) audit.headings = auditHeadings();
  if (shouldRun("links")) audit.links = auditLinks();
  if (shouldRun("images")) audit.images = auditImages();
  if (shouldRun("structuredData")) audit.structuredData = auditStructuredData();
  if (shouldRun("openGraph")) audit.openGraph = auditOpenGraph();
  if (shouldRun("twitterCard")) audit.twitterCard = auditTwitterCard();
  if (shouldRun("canonical")) audit.canonical = auditCanonical();
  if (shouldRun("robots")) audit.robots = auditRobots();
  if (shouldRun("content")) audit.content = auditContent();
  if (shouldRun("technical")) audit.technical = auditTechnical();

  const { score, issues } = calculateScore(audit);
  return { url, auditedAt, ...audit, score, issues };
})()`,
        }, TOOL_TIMEOUTS.seo_audit);
        const data = result as { result?: unknown };
        const audit = (data?.result ?? {}) as SeoAuditResult;
        // Note: robots.xRobotsTag stays null — response headers are only available
        // through network capture data, not from page context. Callers can enrich
        // this field from captured Network.responseReceived headers.
        return toolSuccess(audit);
      },
    },
    {
      name: "check_robots_txt",
      description: "Fetch and parse the robots.txt file for the current page's domain. Returns disallowed paths, sitemap URLs, and crawl-delay. Uses an in-page fetch() to access the file (preserves same-origin cookies/auth). Requires debugger attached.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const result = await bridge.send({
          type: "browser_evaluate",
          expression: `(async () => {
  const origin = location.origin;
  const robotsUrl = origin + "/robots.txt";
  try {
    const resp = await fetch(robotsUrl, { credentials: "omit" });
    if (!resp.ok) return { url: robotsUrl, found: false, content: null, sitemapUrls: [], disallowedPaths: [], crawlDelay: null };
    const text = await resp.text();
    const sitemapUrls = [];
    const disallowedPaths = [];
    let crawlDelay = null;
    for (const line of text.split("\\n")) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith("sitemap:")) sitemapUrls.push(trimmed.slice(8).trim());
      if (trimmed.toLowerCase().startsWith("disallow:")) { const p = trimmed.slice(9).trim(); if (p) disallowedPaths.push(p); }
      if (trimmed.toLowerCase().startsWith("crawl-delay:")) { const d = parseFloat(trimmed.slice(12).trim()); if (!isNaN(d)) crawlDelay = d; }
    }
    return { url: robotsUrl, found: true, content: text.slice(0, 10000), sitemapUrls, disallowedPaths, crawlDelay };
  } catch (e) {
    return { url: robotsUrl, found: false, content: null, sitemapUrls: [], disallowedPaths: [], crawlDelay: null };
  }
})()`,
        }, TOOL_TIMEOUTS.check_robots_txt);
        const data = result as { result?: unknown };
        return toolSuccess(data?.result ?? { url: "", found: false, content: null, sitemapUrls: [], disallowedPaths: [], crawlDelay: null });
      },
    },
    {
      name: "check_sitemap",
      description: "Fetch and parse the sitemap.xml file for the current page's domain. Returns URL count, sample URLs, and last modified date. Tries /sitemap.xml first, then checks robots.txt for sitemap references. Requires debugger attached.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const result = await bridge.send({
          type: "browser_evaluate",
          expression: `(async () => {
  const origin = location.origin;
  async function trySitemap(sitemapUrl) {
    try {
      const resp = await fetch(sitemapUrl, { credentials: "omit" });
      if (!resp.ok) return null;
      const text = await resp.text();
      const urlMatches = text.match(/<loc>([^<]+)<\\/loc>/g) || [];
      const urls = urlMatches.map(m => m.replace(/<\\/?loc>/g, ""));
      const lastmodMatch = text.match(/<lastmod>([^<]+)<\\/lastmod>/);
      return { url: sitemapUrl, found: true, urlCount: urls.length, sampleUrls: urls.slice(0, 20), lastmod: lastmodMatch ? lastmodMatch[1] : null };
    } catch { return null; }
  }
  // Try default location
  let result = await trySitemap(origin + "/sitemap.xml");
  if (result) return result;
  // Try from robots.txt
  try {
    const robotsResp = await fetch(origin + "/robots.txt", { credentials: "omit" });
    if (robotsResp.ok) {
      const robotsText = await robotsResp.text();
      for (const line of robotsText.split("\\n")) {
        if (line.trim().toLowerCase().startsWith("sitemap:")) {
          const sitemapUrl = line.trim().slice(8).trim();
          result = await trySitemap(sitemapUrl);
          if (result) return result;
        }
      }
    }
  } catch {}
  return { url: origin + "/sitemap.xml", found: false, urlCount: 0, sampleUrls: [], lastmod: null };
})()`,
        }, TOOL_TIMEOUTS.check_sitemap);
        const data = result as { result?: unknown };
        return toolSuccess(data?.result ?? { url: "", found: false, urlCount: 0, sampleUrls: [], lastmod: null });
      },
    },
    // --- Raw vs Rendered Comparison (Phase 5) ---
    {
      name: "compare_raw_rendered",
      description: "Compare raw HTML (pre-JavaScript) vs rendered DOM (post-JavaScript) to detect JS-dependent SEO content. Identifies differences in title, meta description, headings, canonical, structured data, links, and content size. Returns a risk assessment for search engine visibility. Requires debugger attached and network capture active (best when page was loaded with capture running).",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const result = await bridge.send({
          type: "compare_raw_rendered",
        } as BridgeCommand, TOOL_TIMEOUTS.compare_raw_rendered);
        return toolSuccess(result);
      },
    },
    // --- CrUX Metrics (Phase 5) ---
    {
      name: "crux_metrics",
      description: "Fetch Chrome User Experience Report (CrUX) field data for a URL — real-world Core Web Vitals from millions of Chrome users. Returns p75 values for LCP, CLS, INP, TTFB with good/needs-improvement/poor assessment. Requires a Google CrUX API key (pass as api_key or set CRUX_API_KEY env var). Low-traffic URLs may have no data — falls back to origin-level metrics automatically.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to query CrUX data for" },
          api_key: { type: "string", description: "Google CrUX API key. Falls back to CRUX_API_KEY env var if omitted." },
          form_factor: { type: "string", enum: ["PHONE", "DESKTOP", "TABLET"], description: "Filter by device type. Omit for all form factors." },
        },
        required: ["url"],
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          url: z.string().url(),
          api_key: z.string().optional(),
          form_factor: z.enum(["PHONE", "DESKTOP", "TABLET"]).optional(),
        });
        const parsed = schema.parse(args);
        const metrics = await fetchCruxMetrics(parsed.url, parsed.api_key, parsed.form_factor);
        return toolSuccess(metrics);
      },
    },
    // --- SEO Intelligence Settings (Phase 6) ---
    {
      name: "set_seo_intelligence",
      description: "Configure passive SEO intelligence behavior. Controls auto-badge (SERP detection badge on Google SERPs), auto-overlay (automatic SERP overlay injection), and master enable/disable toggle. All settings are partial — omit a field to keep its current value.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Master toggle — disables all auto-SERP behavior when false" },
          autoOverlay: { type: "boolean", description: "Auto-inject SERP overlay on Google SERPs when debugger attached (default: false — opt-in)" },
          autoBadge: { type: "boolean", description: "Auto-update badge/tooltip on SERP detection (default: true — non-intrusive)" },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const data = await bridge.send({
          type: "set_seo_intelligence",
          ...(args.enabled !== undefined && { enabled: args.enabled }),
          ...(args.autoOverlay !== undefined && { autoOverlay: args.autoOverlay }),
          ...(args.autoBadge !== undefined && { autoBadge: args.autoBadge }),
        } as BridgeCommand, TOOL_TIMEOUTS.set_seo_intelligence);
        return toolSuccess(data);
      },
    },
    {
      name: "get_seo_intelligence",
      description: "Get current SEO intelligence settings (enabled, autoOverlay, autoBadge).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({
          type: "get_seo_intelligence",
        } as BridgeCommand, TOOL_TIMEOUTS.get_seo_intelligence);
        return toolSuccess(data);
      },
    },
    {
      name: "set_idle_release",
      description: "Configure idle debugger release. After idleMs of no CDP activity the extension detaches the debugger so Chrome's \"being debugged\" banner disappears; the next tool call re-attaches automatically and restores the session (stealth, framework hooks, network capture). Pass idleMs: 0 to disable. Values below the 60000ms minimum are raised to it. Never fires during a recording, an active agent session, a pending dialog, installed request-interception rules, or active coverage.",
      inputSchema: {
        type: "object",
        properties: {
          idleMs: {
            type: "number",
            description: "Quiet period in milliseconds before detaching. 0 disables. Minimum 60000 when enabled; 300000 is a good default.",
          },
        },
        required: ["idleMs"],
      },
      handler: async (args) => {
        const schema = z.object({ idleMs: z.number().int().min(0).max(24 * 60 * 60 * 1000) });
        const parsed = schema.parse(args);
        const data = await bridge.send({
          type: "set_idle_release",
          idleMs: parsed.idleMs,
        } as BridgeCommand, TOOL_TIMEOUTS.set_idle_release);
        return toolSuccess(data);
      },
    },
    {
      name: "get_idle_release",
      description: "Get the current idle debugger release setting (idleMs, enabled, minimumMs, defaultMs).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const data = await bridge.send({
          type: "get_idle_release",
        } as BridgeCommand, TOOL_TIMEOUTS.get_idle_release);
        return toolSuccess(data);
      },
    },
    ...createPickerTools(bridge),
  ];
}

// --- Comparison Scaffold Builder (Phase 5) ---

const COMPARISON_DIMENSIONS = [
  "framework", "performance", "security", "seo", "accessibility",
  "error-surface", "third-party-load", "architecture", "content-delivery", "mobile-readiness",
  "data-structure",
] as const;

function observeField(data: PageEvidence & { gaps?: CoverageGap[] }, dimension: string): Observation {
  switch (dimension) {
    case "framework":
      return (data.capture as Record<string, unknown>)?.framework
        ? { type: "present", dimension, value: (data.capture as Record<string, unknown>).framework }
        : { type: "absent", dimension, gap: { dimension, reason: "No framework detected", impact: "data-absent", reducesConfidence: false } };
    case "performance":
      return data.performance
        ? { type: "present", dimension, value: data.performance }
        : { type: "absent", dimension, gap: data.gaps?.find(g => g.dimension === "performance") ?? { dimension, reason: "Performance data unavailable", impact: "data-absent", reducesConfidence: false } };
    case "security":
      return data.security
        ? { type: "present", dimension, value: data.security }
        : { type: "absent", dimension, gap: data.gaps?.find(g => g.dimension === "security") ?? { dimension, reason: "Security data unavailable", impact: "data-absent", reducesConfidence: false } };
    case "seo":
      return data.meta?._title || data.meta?._canonical || (data.meta?._structuredData?.length ?? 0) > 0
        ? { type: "present", dimension, value: { title: data.meta?._title, canonical: data.meta?._canonical, structuredData: data.meta?._structuredData?.length ?? 0 } }
        : { type: "absent", dimension };
    case "accessibility":
      return data.accessibility
        ? { type: "present", dimension, value: data.accessibility }
        : { type: "absent", dimension, gap: data.gaps?.find(g => g.dimension === "accessibility") ?? { dimension, reason: "Accessibility data unavailable", impact: "data-absent", reducesConfidence: false } };
    case "error-surface": {
      const consoleLogs = (data.capture as Record<string, unknown>)?.console;
      return consoleLogs ? { type: "present", dimension, value: consoleLogs } : { type: "absent", dimension };
    }
    case "third-party-load": {
      const network = (data.capture as Record<string, unknown>)?.network;
      return network ? { type: "present", dimension, value: network } : { type: "absent", dimension };
    }
    case "architecture":
      return (data.capture as Record<string, unknown>)?.framework
        ? { type: "present", dimension, value: (data.capture as Record<string, unknown>).framework }
        : { type: "absent", dimension };
    case "content-delivery":
      return data.security
        ? { type: "present", dimension, value: data.security }
        : { type: "absent", dimension };
    case "mobile-readiness": {
      const mr = data.mobileReadiness;
      return mr
        ? { type: mr.hasViewportMeta ? "present" : "degraded", dimension, value: mr }
        : { type: "absent", dimension, gap: data.gaps?.find(g => g.dimension === "mobile-readiness") ?? { dimension, reason: "Mobile readiness data unavailable", impact: "data-absent", reducesConfidence: false } };
    }
    case "data-structure":
      return (data.meta?._structuredData?.length ?? 0) > 0
        ? { type: "present", dimension, value: { structuredDataCount: data.meta?._structuredData?.length ?? 0 } }
        : { type: "absent", dimension };
    default:
      return { type: "absent", dimension };
  }
}

function extractMetrics(data: PageEvidence): Record<string, number | null> {
  const metrics: Record<string, number | null> = {};
  const perf = data.performance as Record<string, unknown> | null;
  if (perf) {
    // Real extension returns { chrome: {...}, webVitals: { lcp, cls, fid }, timing: {...} }
    const wv = perf.webVitals as Record<string, number | null> | undefined;
    if (wv) {
      if (typeof wv.lcp === "number") metrics["LCP"] = wv.lcp;
      if (typeof wv.cls === "number") metrics["CLS"] = wv.cls;
      if (typeof wv.fid === "number") metrics["FID"] = wv.fid;
    }
    const timing = perf.timing as Record<string, number> | undefined;
    if (timing) {
      if (typeof timing.domContentLoaded === "number") metrics["domContentLoaded"] = timing.domContentLoaded;
      if (typeof timing.load === "number") metrics["loadTime"] = timing.load;
      if (typeof timing.firstByte === "number") metrics["TTFB"] = timing.firstByte;
    }
    const chrome = perf.chrome as Record<string, number> | undefined;
    if (chrome) {
      if (typeof chrome.taskDuration === "number") metrics["taskDuration"] = chrome.taskDuration;
      if (typeof chrome.scriptDuration === "number") metrics["scriptDuration"] = chrome.scriptDuration;
      if (typeof chrome.jsHeapUsedSize === "number") metrics["jsHeapUsedSize"] = chrome.jsHeapUsedSize;
    }
    // Fallback: test mocks may use flat metrics.LCP / metrics.FCP shape
    const m = perf.metrics as Record<string, number> | undefined;
    if (m) {
      if (typeof m.LCP === "number" && !metrics["LCP"]) metrics["LCP"] = m.LCP;
      if (typeof m.FCP === "number") metrics["FCP"] = m.FCP;
      if (typeof m.CLS === "number" && !metrics["CLS"]) metrics["CLS"] = m.CLS;
    }
  }
  const net = (data.capture as Record<string, unknown>)?.network as Record<string, unknown> | undefined;
  if (net && typeof net.total === "number") metrics["networkRequests"] = net.total;
  const dom = (data.capture as Record<string, unknown>)?.dom as Record<string, unknown> | undefined;
  if (dom && typeof dom.nodeCount === "number") metrics["domNodeCount"] = dom.nodeCount;
  return metrics;
}

function buildComparisonScaffold(a: PageEvidence & { gaps: CoverageGap[] }, b: PageEvidence & { gaps: CoverageGap[] }): ComparisonScaffold {
  const dimensions: DimensionSlot[] = COMPARISON_DIMENSIONS.map(name => {
    const obsA = observeField(a, name);
    const obsB = observeField(b, name);
    return { name, siteA: obsA, siteB: obsB, comparable: obsA.type === "present" && obsB.type === "present" };
  });

  const fieldsA = new Set(Object.keys(a.capture as Record<string, unknown>));
  const fieldsB = new Set(Object.keys(b.capture as Record<string, unknown>));
  const sharedFields = [...fieldsA].filter(f => fieldsB.has(f));
  const missingFields = {
    siteA: [...fieldsB].filter(f => !fieldsA.has(f)),
    siteB: [...fieldsA].filter(f => !fieldsB.has(f)),
  };

  const metricsA = extractMetrics(a);
  const metricsB = extractMetrics(b);
  const allMetricKeys = new Set([...Object.keys(metricsA), ...Object.keys(metricsB)]);
  const metrics: ComparableMetric[] = [...allMetricKeys].map(name => ({
    name,
    siteA: metricsA[name] ?? null,
    siteB: metricsB[name] ?? null,
  }));

  return { dimensions, sharedFields, missingFields, metrics };
}

// --- smart object builder (framework-aware helpers for code mode) ---

/** Detect snapshot refs like "[ref=e3]" and extract the ref id. Returns null for normal CSS selectors. */
export function parseSnapshotRef(selector: string): string | null {
  const m = /^\[ref=([a-zA-Z0-9]+)\]$/.exec(selector.trim());
  return m ? m[1] : null;
}

/**
 * Wrap a WebSocketBridge so EVERY browser operation routed through `.send` — whether
 * issued directly via `bridge.send(...)` in an execute() script, or indirectly via a
 * `smart.*` / `ocrScreenshot` helper that closes over this bridge — is checked against
 * the live action policy at a single chokepoint.
 *
 * Before this, only the sandbox's direct `bridge` channel ran checkActionPolicy
 * (execute-sandbox.ts: assertBridgeCommand), so `smart.evaluate/click/type/navigate`
 * and `ocrScreenshot` reached the bridge with no policy check and bypassed a
 * `{ deny: ["browser_*"] }` policy entirely.
 *
 * The policy is resolved live (via `getPolicy`) on every call, so a per-URL cached
 * `smart` object always enforces the current (hot-reloaded) policy.
 */
export function makePolicyEnforcingBridge(bridge: Pick<WebSocketBridge, "send">, getPolicy: () => ActionPolicy | null): PolicyEnforcedSender {
  // A plain narrow object — NOT a Proxy over the raw bridge — so tool code can only
  // ever hold this policy-checked `send`, never reach the underlying WebSocketBridge.
  const sender = {
    // async-style: a denied command yields a REJECTED promise (the send() contract),
    // never a synchronous throw — callers always `await` it. Policy is read live so a
    // per-URL cached `smart` object always honors the current hot-reloaded policy.
    send(command: Parameters<WebSocketBridge["send"]>[0], timeout?: number): Promise<unknown> {
      const policy = getPolicy();
      const type = (command as { type?: unknown } | null | undefined)?.type;
      if (policy && typeof type === "string" && checkActionPolicy(type, policy) === "deny") {
        return Promise.reject(new Error(`Action policy denied browser operation in execute: ${type}`));
      }
      return bridge.send(command, timeout);
    },
  };
  // The one and only place the brand is minted (the cast); see policy-sender.ts.
  return sender as unknown as PolicyEnforcedSender;
}

/**
 * The `smart` keys that always exist, independent of what the page turns out to be.
 * Everything else on the object is either a higher-order method or a framework namespace,
 * so this set is what `rebuild` preserves and what surface reporting subtracts.
 */
export const SMART_CORE_KEYS: ReadonlySet<string> = new Set([
  "evaluate", "click", "type", "navigate", "waitFor", "snapshot", "rebuild",
]);

/**
 * Every framework name that gates a namespace below. Feeding all of them to
 * `buildSmartObject` yields the maximal surface — which is how `describeSurface()` reports
 * "up to N namespaces" by construction rather than by counting source. A namespace added
 * with a new trigger must be listed here or it will not appear in that report;
 * `tests/unit/surface.test.ts` fails when the two drift.
 */
export const SMART_NAMESPACE_TRIGGERS: readonly string[] = [
  "Alpine.js", "Angular", "Django", "Drupal", "Gatsby", "Laravel", "Next.js", "Nuxt",
  "React", "Remix", "Shopify", "Svelte", "SvelteKit", "Vue.js", "VuePress", "WooCommerce",
  "WordPress", "jQuery",
];

/** Build the `smart` object with actionability wrappers and framework-specific data accessors */
export async function buildSmartObject(bridge: PolicyEnforcedSender): Promise<Record<string, unknown>> {
  const evaluate = (expression: string, timeout?: number) =>
    bridge.send({ type: "browser_evaluate", expression: wrapEvaluateExpression(expression) }, timeout ?? 5000);

  const smart: Record<string, unknown> = {
    evaluate,
    click: async (selector: string, opts?: { settle?: number }) => {
      const ref = parseSnapshotRef(selector);
      if (ref) {
        const result = await bridge.send({ type: "browser_click", ref, button: "left", modifiers: {} }, 10000);
        await new Promise(r => setTimeout(r, opts?.settle ?? 500));
        return result;
      }
      await pollActionability(bridge, selector);
      const result = await bridge.send({ type: "browser_click", selector, button: "left", modifiers: {} }, 10000);
      await new Promise(r => setTimeout(r, opts?.settle ?? 500));
      return result;
    },
    type: async (selector: string, text: string, opts?: { clearFirst?: boolean; settle?: number }) => {
      const ref = parseSnapshotRef(selector);
      if (ref) {
        const result = await bridge.send({ type: "browser_type", ref, text, clearFirst: opts?.clearFirst ?? false, modifiers: {} }, 10000);
        await new Promise(r => setTimeout(r, opts?.settle ?? 300));
        return result;
      }
      await pollActionability(bridge, selector);
      const result = await bridge.send({ type: "browser_type", selector, text, clearFirst: opts?.clearFirst ?? false, modifiers: {} }, 10000);
      await new Promise(r => setTimeout(r, opts?.settle ?? 300));
      return result;
    },
    navigate: async (url: string, opts?: { settle?: number }) => {
      smartObjectCache = null;
      const result = await bridge.send({ type: "browser_navigate", url }, 30000);
      await new Promise(r => setTimeout(r, opts?.settle ?? 1000));
      return result;
    },
    waitFor: async (selector: string, timeout?: number) => {
      const ref = parseSnapshotRef(selector);
      if (ref) {
        // Refs are resolved from the cached snapshot — no DOM polling needed.
        // Just verify the ref exists by attempting a resolve via the extension.
        await bridge.send({ type: "browser_hover", ref }, timeout ?? 5000);
        return { found: true, selector };
      }
      await pollActionability(bridge, selector, timeout ?? 5000);
      return { found: true, selector };
    },
    snapshot: (opts?: { interactive?: boolean; compact?: boolean; maxDepth?: number; selector?: string }) =>
      bridge.send({ type: "browser_snapshot", ...opts }, 10000),
    rebuild: async () => {
      smartObjectCache = null;
      const fresh = await buildSmartObject(bridge);
      const coreKeys = SMART_CORE_KEYS;
      const namespaces = Object.keys(fresh).filter(k => !coreKeys.has(k));
      // Replace all keys on current smart object
      for (const key of Object.keys(smart)) {
        if (!coreKeys.has(key)) delete smart[key];
      }
      for (const [key, value] of Object.entries(fresh)) {
        if (!coreKeys.has(key)) smart[key] = value;
      }
      return namespaces;
    },
  };

  // Detect frameworks once, build Set<string> for O(1) lookups
  let fw: { detections?: Array<{ name: string }> } | null;
  try {
    fw = await bridge.send({ type: "detect_framework" }, 5000) as { detections?: Array<{ name: string }> };
  } catch { fw = null; }

  const detected = new Set<string>(
    (fw?.detections ?? []).map((d) => d.name)
  );

  // React
  if (detected.has("React")) {
    smart.react = {
      getVersion: () => evaluate(`(() => { const h = window.__REACT_DEVTOOLS_GLOBAL_HOOK__; if (!h?.renderers?.size) return null; const r = [...h.renderers.values()][0]; return { version: r.version, bundleType: r.bundleType === 0 ? 'production' : 'development' }; })()`),
      getRootCount: () => evaluate(`(() => { const h = window.__REACT_DEVTOOLS_GLOBAL_HOOK__; if (!h?.renderers?.size) return 0; return h.getFiberRoots?.(1)?.size ?? 0; })()`),
      hasProfiler: () => evaluate(`!!window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.values?.()?.next?.()?.value?.getProfilingData`),
      isHookInstalled: () => evaluate(`!!window.__REACT_DEVTOOLS_GLOBAL_HOOK__`),
    };
  }

  // Vue
  if (detected.has("Vue.js") || detected.has("Nuxt") || detected.has("VuePress")) {
    smart.vue = {
      getVersion: () => evaluate(`window.__vue_app__?.version ?? window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.Vue?.version ?? null`),
      getAppCount: () => evaluate(`window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.apps?.length ?? (window.__vue_app__ ? 1 : 0)`),
      getConfig: () => evaluate(`(() => { const app = window.__vue_app__; if (!app) return null; const c = app.config; return { performance: c.performance, globalProperties: Object.keys(c.globalProperties || {}), isCustomElement: !!c.isCustomElement }; })()`),
      isDevMode: () => evaluate(`!!window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.enabled`),
    };
  }

  // Angular
  if (detected.has("Angular")) {
    smart.angular = {
      getVersion: () => evaluate(`document.querySelector('[ng-version]')?.getAttribute('ng-version')`),
      isDebugMode: () => evaluate(`typeof window.ng?.getComponent === 'function'`),
      isIvy: () => evaluate(`(() => { const el = document.querySelector('[ng-version]'); return el ? !!el.__ngContext__ : null; })()`),
      getRootCount: () => evaluate(`(() => { try { return window.getAllAngularRootElements?.()?.length ?? 0; } catch { return 0; } })()`),
      getState: () => evaluate(`(() => ({ isAngular: !!document.querySelector('[ng-version]'), isDebugMode: typeof window.ng?.getComponent === 'function', version: document.querySelector('[ng-version]')?.getAttribute('ng-version') }))()`),
    };
  }

  // Svelte
  if (detected.has("Svelte") || detected.has("SvelteKit")) {
    smart.svelte = {
      getVersion: () => evaluate(`(() => { const s = window.__svelte__; if (s?.v?.size) return [...s.v][0]; if (window.__svelte_meta) { const v = Object.values(window.__svelte_meta.versions || {}); return v[0]?.version; } return null; })()`),
      getMeta: () => evaluate(`window.__svelte_meta ?? null`),
      isDetected: () => evaluate(`!!(window.__svelte__ || window.__svelte_meta || document.querySelector('[class*="svelte-"]'))`),
    };
  }

  // Redux (framework-agnostic state management)
  if (detected.has("React") || detected.has("Angular") || detected.has("Vue.js")) {
    smart.redux = {
      isInstalled: () => evaluate(`!!window.__REDUX_DEVTOOLS_EXTENSION__`),
      getStoreState: () => evaluate(`(() => { var replacer = function(k, v) { if (v instanceof Map) return { __type: 'Map', entries: Array.from(v) }; if (v instanceof Set) return { __type: 'Set', values: Array.from(v) }; if (typeof v === 'symbol') return { __type: 'Symbol', desc: v.description }; if (typeof v === 'number' && isNaN(v)) return { __type: 'NaN' }; if (v === Infinity) return { __type: 'Infinity' }; if (v === -Infinity) return { __type: '-Infinity' }; return v; }; try { var hook = window.__REDUX_DEVTOOLS_GLOBAL_HOOK__; if (hook && hook.store && typeof hook.store.getState === 'function') { return JSON.parse(JSON.stringify(hook.store.getState(), replacer)); } if (hook && hook._stores) { var keys = Object.keys(hook._stores); if (keys.length > 0 && typeof hook._stores[keys[0]].getState === 'function') { return JSON.parse(JSON.stringify(hook._stores[keys[0]].getState(), replacer)); } } if (window.__REDUX_STORE__ && typeof window.__REDUX_STORE__.getState === 'function') { return JSON.parse(JSON.stringify(window.__REDUX_STORE__.getState(), replacer)); } if (window.store && typeof window.store.getState === 'function') { return JSON.parse(JSON.stringify(window.store.getState(), replacer)); } return null; } catch(e) { return { error: e.message }; } })()`),
    };
  }

  // Alpine.js
  if (detected.has("Alpine.js")) {
    smart.alpine = {
      getVersion: () => evaluate(`window.Alpine?.version ?? null`),
      getStoreKeys: () => evaluate(`(() => { try { return Object.keys(window.Alpine?._stores ?? {}); } catch { return []; } })()`),
      getComponentCount: () => evaluate(`document.querySelectorAll('[x-data]').length`),
    };
  }

  // Next.js
  if (detected.has("Next.js")) {
    smart.nextjs = {
      getData: () => evaluate(`window.__NEXT_DATA__`),
      getRouter: () => evaluate(`(() => { const r = window.next?.router; if (!r) return null; return { pathname: r.pathname, query: r.query, asPath: r.asPath, basePath: r.basePath, locale: r.locale }; })()`),
      getSSRMode: () => evaluate(`(() => { const d = window.__NEXT_DATA__; if (!d) return null; return d.runtimeConfig ? 'hybrid' : (document.querySelector('next-route-announcer') ? 'app-router' : 'static'); })()`),
      getRouteManifest: () => evaluate(`window.__NEXT_DATA__?.page`),
    };
  }

  // Nuxt
  if (detected.has("Nuxt")) {
    smart.nuxt = {
      getData: () => evaluate(`window.__NUXT__`),
      getConfig: () => evaluate(`window.__NUXT__?.config?.app`),
      isSSR: () => evaluate(`!!window.__NUXT__?.serverRendered`),
    };
  }

  // Remix
  if (detected.has("Remix")) {
    smart.remix = {
      getContext: () => evaluate(`window.__remixContext`),
      getRouteData: () => evaluate(`window.__remixContext?.state?.loaderData`),
    };
  }

  // Gatsby
  if (detected.has("Gatsby")) {
    smart.gatsby = {
      getData: () => evaluate(`window.___gatsby`),
      getPageData: () => evaluate(`window.__PATH_PREFIX__`),
    };
  }

  // Shopify
  if (detected.has("Shopify")) {
    smart.shopify = {
      getShop: () => evaluate(`(() => { const s = window.Shopify; if (!s) return null; return { shop: s.shop, theme: s.theme, locale: s.locale, currency: s.currency, country: s.country }; })()`),
      getCart: () => evaluate(`window.Shopify?.cart ?? null`),
    };
  }

  // WordPress
  if (detected.has("WordPress")) {
    smart.wordpress = {
      isWP: () => evaluate(`!!document.querySelector("link[href*='wp-content']")`),
      getRestUrl: () => evaluate(`document.querySelector('link[rel="https://api.w.org/"]')?.getAttribute('href') ?? null`),
      getPlugins: () => evaluate(`(() => { const scripts = [...document.querySelectorAll('script[src*="wp-content/plugins/"]')]; return [...new Set(scripts.map(s => s.src.match(/plugins\\/([^/]+)/)?.[1]).filter(Boolean))]; })()`),
    };
  }

  // WooCommerce
  if (detected.has("WooCommerce")) {
    smart.woocommerce = {
      getParams: () => evaluate(`window.woocommerce_params`),
    };
  }

  // Laravel
  if (detected.has("Laravel")) {
    smart.laravel = {
      getCSRF: () => evaluate(`document.querySelector('meta[name="csrf-token"]')?.content ?? null`),
    };
  }

  // Django
  if (detected.has("Django")) {
    smart.django = {
      getCSRF: () => evaluate(`document.querySelector('input[name="csrfmiddlewaretoken"]')?.value ?? null`),
    };
  }

  // Drupal
  if (detected.has("Drupal")) {
    smart.drupal = {
      getSettings: () => evaluate(`window.Drupal?.settings`),
    };
  }

  // jQuery
  if (detected.has("jQuery")) {
    smart.jquery = {
      getVersion: () => evaluate(`window.jQuery?.fn?.jquery`),
    };
  }

  // --- Higher-order methods (always available, not framework-dependent) ---

  smart.finding = (input: Record<string, unknown>): Finding => {
    const { claim, evidence, sourceUrl, confidence, method, dimension } = input;
    if (typeof claim !== "string" || !claim) throw new Error("finding.claim is required (string)");
    if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("finding.evidence is required (non-empty string[])");
    if (typeof sourceUrl !== "string" || !sourceUrl) throw new Error("finding.sourceUrl is required (string)");
    if (!["high", "medium", "low"].includes(confidence as string)) throw new Error("finding.confidence must be 'high' | 'medium' | 'low'");
    if (typeof method !== "string" || !method) throw new Error("finding.method is required (string)");
    for (const e of evidence) {
      if (typeof e !== "string") throw new Error("finding.evidence[] must be strings");
    }

    let finalConfidence = confidence as ConfidenceLevel;
    let confidenceCapped = false;
    let cappedBy: string | undefined;

    if (typeof dimension === "string") {
      const gap = sessionGaps.find(g => g.dimension === dimension && g.reducesConfidence);
      if (gap) {
        const capMap: Record<string, ConfidenceLevel> = { high: "medium", medium: "low", low: "low" };
        const capped = capMap[finalConfidence];
        if (capped && capped !== finalConfidence) {
          finalConfidence = capped;
          confidenceCapped = true;
          cappedBy = gap.dimension;
        }
      }
    }

    const finding: Finding = {
      claim: claim as string,
      evidence: evidence as string[],
      sourceUrl: sourceUrl as string,
      confidence: finalConfidence,
      method: method as string,
      dimension: typeof dimension === "string" ? dimension : undefined,
    };
    if (confidenceCapped) {
      finding.confidenceCapped = true;
      finding.cappedBy = cappedBy;
    }

    sessionFindings.push(finding);
    return finding;
  };

  smart.findings = (): Finding[] => [...sessionFindings];

  smart.clearFindings = (): void => {
    sessionFindings = [];
    sessionGaps = [];
  };

  // --- Phase 11: Structured Data Extraction ---

  smart.detectTables = async (opts?: { maxCandidates?: number }): Promise<TableCandidate[]> => {
    // 15s (matching TOOL_TIMEOUTS.detect_tables): the detector walks the full DOM.
    const result = await evaluate(buildDetectTablesJs(opts), 15000) as { result: TableCandidate[] };
    return result.result || [];
  };

  smart.extractTable = async (selector: string, opts?: { maxRows?: number }): Promise<TableExtraction> => {
    // 15s (matching TOOL_TIMEOUTS.extract_table): row extraction recurses the container subtree.
    const result = await evaluate(buildExtractTableJs(selector, opts), 15000) as { result: TableExtraction };
    return result.result || { selector, columns: [], rows: [], totalRows: 0, truncated: false };
  };

  smart.detectSections = async (opts?: { maxDepth?: number; maxSections?: number }): Promise<PageSections> => {
    // 15s (matching TOOL_TIMEOUTS.detect_sections): the walker visits the full DOM.
    const result = await evaluate(buildDetectSectionsJs(opts), 15000) as { result: PageSections };
    return result.result || { url: "", viewport: { width: 0, height: 0 }, sections: [], totalDetected: 0, truncated: false };
  };

  smart.waitForNetworkIdle = async (opts?: { timeout?: number; idleTime?: number }): Promise<NetworkIdleResult> => {
    const timeout = Math.min(opts?.timeout ?? 15000, 30000);
    const idleTime = Math.min(opts?.idleTime ?? 500, 5000);
    const result = await bridge.send({
      type: "wait_for_network_idle",
      timeout,
      idleTime,
    }, timeout + 5000);
    return result as NetworkIdleResult;
  };

  smart.extractData = async (opts?: { maxTables?: number; maxRowsPerTable?: number }): Promise<DataExtraction> => {
    const maxTables = opts?.maxTables ?? 3;
    const maxRowsPerTable = opts?.maxRowsPerTable ?? 200;

    // Get current URL
    const status = await bridge.send({ type: "get_connection_status" }, 5000) as { connectedTab?: { url?: string } };
    const url = status?.connectedTab?.url || "";

    // Detect tables
    const candidates = await (smart.detectTables as (opts?: { maxCandidates?: number }) => Promise<TableCandidate[]>)({ maxCandidates: maxTables });

    // Extract each candidate
    const tables: TableExtraction[] = [];
    for (const candidate of candidates) {
      const extraction = await (smart.extractTable as (selector: string, opts?: { maxRows?: number }) => Promise<TableExtraction>)(
        candidate.selector, { maxRows: maxRowsPerTable }
      );
      // Filter noise: require at least 2 columns and 2 rows
      if (extraction.columns.length >= 2 && extraction.rows.length >= 2) {
        tables.push(extraction);
      }
    }

    // Extract JSON-LD structured data
    const jsonLd = await evaluate(`(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const result = [];
      scripts.forEach(s => { try { result.push(JSON.parse(s.textContent)); } catch {} });
      return result;
    })()`) as { result: unknown[] };

    return {
      tables,
      structuredData: jsonLd.result || [],
      url,
    };
  };

  // --- Detection Wedge: Tracking Pixel Parser ---
  smart.parseTrackingPixels = async (): Promise<TrackingParseResult> => {
    const data = await bridge.send({ type: "parse_tracking_pixels" }, 10000) as TrackingParseResult;
    return data;
  };

  // --- Detection Wedge: Tracking Event Validation ---
  smart.validateTracking = async (): Promise<TrackingValidationResult> => {
    const parseResult = await bridge.send({ type: "parse_tracking_pixels" }, 10000) as TrackingParseResult;
    return validateTrackingEvents(parseResult);
  };

  // --- Detection Wedge: DataLayer Inspection ---
  smart.inspectDataLayer = async (): Promise<DataLayerState> => {
    return await bridge.send({ type: "inspect_datalayer" }, 10000) as DataLayerState;
  };

  // --- Detection Wedge: Duplicate Event Detection ---
  smart.detectDuplicates = async (): Promise<DuplicateCluster[]> => {
    const parseResult = await bridge.send({ type: "parse_tracking_pixels" }, 10000) as TrackingParseResult;
    return detectDuplicates(parseResult.events);
  };

  smart.detectTechnologies = async (opts?: { confidenceThreshold?: number }): Promise<TechnographicResult> => {
    const threshold = opts?.confidenceThreshold ?? 1;

    // Run capture_page to get network entries + cookies, plus parallel JS-based signal collection
    const [capture, metaResult, jsResult, htmlResult] = await Promise.all([
      bridge.send({ type: "capture_page" }, 20000) as Promise<PageCapture>,
      evaluate(META_TAG_EXTRACTION_EXPR).catch(() => ({ result: {} })),
      evaluate(buildJSGlobalsCheckExpr()).catch(() => ({ result: {} })),
      evaluate("document.documentElement.outerHTML.substring(0, 50000)").catch(() => ({ result: "" })),
    ]) as [
      PageCapture,
      { result: Record<string, string> },
      { result: Record<string, string | null> },
      { result: string },
    ];

    const pageUrl = capture?.url || "";

    const signals = collectSignals({
      networkEntries: capture.networkRequests || [],
      cookies: capture.cookies || [],
      metaTags: (metaResult as { result: Record<string, string> }).result as Record<string, string>,
      jsGlobals: (jsResult as { result: Record<string, string | null> }).result as Record<string, string | null>,
      url: pageUrl,
      html: typeof (htmlResult as { result: string }).result === "string" ? (htmlResult as { result: string }).result : undefined,
    });

    const detections = matchFingerprints(signals);
    const filtered = threshold > 0 ? detections.filter(d => d.confidence >= threshold) : detections;
    return buildTechnographicResult(filtered, signals, 50);
  };

  smart.scrollCapture = async (opts?: {
    maxSections?: number;
    pixelsPerScroll?: number;
    settleMs?: number;
  }): Promise<ScrollEvidence> => {
    const max = opts?.maxSections ?? 10;
    const px = opts?.pixelsPerScroll ?? 800;
    const settle = opts?.settleMs ?? 1000;
    const sections: ScrollEvidence["sections"] = [];

    for (let i = 0; i < max; i++) {
      const pos = await evaluate(`({ scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight })`) as { result: { scrollY: number; scrollHeight: number; viewportHeight: number } };
      const { scrollY, scrollHeight, viewportHeight } = pos.result;

      const ss = await bridge.send({ type: "take_screenshot" }, 15000) as { data?: string; screenshot?: string };
      sections.push({ index: i, scrollY, screenshot: ss?.data || ss?.screenshot || "" });

      if (scrollY + viewportHeight >= scrollHeight - 10) break;

      await bridge.send({ type: "browser_scroll", direction: "down", pixels: px }, 5000);
      await new Promise(r => setTimeout(r, settle));

      const after = await evaluate(`window.scrollY`) as { result: number };
      if (after.result <= scrollY) break;
    }

    await evaluate(`window.scrollTo(0, 0)`);
    return { sectionCount: sections.length, sections };
  };

  smart.waitForIdle = async (timeout?: number): Promise<IdleStatus> => {
    const ms = Math.min(timeout ?? 5000, 15000);
    const result = await evaluate(`
      new Promise((resolve) => {
        let timer;
        const reset = () => { clearTimeout(timer); timer = setTimeout(() => resolve('idle'), 500); };
        const observer = new MutationObserver(reset);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        reset();
        setTimeout(() => { observer.disconnect(); resolve('timeout'); }, ${ms});
      });
    `) as { result: string };
    return { status: result.result as IdleStatus["status"] };
  };

  smart.extractPage = async (opts?: { trace?: boolean }): Promise<PageEvidence & { gaps: CoverageGap[]; _trace?: MethodTrace }> => {
    const gaps: CoverageGap[] = [];
    const tracing = opts?.trace === true;
    const traceSteps: StepTrace[] = [];
    const traceStart = tracing ? Date.now() : 0;

    const traced = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (!tracing) return fn();
      const s = Date.now();
      try {
        const r = await fn();
        traceSteps.push({ name, elapsed: Date.now() - s, success: true });
        return r;
      } catch (e) {
        traceSteps.push({ name, elapsed: Date.now() - s, success: false });
        throw e;
      }
    };

    const [capture, perf, security, fonts, meta, rawA11y, rawMobile] = await Promise.all([
      traced("capture_page", () => bridge.send({ type: "capture_page" }, 60000)),
      traced("get_performance_metrics", () => bridge.send({ type: "get_performance_metrics" }, 5000)).catch((e: unknown) => {
        gaps.push({ dimension: "performance", reason: e instanceof Error ? e.message : String(e), impact: "method-failed", reducesConfidence: true });
        return null;
      }),
      traced("get_security_state", () => bridge.send({ type: "get_security_state" }, 5000)).catch((e: unknown) => {
        gaps.push({ dimension: "security", reason: e instanceof Error ? e.message : String(e), impact: "method-failed", reducesConfidence: true });
        return null;
      }),
      traced("detect_fonts", () => bridge.send({ type: "detect_fonts" }, 10000)).catch((e: unknown) => {
        gaps.push({ dimension: "fonts", reason: e instanceof Error ? e.message : String(e), impact: "method-failed", reducesConfidence: false });
        return null;
      }),
      traced("meta_extraction", () => evaluate(`(() => {
        const m = {}; document.querySelectorAll('meta').forEach(el => {
          const k = el.getAttribute('property') || el.getAttribute('name');
          if (k) m[k] = el.getAttribute('content');
        });
        m._title = document.title;
        m._canonical = document.querySelector('link[rel=canonical]')?.href || null;
        m._structuredData = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => { try { return JSON.parse(s.textContent); } catch { return null; } }).filter(Boolean);
        m._headings = [...document.querySelectorAll('h1,h2,h3')].slice(0, 30).map(h => ({ level: h.tagName, text: h.textContent?.trim()?.substring(0, 120) }));
        m._nav = [...new Set([...document.querySelectorAll('nav a, header a')].map(a => a.href))].slice(0, 50);
        return m;
      })()`)),
      traced("accessibility_tree", () => bridge.send({ type: "get_accessibility_tree", depth: 3 }, 10000)).catch((e: unknown) => {
        gaps.push({ dimension: "accessibility", reason: e instanceof Error ? e.message : String(e), impact: "method-failed", reducesConfidence: false });
        return null;
      }),
      traced("mobile_readiness", () => evaluate(`(() => {
        const vp = document.querySelector('meta[name="viewport"]');
        let mediaQueryCount = 0;
        try { [...document.styleSheets].forEach(s => { try { [...s.cssRules].forEach(r => { if (r instanceof CSSMediaRule) mediaQueryCount++; }); } catch {} }); } catch {}
        return {
          hasViewportMeta: !!vp,
          viewportContent: vp?.getAttribute('content') || null,
          mediaQueryCount,
          bodyScrollWidth: document.body?.scrollWidth ?? 0,
          windowInnerWidth: window.innerWidth,
          isOverflowing: (document.body?.scrollWidth ?? 0) > window.innerWidth,
        };
      })()`)).catch((e: unknown) => {
        gaps.push({ dimension: "mobile-readiness", reason: e instanceof Error ? e.message : String(e), impact: "method-failed", reducesConfidence: false });
        return null;
      }),
    ]);

    const a11ySummary: AccessibilitySummary | null = rawA11y ? summarizeAccessibility(rawA11y as Record<string, unknown>) : null;
    const mobileResult = rawMobile as { result?: MobileReadiness } | null;
    const mobileReadiness: MobileReadiness | null = mobileResult?.result
      ? { hasViewportMeta: !!mobileResult.result.hasViewportMeta, viewportContent: mobileResult.result.viewportContent ?? null, mediaQueryCount: mobileResult.result.mediaQueryCount ?? 0, isOverflowing: !!mobileResult.result.isOverflowing }
      : null;

    // Merge gaps into session-level state for confidence propagation
    for (const gap of gaps) {
      if (!sessionGaps.some(g => g.dimension === gap.dimension)) sessionGaps.push(gap);
    }

    const evidence: PageEvidence & { gaps: CoverageGap[]; _trace?: MethodTrace } = {
      capture: capture as PageEvidence["capture"],
      performance: perf as PageEvidence["performance"],
      security: security as PageEvidence["security"],
      fonts: fonts as PageEvidence["fonts"],
      meta: ((meta as { result?: unknown })?.result || null) as PageEvidence["meta"],
      accessibility: a11ySummary,
      mobileReadiness,
      gaps,
    };

    if (tracing) {
      evidence._trace = {
        method: "extractPage",
        startedAt: traceStart,
        elapsed: Date.now() - traceStart,
        steps: traceSteps,
        outcome: gaps.length === 0 ? "success" : "partial",
      };
    }

    return evidence;
  };

  smart.comparePages = async (urlA: string, urlB: string, opts?: { trace?: boolean }): Promise<ComparisonEvidence> => {
    await (smart.navigate as (url: string) => Promise<unknown>)(urlA);
    const a = await (smart.extractPage as (opts?: { trace?: boolean }) => Promise<PageEvidence & { gaps: CoverageGap[] }>)(opts);
    await (smart.navigate as (url: string) => Promise<unknown>)(urlB);
    const b = await (smart.extractPage as (opts?: { trace?: boolean }) => Promise<PageEvidence & { gaps: CoverageGap[] }>)(opts);

    const scaffold = buildComparisonScaffold(a, b);

    return {
      siteA: { url: urlA, ...a },
      siteB: { url: urlB, ...b },
      scaffold,
    };
  };

  smart.diffSnapshots = async (before?: string): Promise<SnapshotDiffResult> => {
    // Get baseline + current from extension (uses cached lastSnapshot if before not provided)
    const extensionResult = await bridge.send({
      type: "diff_snapshot",
      ...(before !== undefined && { baseline: before }),
    }, 10000) as { baseline: string; current: string };

    return computeDiff(extensionResult.baseline, extensionResult.current);
  };

  return smart;
}

// --- Code Mode: search + execute + connect_tab, plus the three async job tools ---

/** Searchable catalog entry (name + description + schema, no handler) */
interface CatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** How to invoke in code mode when it is NOT the default bridge.send({ type }). */
  codeMode?: string;
}

// Code-mode invocation hints. By default a browser command is called via
// `bridge.send({ type: '<name>', ...params })`. The tools below do NOT follow that
// default: they are server-composed (no matching extension command, so bridge.send
// returns "Unknown command"), or their param schema collides with the bridge
// envelope's own `type` key. Surfacing the true invocation in search results stops
// code-mode callers from silently hitting "Unknown command" / a denied type.
const CODE_MODE_HINTS: Record<string, string> = {
  // Server-composed — reachable in code mode only through a smart.* helper:
  detect_technologies: "code mode: smart.detectTechnologies({ confidenceThreshold }) — not a bridge.send command",
  extract_data: "code mode: smart.extractData() — not a bridge.send command",
  detect_sections: "code mode: smart.detectSections({ maxDepth, maxSections }) — not a bridge.send command",
  // Server-composed with NO code-mode path — available only in --full mode:
  seo_audit: "full-mode (--full) tool only — not reachable via bridge.send or smart.* in code mode",
  crux_metrics: "full-mode (--full) tool only — calls the Google CrUX API server-side",
  check_robots_txt: "full-mode (--full) tool only — not reachable via bridge.send in code mode",
  // Storage tools: the schema's `type` param collides with the bridge envelope's own
  // `type` key, so in code mode the storage kind must be passed as `storageType`:
  get_storage: "code mode: bridge.send({ type: 'get_storage', storageType: 'local'|'session', key? })",
  set_storage: "code mode: bridge.send({ type: 'set_storage', storageType: 'local'|'session', key, value })",
  clear_storage: "code mode: bridge.send({ type: 'clear_storage', storageType: 'local'|'session' })",
};

/** Crawlio ControlServer HTTP endpoints — merged into code-mode search catalog.
 *  Mirrors the 33 entries from CrawlioMCP/Tools.swift toolCatalog. */
const crawlioHTTPCatalog: CatalogEntry[] = [
  { name: "get_crawl_status", description: "GET /status — engine state, progress counters, sequence number. Params: ?since=N (optional)", inputSchema: {} },
  { name: "get_crawl_logs", description: "GET /logs — recent log entries. Params: ?category=engine|download|parser|localizer|network|ui&level=debug|info|default|error|fault&limit=N", inputSchema: {} },
  { name: "get_errors", description: "GET /logs?level=error — error and fault-level log entries", inputSchema: {} },
  { name: "get_downloads", description: "GET /downloads — all download items with status, HTTP code, bytes, content type", inputSchema: {} },
  { name: "get_failed_urls", description: "GET /failed-urls — failed download items with error messages", inputSchema: {} },
  { name: "get_site_tree", description: "GET /site-tree — downloaded files as directory tree", inputSchema: {} },
  { name: "start_crawl", description: "POST /start — start a new crawl. Body: {url, urls?, destinationPath?}", inputSchema: {} },
  { name: "stop_crawl", description: "POST /stop — stop the current crawl", inputSchema: {} },
  { name: "pause_crawl", description: "POST /pause — pause the current crawl", inputSchema: {} },
  { name: "resume_crawl", description: "POST /resume — resume a paused crawl", inputSchema: {} },
  { name: "get_settings", description: "GET /settings — current pending download settings and crawl policy", inputSchema: {} },
  { name: "update_settings", description: "PATCH /settings — partial merge of settings and/or policy (idle-only). Body: {settings?, policy?}", inputSchema: {} },
  { name: "list_projects", description: "GET /projects — all saved crawl projects", inputSchema: {} },
  { name: "save_project", description: "POST /projects — save current crawl project. Body: {name?}", inputSchema: {} },
  { name: "load_project", description: "POST /projects/{id}/load — load a saved project by ID", inputSchema: {} },
  { name: "delete_project", description: "DELETE /projects/{id} — delete a saved project by ID", inputSchema: {} },
  { name: "get_project", description: "GET /projects/{id} — full project details by ID", inputSchema: {} },
  { name: "export_site", description: "POST /export — export downloaded site. Body: {format: folder|zip|singleHTML|warc, destinationPath}", inputSchema: {} },
  { name: "get_export_status", description: "GET /export/status — current export state and progress", inputSchema: {} },
  { name: "extract_site_pipeline", description: "POST /extract — run Next.js RSC extraction pipeline. Body: {destinationPath?}", inputSchema: {} },
  { name: "get_extraction_status", description: "GET /extract/status — current extraction state and progress", inputSchema: {} },
  { name: "recrawl_urls", description: "POST /recrawl — re-crawl specific URLs. Body: {urls: [string]}", inputSchema: {} },
  { name: "get_enrichment_data", description: "GET /enrichment — browser enrichment data (framework, network, console, DOM). Params: ?url=URL (optional)", inputSchema: {} },
  { name: "get_observations", description: "GET /observations — append-only observation timeline. Params: ?host=&op=&source=&since=&limit=", inputSchema: {} },
  { name: "create_finding", description: "POST /finding — create curated finding with evidence. Body: {title, url?, evidence?, synthesis?}", inputSchema: {} },
  { name: "get_findings", description: "GET /findings — list curated findings. Params: ?host=&limit=", inputSchema: {} },
  { name: "get_crawled_urls_list", description: "GET /crawled-urls — downloaded URLs with status and pagination. Params: ?status=&type=&limit=&offset=", inputSchema: {} },
  { name: "trigger_capture", description: "POST /capture — WebKit runtime capture (framework, network, console, DOM). Body: {url}", inputSchema: {} },
  { name: "submit_enrichment_bundle", description: "POST /enrichment/bundle — submit complete enrichment bundle. Body: {url, framework?, networkRequests?, consoleLogs?, domSnapshotJSON?}", inputSchema: {} },
  { name: "submit_enrichment_framework", description: "POST /enrichment/framework — submit framework detection data. Body: {url, framework}", inputSchema: {} },
  { name: "submit_enrichment_network", description: "POST /enrichment/network — submit captured network requests. Body: {url, networkRequests}", inputSchema: {} },
  { name: "submit_enrichment_console", description: "POST /enrichment/console — submit console log entries. Body: {url, consoleLogs}", inputSchema: {} },
  { name: "submit_enrichment_dom", description: "POST /enrichment/dom — submit DOM snapshot. Body: {url, domSnapshotJSON}", inputSchema: {} },
];

/** Build a search index from the full tool list + crawlio HTTP catalog */
export function buildCatalog(tools: Tool[]): CatalogEntry[] {
  const browserCatalog = tools.map(t => {
    const entry: CatalogEntry = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    };
    const hint = CODE_MODE_HINTS[t.name];
    if (hint) entry.codeMode = hint;
    return entry;
  });
  return [...browserCatalog, ...crawlioHTTPCatalog];
}

/**
 * Hybrid search: semantic similarity + keyword scoring.
 *
 * Keyword scoring as a second signal because:
 * - Tool names are highly structured (not natural language)
 * - Exact name matches should always rank highest
 * - Keyword scoring is the proven fallback when embeddings unavailable
 *
 * Score formula: 0.6 * semantic_score + 0.4 * keyword_score (both normalized 0-1)
 */
function searchCatalog(
  catalog: CatalogEntry[],
  query: string,
  limit: number,
  embeddings?: Map<string, Float32Array>,
): CatalogEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return catalog.slice(0, limit);

  // Step 1: Keyword scoring (existing algorithm)
  const keywordScores = new Map<string, number>();
  const tokenAliases: Record<string, string[]> = {
    session: ["recording", "record"],
    recording: ["session"],
    robot: ["training", "replay"],
    training: ["robot", "recording"],
  };
  for (const entry of catalog) {
    let score = 0;
    for (const token of tokens) {
      if (entry.name.toLowerCase() === token) score += 10;
      else if (entry.name.toLowerCase().includes(token)) score += 5;
      if (entry.description.toLowerCase().includes(token)) score += 2;
      for (const alias of tokenAliases[token] ?? []) {
        if (entry.name.toLowerCase().includes(alias)) score += 4;
        else if (entry.description.toLowerCase().includes(alias)) score += 1;
      }
    }
    keywordScores.set(entry.name, score);
  }

  // Step 2: Semantic scoring (if embeddings available)
  const semanticScores = new Map<string, number>();
  if (embeddings && embeddings.size > 0) {
    const queryVec = buildQueryEmbedding(query, catalog, embeddings);
    if (queryVec) {
      const results = semanticSearch(queryVec, embeddings, embeddings.size);
      for (const r of results) {
        semanticScores.set(r.name, r.score);
      }
    }
  }

  // Step 3: Combine scores
  const hasSemanticScores = semanticScores.size > 0;
  const normalizedKeyword = normalizeScores(keywordScores);
  const normalizedSemantic = hasSemanticScores ? normalizeScores(semanticScores) : new Map<string, number>();

  const scored = catalog.map(entry => {
    const kw = normalizedKeyword.get(entry.name) ?? 0;
    const sem = normalizedSemantic.get(entry.name) ?? 0;
    const score = hasSemanticScores ? 0.6 * sem + 0.4 * kw : kw;
    return { entry, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}

/**
 * Create code-mode tools: search, execute, connect_tab.
 * Replaces the full tool surface with three primary tools — the model writes JS against
 * `bridge` and `crawlio` instead of choosing among individual schemas. Counts live in
 * `surface.ts`; stating them here is how they went stale.
 */
export function createCodeModeTools(bridge: WebSocketBridge, crawlio: CrawlioClient, options: CodeModeToolOptions = {}): Tool[] {
  // Build catalog from full tool definitions (for search)
  const allTools = createTools(bridge, crawlio);
  const catalog = buildCatalog(allTools);

  // Load pre-computed embeddings for semantic search (empty map = keyword-only fallback)
  const embeddings = loadEmbeddings();

  // Find connect_tab from the full list — keep it as standalone
  const connectTab = allTools.find(t => t.name === "connect_tab")!;

  return [
    // --- search: discover available commands ---
    {
      name: "search",
      description: "Search available commands by keyword — both browser automation (via bridge.send) and Crawlio HTTP endpoints (via crawlio.api). Returns matching command names, descriptions, and parameter schemas. Use this to discover what commands are available before writing execute() code.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword (e.g. 'screenshot', 'cookie', 'network', 'navigate')" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const schema = z.object({
          query: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(50).default(10),
        });
        const parsed = schema.parse(args);
        const results = searchCatalog(catalog, parsed.query, parsed.limit, embeddings);
        return toolSuccess(results);
      },
    },

    // --- execute: run JS code with bridge + crawlio + smart in scope ---
    {
      name: "execute",
      description: [
        "Execute JavaScript code with access to the browser bridge, Crawlio HTTP client, and smart object.",
        "Use search() first to discover available commands and their parameters.",
        "",
        "IMPORTANT WARNINGS:",
        "- smart.screenshot() does NOT exist. For screenshots: bridge.send({ type: 'take_screenshot' }).",
        "- For structured page evidence, prefer smart.extractPage() — runs 7 ops in parallel with typed gaps[].",
        "- capture_page returns a ~1KB shaped summary. For raw data, use stop_network_capture or get_console_logs.",
        "- Use smart.waitForIdle() instead of sleep(). Use smart.scrollCapture() instead of manual scroll loops.",
        "- smart.snapshot() takes no options or { interactive: true } — there is no { compact: true } option.",
        "- For cross-page navigation, use smart.navigate(url) — never location.href = \"...\" (breaks CDP).",
        "",
        "Available in scope:",
        "- bridge.send(command, timeout?) — send command to browser extension via WebSocket",
        "  command must have a `type` field matching a command name (e.g. { type: 'list_tabs' })",
        "- crawlio.api(method, path, body?) — generic HTTP to ControlServer",
        "  e.g. await crawlio.api('GET', '/status')",
        "  e.g. await crawlio.api('POST', '/start', { url: 'https://example.com' })",
        "  e.g. await crawlio.api('POST', '/export', { format: 'zip', destinationPath: '/tmp/site.zip' })",
        "  e.g. await crawlio.api('PATCH', '/settings', { settings: { maxConcurrent: 8 } })",
        "  Returns { status: number, data: unknown }",
        "- crawlio.getStatus() — shortcut for GET /status",
        "- crawlio.startCrawl(url) — shortcut for POST /start",
        "- crawlio.getEnrichment(url?) — shortcut for GET /enrichment",
        "- crawlio.getCrawledURLs(params?) — shortcut for GET /crawled-urls",
        "- crawlio.postEnrichment(url, data) — shortcut for POST /enrichment/bundle",
        "- sleep(ms) — async wait (max 30s)",
        "- TIMEOUTS — per-command timeout constants",
        "- compileRecording(session, { name, description? }) — compile RecordingSession to SKILL.md",
        "  Returns { skillMarkdown, name, pageCount, interactionCount }",
        "- ocrScreenshot(opts?) — extract text from current page via macOS Vision.framework OCR (macOS only)",
        "  opts: { fullPage?: boolean, selector?: string }",
        "  Returns { regions: [{ text, confidence, bounds }], regionsLimited? }",
        "- saveArtifact(name, contents, opts?) — persist bulk data straight to disk (host-side), bypassing the return value.",
        "  Use this for large extractions instead of returning megabytes: accumulate rows in the sandbox, then write them.",
        "  name: safe relative path (e.g. 'hfs/cross_ref.ndjson'); contents: string (objects are JSON-stringified);",
        "  opts: { append?: boolean } to stream in chunks. Writes under ~/.crawlio/artifacts (CRAWLIO_ARTIFACT_DIR).",
        "  Returns { path, bytes }. Ideal pattern: authed in-page fetch via bridge → accumulate → saveArtifact → return { path, bytes }.",
        "- smart — auto-waiting wrappers and framework-specific data accessors:",
        "  smart.evaluate(expr) → {result, type} — access .result for value. Never JSON.parse() the return directly.",
        "  smart.click(selector, opts?) — poll + click + 500ms settle (accepts CSS or snapshot [ref=X])",
        "  smart.type(selector, text, opts?) — poll + type + 300ms settle",
        "  smart.navigate(url, opts?) — navigate + 1000ms settle",
        "  smart.waitFor(selector, timeout?) — poll until actionable",
        "  smart.snapshot(opts?) — capture accessibility snapshot (opts: { interactive: true } for clickable elements only — NO compact option)",
        "  smart.scrollCapture(opts?) — state-aware page scroll with screenshots, stops at page bottom",
        "  smart.waitForIdle(timeout?) — wait for DOM mutations to settle (500ms quiet window)",
        "  smart.extractPage(opts?) — capture_page + perf + security + fonts + meta + accessibility + mobileReadiness. Returns { capture, performance, security, fonts, meta, accessibility, mobileReadiness, gaps[] }. opts: { trace: true } adds _trace.",
        "  smart.comparePages(urlA, urlB, opts?) — navigate to each URL, run extractPage(), return { siteA, siteB, scaffold }. scaffold has dimensions[], sharedFields, missingFields, metrics.",
        "  smart.finding({ claim, evidence, sourceUrl, confidence, method, dimension? }) — create validated Finding, accumulate in session. Confidence auto-capped if dimension has active gap with reducesConfidence.",
        "  smart.findings() — return all accumulated Finding[] from current session.",
        "  smart.clearFindings() — reset accumulated findings and session gaps.",
        "  smart.detectTables(opts?) — find repeating data patterns in the page. Native <table> elements first (strategy 'table-rows'), then class-frequency div-soup scan with geometric filters (strategy 'sibling-repeated-blocks'). Returns TableCandidate[] (selector, score, rowCount, sampleText, confidence 0..1, strategy, warnings[]).",
        "  smart.extractTable(selector, opts?) — extract structured data from a container. Native tables get thead-derived column names + <name>_url companions; div-soup gets semantic link-first naming. Returns { columns, rows, totalRows, truncated }. opts: { maxRows: 200 }.",
        "  smart.detectSections(opts?) — perceive page structure: depth-capped SectionNode tree from semantic tags, ARIA landmarks, data-component/testid attrs, and PascalCase/BEM class hints. Each node: role, source, name, selector (+ selectorVerified), box, inViewport, interactiveCount, textLength, headings, children. Emits SELECTORS, never [ref=eN] handles — compose with bridge.send({ type: 'browser_snapshot', selector }) for fresh interaction refs inside a region. opts: { maxDepth: 2, maxSections: 40 }.",
        "  smart.waitForNetworkIdle(opts?) — wait for all network requests to settle (CDP-level, catches fetch/XHR/images/CSS/fonts). Returns { status, elapsed }. opts: { timeout: 15000, idleTime: 500 }.",
        "  smart.extractData(opts?) — compound: detectTables + extractTable + JSON-LD. Returns { tables, structuredData, url }.",
        "  smart.parseTrackingPixels() — parse captured network data for tracking pixel fires (Facebook, GA4, TikTok, LinkedIn, Pinterest). Returns { totalPixelFires, vendors, pixels, events, unrecognizedTrackingUrls }.",
        "  smart.validateTracking() — validate tracking events against per-vendor parameter schemas (Facebook 18 standard + GA4 recommended). Returns { events, issues, errorCount, warningCount, infoCount, isHealthy }. Each issue has severity (error/warning/info), code, message, recommendation, and optional parameter.",
        "  smart.inspectDataLayer() — inspect tracker runtime state via CDP (fbq queue, GA4 dataLayer, GTM containers, TikTok ttq). Returns DataLayerState with null for absent trackers. No content script needed.",
        "  smart.detectDuplicates() — detect duplicate pixel fires grouped by vendor+pixelId+eventName+URL. Excludes PageView (legitimate SPA behavior). Returns DuplicateCluster[] with count and timestamps.",
        "  smart.detectTechnologies(opts?) — detect technologies via fingerprint matching against CDP signals (headers, scripts, JS globals, meta, cookies, URL). Returns TechnographicResult { technologies[], categories, totalDetected, highConfidenceCount, signalsUsed }. Each technology has numeric confidence (0-100, additive), version, matchedSignals[]. opts: { confidenceThreshold: 1 }.",
        "  smart.diffSnapshots(before?) — Myers diff current ARIA snapshot against baseline. If before omitted, uses last cached snapshot. Returns { diff, additions, removals, unchanged, changed }.",
        "  Framework namespaces (injected based on detected framework):",
        "  smart.react.{getVersion,getRootCount,hasProfiler,isHookInstalled}",
        "  smart.vue.{getVersion,getAppCount,getConfig,isDevMode}",
        "  smart.angular.{getVersion,isDebugMode,isIvy,getRootCount,getState}",
        "  smart.svelte.{getVersion,getMeta,isDetected}",
        "  smart.redux.{isInstalled,getStoreState}",
        "  smart.alpine.{getVersion,getStoreKeys,getComponentCount}",
        "  smart.nextjs.{getData,getRouter,getSSRMode,getRouteManifest}",
        "  smart.nuxt.{getData,getConfig,isSSR}",
        "  smart.remix.{getContext,getRouteData}",
        "  smart.gatsby.{getData,getPageData}",
        "  smart.shopify.{getShop,getCart}",
        "  smart.wordpress.{isWP,getRestUrl,getPlugins}",
        "  smart.laravel.{getCSRF} | smart.django.{getCSRF} | smart.drupal.{getSettings}",
        "  smart.jquery.{getVersion}",
        "",
        "Example (HTTP API):",
        "  const { data } = await crawlio.api('GET', '/status');",
        "  return data;",
        "",
        "Example (browser):",
        "  const tabs = await bridge.send({ type: 'list_tabs' }, 5000);",
        "  return tabs;",
        "",
        "Example (smart — auto-waiting click):",
        "  await smart.click('#submit-btn');",
        "  return await smart.snapshot();",
        "",
        "Example (smart — framework data):",
        "  const nextData = await smart.nextjs?.getData();",
        "  return { page: nextData?.page, buildId: nextData?.buildId };",
        "",
        "Example (session recording + compile):",
        "  const s = await bridge.send({ type: 'start_recording', maxDurationSec: 120 });",
        "  // ... interact with page ...",
        "  const session = await bridge.send({ type: 'stop_recording' });",
        "  const skill = compileRecording(session, { name: 'my-flow' });",
        "  return skill;",
        "",
        "IMPORTANT: Keep scripts fast (<15s). Each smart.click costs ~1-2s. Never loop 5+ clicks — use smart.evaluate to read DOM data in bulk instead.",
        "IMPORTANT: smart.evaluate returns {result, type}. Access .result for the value. Never JSON.stringify inside evaluate then JSON.parse outside — just return objects directly.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Async JavaScript function body. Has bridge, crawlio, sleep, TIMEOUTS, smart, compileRecording, ocrScreenshot, saveArtifact in scope. Must return a value (for bulk data, saveArtifact to disk and return { path, bytes })." },
          background: { type: "boolean", description: "Run detached: returns { jobId } immediately and keeps executing server-side up to the sandbox cap (~120s). Poll get_job_result(jobId) for the result. Use for heavy/long runs (e.g. navigate + OCR) that would exceed a normal synchronous tool-call timeout." },
        },
        required: ["code"],
      },
      handler: async (args) => {
        const { code, background } = z.object({ code: z.string().min(1).max(50000), background: z.boolean().optional() }).parse(args);

        // Single action-policy chokepoint for this execute() invocation: every browser
        // operation — direct bridge.send AND the smart.* / ocrScreenshot helpers that
        // close over it — flows through this wrapper, which denies per the live policy.
        // Resolved live so the per-URL smart cache enforces the current policy.
        const policyBridge = makePolicyEnforcingBridge(bridge, () => options.getActionPolicy?.() ?? null);

        const sleepFn = (ms: number) => new Promise<void>(r => setTimeout(r, Math.min(ms, 30000)));

        // OCR function exposed in sandbox scope (macOS only, uses bridge + swift shim)
        const ocrScreenshot = async (opts?: { fullPage?: boolean; selector?: string }) => {
          if (process.platform !== "darwin") throw new Error("ocrScreenshot requires macOS (Vision.framework)");
          const screenshotParams: Record<string, unknown> = { type: "take_screenshot" };
          if (opts?.fullPage) screenshotParams.fullPage = true;
          if (opts?.selector) screenshotParams.selector = opts.selector;
          const data = await policyBridge.send(screenshotParams as BridgeCommand, 30000) as { data: string };
          if (!data?.data) throw new Error("Screenshot capture failed — no image data returned");
          const tmpPath = join(tmpdir(), `crawlio-ocr-${randomBytes(6).toString("hex")}.png`);
          try {
            await writeFile(tmpPath, Buffer.from(data.data, "base64"));
            const shimPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ocr-shim.swift");
            const { stdout } = await execFileAsync("swift", [shimPath, tmpPath], { timeout: 25000 });
            if (!stdout.trim()) throw new Error("OCR produced no output");
            const result = JSON.parse(stdout.trim());
            if (result.error) throw new Error(`OCR failed: ${result.error}`);
            if (result.regions?.length > 20) {
              result.regions = result.regions.sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence).slice(0, 20);
              result.regionsLimited = true;
            }
            return result;
          } finally { unlink(tmpPath).catch(() => {}); }
        };

        // Build smart object with framework-aware helpers (cached per URL)
        let currentUrl = "";
        try {
          const status = await policyBridge.send({ type: "get_connection_status" }, 3000) as { connectedTab?: { url?: string } };
          currentUrl = status?.connectedTab?.url || "";
        } catch { /* rebuild on failure */ }

        let smart: Record<string, unknown>;
        if (smartObjectCache && smartObjectCache.url === currentUrl && currentUrl !== "") {
          smart = smartObjectCache.smart;
        } else {
          smart = await buildSmartObject(policyBridge);
          // Only cache if framework detection succeeded (more than 7 core keys: evaluate, click, type, navigate, waitFor, snapshot, rebuild)
          if (currentUrl && Object.keys(smart).length > 7) smartObjectCache = { url: currentUrl, smart };
        }

        try {
          const actionPolicy = options.getActionPolicy?.() ?? null;
          const allowedBridgeTypes = new Set(
            Object.keys(TOOL_TIMEOUTS).filter(toolName => !actionPolicy || checkActionPolicy(toolName, actionPolicy) === "allow")
          );
          const sandboxGlobals = {
            bridge: policyBridge,
            crawlio,
            sleep: sleepFn,
            timeouts: TOOL_TIMEOUTS,
            smart,
            compileRecording: compileRecording as (...args: unknown[]) => unknown,
            ocrScreenshot: ocrScreenshot as (...args: unknown[]) => Promise<unknown>,
            saveArtifact: saveArtifactToDisk,
            allowedBridgeTypes,
            actionPolicy,
          };

          // Background mode (fire-and-poll): kick off the sandbox WITHOUT awaiting, register it
          // under a jobId, and return immediately. The Worker runs detached to completion (or its
          // 120s hard cap) regardless of await, so long/unattended runs survive past the per-tool
          // call timeout. Poll get_job_result / list_jobs; kill with cancel_job.
          if (background) {
            const jobId = randomUUID();
            const controller = new AbortController();
            const job: JobRecord = { status: "running", startedAt: Date.now(), controller };
            sweepJobs();
            jobRegistry.set(jobId, job);
            void executeSandboxedCode(code, { ...sandboxGlobals, signal: controller.signal })
              .then(r => {
                if (job.status === "cancelled") return; // cancel_job already settled it
                job.status = "done"; job.value = r.value; job.console = r.console; job.finishedAt = Date.now();
              })
              .catch(e => {
                if (job.status === "cancelled") return;
                job.status = "error"; job.error = e instanceof Error ? e.message : String(e); job.finishedAt = Date.now();
              });
            return toolSuccess({ jobId, status: "running" });
          }

          const result = await executeSandboxedCode(code, sandboxGlobals);
          return toolSuccess(result.value);
        } catch (syntaxError) {
          if (syntaxError instanceof SyntaxError) {
            return toolError(`Syntax error in code: ${syntaxError.message}`);
          }
          const error = syntaxError;
          const msg = error instanceof Error ? error.message : String(error);
          // Surface actionable message for permission errors from the bridge
          if (error instanceof Error && (error as unknown as Record<string, unknown>).permission_required) {
            const missing = (error as unknown as Record<string, unknown>).missing as { permissions?: string[]; origins?: string[] } | undefined;
            return toolError(formatPermissionDenial(missing, "execute"));
          }
          return toolError(`Execution error: ${msg}`, problemOf(error));
        }
      },
    },

    // --- job control: async fire-and-poll for execute({ background: true }) ---
    {
      name: "get_job_result",
      description: "Poll a background execute job by jobId (returned by execute({ background: true })). Returns { status: running|done|error|cancelled, value?, console?, error?, ageMs, runtimeMs? }, or { status: 'not_found' } if unknown/expired (finished jobs are kept ~10 min).",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "Job id from execute({ background: true })" } },
        required: ["jobId"],
      },
      handler: async (args) => {
        const { jobId } = z.object({ jobId: z.string().min(1) }).parse(args);
        const job = jobRegistry.get(jobId);
        if (!job) return toolSuccess({ jobId, status: "not_found" });
        return toolSuccess({
          jobId,
          status: job.status,
          ...(job.status === "done" ? { value: job.value } : {}),
          ...(job.status === "error" ? { error: job.error } : {}),
          ...(job.console && job.console.length ? { console: job.console } : {}),
          ageMs: Date.now() - job.startedAt,
          ...(job.finishedAt ? { runtimeMs: job.finishedAt - job.startedAt } : {}),
        });
      },
    },
    {
      name: "list_jobs",
      description: "List background execute jobs (running + recently finished). Returns { count, jobs: [{ jobId, status, ageMs, runtimeMs? }] }.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        sweepJobs();
        const now = Date.now();
        const jobs = [...jobRegistry.entries()].map(([jobId, job]) => ({
          jobId,
          status: job.status,
          ageMs: now - job.startedAt,
          ...(job.finishedAt ? { runtimeMs: job.finishedAt - job.startedAt } : {}),
        }));
        return toolSuccess({ count: jobs.length, jobs });
      },
    },
    {
      name: "cancel_job",
      description: "Cancel a running background execute job by jobId — terminates its sandbox worker. No-op if the job already finished.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "Job id to cancel" } },
        required: ["jobId"],
      },
      handler: async (args) => {
        const { jobId } = z.object({ jobId: z.string().min(1) }).parse(args);
        const job = jobRegistry.get(jobId);
        if (!job) return toolSuccess({ jobId, status: "not_found" });
        if (job.status !== "running") return toolSuccess({ jobId, status: job.status, note: "already finished" });
        // Set cancelled BEFORE aborting so the sandbox .then/.catch (fired by abort) won't overwrite it.
        job.status = "cancelled";
        job.finishedAt = Date.now();
        job.controller?.abort();
        return toolSuccess({ jobId, status: "cancelled" });
      },
    },

    // --- connect_tab: kept as standalone first-class tool ---
    connectTab,
  ];
}
