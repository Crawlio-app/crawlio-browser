import { randomBytes } from "crypto";
import { envFlagEnabled, isExplicitRawLane } from "./safety-mode.js";

/**
 * Content boundary markers for agent-safe page output.
 *
 * Wraps page-sourced content with cryptographic nonce-delimited markers to prevent
 * prompt injection when deep agents ingest untrusted web content: the model can tell page
 * text from instructions because only the wrapper knows the nonce.
 *
 * Enabled by default for agent contexts. The explicit raw-capture lane can disable
 * wrapping, because its job is preserving page and traffic data byte for byte.
 */

const MARKER_NAME = "CRAWLIO_PAGE_CONTENT";
const SYSTEM_REMINDER_RE = /<system-reminder\b[^>]*(?:>[\s\S]*?(?:<\/system-reminder>|$)|$)/gi;

export function isContentBoundariesEnabled(): boolean {
  const explicit = envFlagEnabled(process.env, "CRAWLIO_CONTENT_BOUNDARIES");
  if (explicit !== null) return explicit;
  return !isExplicitRawLane();
}

export function stripSystemReminders(content: string): string {
  return content.replace(SYSTEM_REMINDER_RE, "");
}

/**
 * Wrap page-sourced content with nonce-delimited boundary markers.
 * When boundaries are disabled, returns content unchanged.
 */
export function wrapPageContent(content: string, origin: string): string {
  const stripped = stripSystemReminders(content);
  if (!isContentBoundariesEnabled()) return stripped;
  const nonce = randomBytes(8).toString("hex");
  return `--- ${MARKER_NAME} nonce=${nonce} origin=${origin} ---\n${stripped}\n--- END_${MARKER_NAME} nonce=${nonce} ---`;
}

/**
 * Tools whose output contains page-sourced content and should be wrapped.
 *
 * Excludes: search (tool descriptions), connect_tab/disconnect_tab (tab metadata),
 * get_connection_status/reconnect_tab/get_capabilities (status), create_tab/close_tab/switch_tab (tab ops),
 * start_recording/stop_recording/get_recording_status/compile_recording (recording ops),
 * extract_site/get_crawl_status/get_crawled_urls/enrich_url (crawlio HTTP ops),
 * set_* tools (config setters), start_* tools (toggle starters), ignore_certificate_errors,
 * list_service_workers/stop_service_worker/bypass_service_worker (SW management),
 * get_targets/attach_to_target/create_browser_context (target management),
 * force_gc/clear_storage/clear_database/delete_cookies (cleanup ops),
 * take_screenshot (binary image, not text).
 */
export const PAGE_SOURCED_TOOLS = new Set([
  // Data capture
  "capture_page",
  "get_dom_snapshot",
  "get_console_logs",
  "get_accessibility_tree",
  "browser_snapshot",
  "detect_framework",
  "detect_fonts",
  // Evaluation
  "browser_evaluate",
  // Storage & state
  "get_cookies",
  "get_storage",
  "get_dialog",
  // Performance & security
  "get_performance_metrics",
  "get_computed_style",
  "get_security_state",
  // Network data
  "get_response_body",
  "replay_request",
  "stop_network_capture",
  "wait_for_network_idle",
  "get_websocket_connections",
  "get_websocket_messages",
  "parse_tracking_pixels",
  "validate_tracking",
  "inspect_datalayer",
  // Enrichment from extension
  "get_enrichment",
  // Interaction tools that return page state
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_hover",
  "browser_select_option",
  "browser_scroll",
  "browser_double_click",
  "browser_drag",
  "browser_file_upload",
  "browser_fill_form",
  "browser_wait_for",
  "browser_intercept",
  // Frames
  "get_frame_tree",
  // Extraction
  "detect_tables",
  "extract_table",
  "extract_data",
  "detect_sections",
  // OCR
  "ocr_screenshot",
  // Code mode — execute runs in page context
  "execute",
  // ...and so does a BACKGROUND execute, whose output arrives here instead. Same code, same
  // page, same untrusted text — but `execute({background:true})` returns only a jobId, so the
  // content reaches the model through the poll. Leaving these unwrapped meant the identical
  // script was marked untrusted when run in the foreground and trusted when run in the
  // background. list_jobs carries reportPhase() labels, which sandbox code can fill with page
  // text just as easily as a return value.
  "get_job_result",
  "list_jobs",
  // Coverage results
  "stop_css_coverage",
  "stop_js_coverage",
  // Heap & DOM diagnostics
  "take_heap_snapshot",
  "get_dom_counters",
  "get_databases",
  "query_object_store",
  // Layout diagnostics
  "show_layout_shifts",
  "show_paint_rects",
  // PDF output
  "print_to_pdf",
  // DOM inspection
  "highlight_element",
]);

export const BINARY_PAGE_SOURCED_TOOLS = new Set([
  "print_to_pdf",
]);

/**
 * Tools whose runtime `base64Encoded: true` flag is CDP-sourced and therefore
 * trustworthy as a binary-preservation signal. For every OTHER page-sourced tool
 * the flag is attacker-forgeable (the page fully controls the returned JSON), so
 * it must be IGNORED and the value redacted / truncated / boundary-wrapped as
 * normal. Without this gate a page returning `{ content, base64Encoded: true }`
 * from `browser_evaluate` (or any nested object) bypassed value-level redaction
 * and reminder-stripping.
 *
 * `get_response_body` is sometimes-binary (CDP `Network.getResponseBody` returns
 * `{ body, base64Encoded }`); `print_to_pdf` is always-binary. These are the only
 * tools whose flag originates below the page trust boundary.
 */
export const BINARY_CAPABLE_TOOLS = new Set([
  "get_response_body",
  "print_to_pdf",
]);
