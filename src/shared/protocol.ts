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
  | { type: "capture_page"; id: string; tabId?: number }
  | { type: "start_network_capture"; id: string; tabId?: number }
  | { type: "stop_network_capture"; id: string }
  | { type: "get_console_logs"; id: string }
  | { type: "get_dom_snapshot"; id: string; maxDepth?: number; tabId?: number }
  | { type: "detect_framework"; id: string; tabId?: number }
  | { type: "take_screenshot"; id: string; tabId?: number; fullPage?: boolean; selector?: string; format?: "png" | "jpeg"; quality?: number }
  | { type: "get_active_tab"; id: string; tabId?: number }
  | { type: "ping"; id: string }
  // Browser interaction commands
  | { type: "browser_navigate"; id: string; url: string; tabId?: number }
  | { type: "browser_click"; id: string; selector: string; tabId?: number }
  | { type: "browser_type"; id: string; selector: string; text: string; clearFirst?: boolean; tabId?: number }
  | { type: "browser_press_key"; id: string; key: string; tabId?: number }
  | { type: "browser_hover"; id: string; selector: string; tabId?: number }
  | { type: "browser_select_option"; id: string; selector: string; value: string; tabId?: number }
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
  // Runtime permission checks. Targets are exact for actionable denials; request_permissions is
  // retained for wire compatibility but only returns the dedicated onboarding route. Neither
  // command opens a Chrome prompt or stages popup UI.
  | { type: "check_permissions"; id: string; permissions?: string[]; origins?: string[] }
  | { type: "request_permissions"; id: string; permissions?: string[]; origins?: string[] }
  // Background agent-owned browser sessions
  | { type: "agent_session_create"; id: string; [key: string]: unknown }
  | { type: "agent_session_list"; id: string; [key: string]: unknown }
  | { type: "agent_session_status"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_close"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_snapshot"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_action"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_batch"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_artifacts"; id: string; sessionId: string; [key: string]: unknown }
  // Logical session tab-fleet management (no Chrome tabGroups permission)
  | { type: "agent_session_create_tab"; id: string; sessionId: string; [key: string]: unknown }
  | { type: "agent_session_claim_tab"; id: string; sessionId: string; tabId: number; [key: string]: unknown }
  | { type: "agent_session_name"; id: string; sessionId: string; name: string; [key: string]: unknown }
  | { type: "agent_session_finalize"; id: string; sessionId: string; [key: string]: unknown }
  // Cookie & storage commands
  | { type: "get_cookies"; id: string; tabId?: number }
  | { type: "set_cookie"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "delete_cookies"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "get_storage"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "set_storage"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "clear_storage"; id: string; tabId?: number; [key: string]: unknown }
  // Dialog commands
  | { type: "get_dialog"; id: string }
  | { type: "handle_dialog"; id: string; tabId?: number; [key: string]: unknown }
  // Response body
  | { type: "get_response_body"; id: string; tabId?: number; [key: string]: unknown }
  // Viewport & emulation
  | { type: "set_viewport"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "set_user_agent"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "emulate_device"; id: string; tabId?: number; [key: string]: unknown }
  // PDF
  | { type: "print_to_pdf"; id: string; tabId?: number; [key: string]: unknown }
  // Advanced input
  | { type: "browser_scroll"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "browser_double_click"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "browser_drag"; id: string; tabId?: number; [key: string]: unknown }
  // File upload
  | { type: "browser_file_upload"; id: string; tabId?: number; [key: string]: unknown }
  // Geolocation
  | { type: "set_geolocation"; id: string; tabId?: number; [key: string]: unknown }
  // Accessibility
  | { type: "get_accessibility_tree"; id: string; tabId?: number; [key: string]: unknown }
  // Performance
  | { type: "get_performance_metrics"; id: string; tabId?: number }
  // Stealth
  | { type: "set_stealth_mode"; id: string; [key: string]: unknown }
  // WebSocket monitoring
  | { type: "get_websocket_connections"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "get_websocket_messages"; id: string; tabId?: number; [key: string]: unknown }
  // Network conditions
  | { type: "emulate_network"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "set_cache_disabled"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "set_extra_headers"; id: string; tabId?: number; [key: string]: unknown }
  // Security
  | { type: "get_security_state"; id: string; tabId?: number }
  | { type: "ignore_certificate_errors"; id: string; tabId?: number; [key: string]: unknown }
  // Service workers
  | { type: "list_service_workers"; id: string; tabId?: number }
  | { type: "stop_service_worker"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "bypass_service_worker"; id: string; tabId?: number; [key: string]: unknown }
  // DOM mutation
  | { type: "set_outer_html"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "set_attribute"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "remove_attribute"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "remove_node"; id: string; tabId?: number; [key: string]: unknown }
  // CSS/JS coverage
  | { type: "start_css_coverage"; id: string; tabId?: number }
  | { type: "stop_css_coverage"; id: string; tabId?: number }
  | { type: "start_js_coverage"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "stop_js_coverage"; id: string; tabId?: number }
  // Computed style, pseudo state & font detection
  | { type: "get_computed_style"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "force_pseudo_state"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "detect_fonts"; id: string; tabId?: number; [key: string]: unknown }
  // IndexedDB
  | { type: "get_databases"; id: string; tabId?: number }
  | { type: "query_object_store"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "clear_database"; id: string; tabId?: number; [key: string]: unknown }
  // Targets
  | { type: "get_targets"; id: string; tabId?: number }
  | { type: "attach_to_target"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "create_browser_context"; id: string; tabId?: number; [key: string]: unknown }
  // Memory & heap
  | { type: "get_dom_counters"; id: string; tabId?: number }
  | { type: "force_gc"; id: string; tabId?: number }
  | { type: "take_heap_snapshot"; id: string; tabId?: number }
  // Overlay & visual debug
  | { type: "highlight_element"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "show_layout_shifts"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "show_paint_rects"; id: string; tabId?: number; [key: string]: unknown }
  // Selector wait
  | { type: "wait_for_selector"; id: string; tabId?: number; [key: string]: unknown }
  | { type: "browser_wait_for"; id: string; [key: string]: unknown }
  // Frame commands
  | { type: "get_frame_tree"; id: string; tabId?: number }
  | { type: "switch_to_frame"; id: string; frameId: string; tabId?: number }
  | { type: "switch_to_main_frame"; id: string; tabId?: number }
  // Tab management
  | { type: "create_tab"; id: string; [key: string]: unknown }
  | { type: "close_tab"; id: string; tabId: number }
  | { type: "switch_tab"; id: string; tabId: number }
  // Network intercept
  | { type: "browser_intercept"; id: string; tabId?: number; [key: string]: unknown }
  // Network replay
  | { type: "replay_request"; id: string; tabId?: number; [key: string]: unknown }
  // Crawlio server commands
  | { type: "extract_site"; id: string; [key: string]: unknown }
  | { type: "get_crawl_status"; id: string; [key: string]: unknown }
  | { type: "get_enrichment"; id: string; [key: string]: unknown }
  | { type: "get_crawled_urls"; id: string; [key: string]: unknown }
  | { type: "enrich_url"; id: string; [key: string]: unknown }
  // Code execution
  | { type: "execute_code"; id: string; [key: string]: unknown }
  // JS evaluation (MCP hardening — browser_evaluate via CDP Runtime.evaluate)
  | { type: "browser_evaluate"; id: string; expression: string; tabId?: number }
  // Batch form fill (via refs from browser_snapshot)
  | { type: "browser_fill_form"; id: string; fields: Array<{ ref: string; type?: string; value: string }>; tabId?: number }
  // Accessibility snapshot (via CDP Accessibility.getFullAXTree, with optional filtering)
  | { type: "browser_snapshot"; id: string; interactive?: boolean; compact?: boolean; maxDepth?: number; selector?: string; tabId?: number }
  // Session recording
  | { type: "start_recording"; id: string; maxDurationSec?: number; maxInteractions?: number; tabId?: number }
  | { type: "stop_recording"; id: string }
  | { type: "get_recording_status"; id: string }
  // Extension-resident observation. These commands keep collecting when the MCP bridge is down;
  // the server is a query/materialization client rather than the owner of the run.
  | { type: "robot_training_start"; id: string; [key: string]: unknown }
  | { type: "robot_training_status"; id: string; [key: string]: unknown }
  | { type: "robot_training_stop"; id: string; [key: string]: unknown }
  | { type: "robot_training_clear"; id: string; [key: string]: unknown }
  | { type: "recording_start"; id: string; [key: string]: unknown }
  | { type: "recording_status"; id: string; [key: string]: unknown }
  | { type: "recording_stop"; id: string; [key: string]: unknown }
  | { type: "recording_clear"; id: string; [key: string]: unknown }
  | { type: "monitor_page"; id: string; [key: string]: unknown }
  // Network idle detection
  | { type: "wait_for_network_idle"; id: string; timeout?: number; idleTime?: number }
  // Tracking pixel parser
  | { type: "parse_tracking_pixels"; id: string }
  // DataLayer inspection (CDP Runtime.evaluate — probes fbq, dataLayer, GTM, ttq state)
  | { type: "inspect_datalayer"; id: string; tabId?: number }
  // Snapshot diffing
  | { type: "diff_snapshot"; id: string; baseline?: string; tabId?: number }
  // CDP SERP overlay (Phase 3)
  | { type: "inject_serp_overlay"; id: string; widgets: string[]; query: string; data: Record<string, unknown>; tabId?: number }
  | { type: "clear_serp_overlay"; id: string; tabId?: number }
  // Raw vs Rendered comparison (Phase 5)
  | { type: "compare_raw_rendered"; id: string; tabId?: number }
  // SEO Intelligence settings (Phase 6)
  | { type: "set_seo_intelligence"; id: string; [key: string]: unknown }
  | { type: "get_seo_intelligence"; id: string }
  // Idle debugger release — detach after a quiet period so Chrome's "being debugged"
  // banner clears; the next command re-attaches. `idleMs: 0` disables it.
  | { type: "set_idle_release"; id: string; idleMs: number }
  | { type: "get_idle_release"; id: string }
  // Raw UNREDACTED cookie export, confined to the target tab's registrable site (see the
  // handler's SECURITY note). Registered as a tool since 1.4 but never declared here, so it
  // travelled untyped; declared now so `domain` is checked at the boundary like everything else.
  | { type: "export_session_raw"; id: string; domain?: string; tabId?: number };

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
  // profileId identifies the Chrome profile this extension instance runs in — extensionId cannot,
  // being identical across profiles. Optional: an older extension, or one whose storage was
  // unreadable at startup, simply connects unidentified and is never refused for it.
  | {
      type: "connected";
      extensionId: string;
      profileId?: string;
      handshakeAck?: boolean;
      workerGeneration?: { id: string; startedAt: number };
    }
  | { type: "pong"; id: string }
  | { type: "refresh_port" }
  | { type: "open_crawlio_app" };

export type WireMessage = ServerCommand | ExtensionResponse;
