// WebSocket protocol between MCP server and Chrome extension

// Maximum length of a JavaScript expression accepted by `browser_evaluate`.
//
// Sized so the selector-kernel prelude (`getForgePreludeJs()`, ~17KB) fits: the picker
// overlay and the robot-training monitor each install themselves in a single evaluate,
// and a 10K limit silently killed both. This bounds only the SOURCE length — page compute
// is bounded by the CDP eval timeout and the response by redaction + output limits.
export const MAX_EVAL_EXPRESSION_LENGTH = 32768;

// Machine-readable failure kinds carried alongside the human-readable `error` string, so a
// caller can branch on the cause instead of pattern-matching prose. The first eight mirror
// the extension's internal CDP classification; the rest cover non-CDP refusals.
export const PROBLEM_CODES = [
  "disconnected",
  "target_closed",
  "target_crashed",
  "not_found",
  "invalid_param",
  "internal_error",
  "timeout",
  "unknown",
  "permission_denied",
  "opt_out",
  "restricted_page",
  "not_connected",
  "policy_denied",
] as const;

export type ProblemCode = typeof PROBLEM_CODES[number];

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === "string" && (PROBLEM_CODES as readonly string[]).includes(value);
}

export type ServerCommand =
  | { type: "capture_page"; id: string }
  | { type: "start_network_capture"; id: string }
  | { type: "stop_network_capture"; id: string }
  | { type: "get_console_logs"; id: string }
  | { type: "get_dom_snapshot"; id: string; maxDepth?: number }
  | { type: "detect_framework"; id: string }
  | { type: "take_screenshot"; id: string }
  | { type: "get_active_tab"; id: string }
  | { type: "ping"; id: string }
  // Browser interaction commands
  | { type: "browser_navigate"; id: string; url: string }
  | { type: "browser_click"; id: string; selector: string }
  | { type: "browser_type"; id: string; selector: string; text: string; clearFirst?: boolean }
  | { type: "browser_press_key"; id: string; key: string }
  | { type: "browser_hover"; id: string; selector: string }
  | { type: "browser_select_option"; id: string; selector: string; value: string }
  | { type: "browser_wait"; id: string; seconds: number }
  // AI orchestration commands (zero human intervention)
  | { type: "connect_tab"; id: string; url?: string; tabId?: number; background?: boolean }
  | { type: "disconnect_tab"; id: string }
  | { type: "list_tabs"; id: string }
  // Perception breadth (all user tabs / history / downloads)
  | { type: "get_user_tabs"; id: string }
  | { type: "get_user_history"; id: string; query?: string; limit?: number; from?: string | number; to?: string | number }
  | { type: "get_downloads"; id: string; limit?: number }
  | { type: "get_connection_status"; id: string }
  | { type: "reconnect_tab"; id: string }
  | { type: "get_capabilities"; id: string }
  // Background agent-owned browser sessions
  | { type: "agent_session_create"; id: string; [key: string]: unknown }
  | { type: "agent_session_list"; id: string; [key: string]: unknown }
  | { type: "agent_session_status"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_close"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_snapshot"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_action"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_batch"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_artifacts"; id: string; sessionId: string; [key: string]: unknown }
  // Session tab-fleet management (tab-group per session)
  | { type: "agent_session_create_tab"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_claim_tab"; id: string; sessionId: string; tabId: number; [key: string]: unknown }
  | { type: "agent_session_name"; id: string; sessionId: string; name: string; [key: string]: unknown }
  | { type: "agent_session_finalize"; id: string; sessionId: string; [key: string]: unknown }
  // Cookie & storage commands
  | { type: "get_cookies"; id: string }
  | { type: "set_cookie"; id: string; [key: string]: unknown }
  | { type: "delete_cookies"; id: string; [key: string]: unknown }
  | { type: "get_storage"; id: string; [key: string]: unknown }
  | { type: "set_storage"; id: string; [key: string]: unknown }
  | { type: "clear_storage"; id: string; [key: string]: unknown }
  // Dialog commands
  | { type: "get_dialog"; id: string }
  | { type: "handle_dialog"; id: string; [key: string]: unknown }
  // Response body
  | { type: "get_response_body"; id: string; [key: string]: unknown }
  // Viewport & emulation
  | { type: "set_viewport"; id: string; [key: string]: unknown }
  | { type: "set_user_agent"; id: string; [key: string]: unknown }
  | { type: "emulate_device"; id: string; [key: string]: unknown }
  // PDF
  | { type: "print_to_pdf"; id: string; [key: string]: unknown }
  // Advanced input
  | { type: "browser_scroll"; id: string; [key: string]: unknown }
  | { type: "browser_double_click"; id: string; [key: string]: unknown }
  | { type: "browser_drag"; id: string; [key: string]: unknown }
  // File upload
  | { type: "browser_file_upload"; id: string; [key: string]: unknown }
  // Geolocation
  | { type: "set_geolocation"; id: string; [key: string]: unknown }
  // Accessibility
  | { type: "get_accessibility_tree"; id: string; [key: string]: unknown }
  // Performance
  | { type: "get_performance_metrics"; id: string }
  // Stealth
  | { type: "set_stealth_mode"; id: string; [key: string]: unknown }
  // WebSocket monitoring
  | { type: "get_websocket_connections"; id: string; [key: string]: unknown }
  | { type: "get_websocket_messages"; id: string; [key: string]: unknown }
  // Network conditions
  | { type: "emulate_network"; id: string; [key: string]: unknown }
  | { type: "set_cache_disabled"; id: string; [key: string]: unknown }
  | { type: "set_extra_headers"; id: string; [key: string]: unknown }
  // Security
  | { type: "get_security_state"; id: string }
  | { type: "ignore_certificate_errors"; id: string; [key: string]: unknown }
  // Service workers
  | { type: "list_service_workers"; id: string }
  | { type: "stop_service_worker"; id: string; [key: string]: unknown }
  | { type: "bypass_service_worker"; id: string; [key: string]: unknown }
  // DOM mutation
  | { type: "set_outer_html"; id: string; [key: string]: unknown }
  | { type: "set_attribute"; id: string; [key: string]: unknown }
  | { type: "remove_attribute"; id: string; [key: string]: unknown }
  | { type: "remove_node"; id: string; [key: string]: unknown }
  // CSS/JS coverage
  | { type: "start_css_coverage"; id: string }
  | { type: "stop_css_coverage"; id: string }
  | { type: "start_js_coverage"; id: string; [key: string]: unknown }
  | { type: "stop_js_coverage"; id: string }
  // Computed style, pseudo state & font detection
  | { type: "get_computed_style"; id: string; [key: string]: unknown }
  | { type: "force_pseudo_state"; id: string; [key: string]: unknown }
  | { type: "detect_fonts"; id: string; [key: string]: unknown }
  // IndexedDB
  | { type: "get_databases"; id: string }
  | { type: "query_object_store"; id: string; [key: string]: unknown }
  | { type: "clear_database"; id: string; [key: string]: unknown }
  // Targets
  | { type: "get_targets"; id: string }
  | { type: "attach_to_target"; id: string; [key: string]: unknown }
  | { type: "create_browser_context"; id: string; [key: string]: unknown }
  // Memory & heap
  | { type: "get_dom_counters"; id: string }
  | { type: "force_gc"; id: string }
  | { type: "take_heap_snapshot"; id: string }
  // Overlay & visual debug
  | { type: "highlight_element"; id: string; [key: string]: unknown }
  | { type: "show_layout_shifts"; id: string; [key: string]: unknown }
  | { type: "show_paint_rects"; id: string; [key: string]: unknown }
  // Selector wait
  | { type: "wait_for_selector"; id: string; [key: string]: unknown }
  | { type: "browser_wait_for"; id: string; [key: string]: unknown }
  // Frame commands
  | { type: "get_frame_tree"; id: string }
  | { type: "switch_to_frame"; id: string; frameId: string }
  | { type: "switch_to_main_frame"; id: string }
  // Tab management
  | { type: "create_tab"; id: string; [key: string]: unknown }
  | { type: "close_tab"; id: string; tabId: number }
  | { type: "switch_tab"; id: string; tabId: number }
  // Network intercept
  | { type: "browser_intercept"; id: string; [key: string]: unknown }
  // Network replay
  | { type: "replay_request"; id: string; [key: string]: unknown }
  // Crawlio server commands
  | { type: "extract_site"; id: string; [key: string]: unknown }
  | { type: "get_crawl_status"; id: string; [key: string]: unknown }
  | { type: "get_enrichment"; id: string; [key: string]: unknown }
  | { type: "get_crawled_urls"; id: string; [key: string]: unknown }
  | { type: "enrich_url"; id: string; [key: string]: unknown }
  // Code execution
  | { type: "execute_code"; id: string; [key: string]: unknown }
  // JS evaluation (MCP hardening — browser_evaluate via CDP Runtime.evaluate)
  | { type: "browser_evaluate"; id: string; expression: string }
  // Batch form fill (via refs from browser_snapshot)
  | { type: "browser_fill_form"; id: string; fields: Array<{ ref: string; type?: string; value: string }> }
  // Accessibility snapshot (via CDP Accessibility.getFullAXTree, with optional filtering)
  | { type: "browser_snapshot"; id: string; interactive?: boolean; compact?: boolean; maxDepth?: number; selector?: string }
  // Session recording
  | { type: "start_recording"; id: string; maxDurationSec?: number; maxInteractions?: number }
  | { type: "stop_recording"; id: string }
  | { type: "get_recording_status"; id: string }
  // Network idle detection
  | { type: "wait_for_network_idle"; id: string; timeout?: number; idleTime?: number }
  // Tracking pixel parser
  | { type: "parse_tracking_pixels"; id: string }
  // DataLayer inspection (CDP Runtime.evaluate — probes fbq, dataLayer, GTM, ttq state)
  | { type: "inspect_datalayer"; id: string }
  // Snapshot diffing
  | { type: "diff_snapshot"; id: string; baseline?: string }
  // CDP SERP overlay (Phase 3)
  | { type: "inject_serp_overlay"; id: string; widgets: string[]; query: string; data: Record<string, unknown> }
  | { type: "clear_serp_overlay"; id: string }
  // Raw vs Rendered comparison (Phase 5)
  | { type: "compare_raw_rendered"; id: string }
  // SEO Intelligence settings (Phase 6)
  | { type: "set_seo_intelligence"; id: string; [key: string]: unknown }
  | { type: "get_seo_intelligence"; id: string }
  // Idle debugger release — detach after a quiet period so Chrome's "being debugged"
  // banner clears; the next command re-attaches. `idleMs: 0` disables it.
  | { type: "set_idle_release"; id: string; idleMs: number }
  | { type: "get_idle_release"; id: string };

export type ExtensionResponse =
  | { type: "response"; id: string; success: true; data: unknown }
  | {
      type: "response";
      id: string;
      success: false;
      error: string;
      problem?: ProblemCode;
      // Permission-broker fields — previously sent untyped.
      permission_required?: boolean;
      missing?: { permissions?: string[]; origins?: string[] };
      suggestion?: string;
    }
  | { type: "connected"; extensionId: string }
  | { type: "pong"; id: string }
  | { type: "refresh_port" }
  | { type: "open_crawlio_app" };

export type WireMessage = ServerCommand | ExtensionResponse;
