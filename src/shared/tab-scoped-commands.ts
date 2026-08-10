/**
 * Commands that act on a tab and therefore accept an optional `tabId`.
 *
 * Omitting `tabId` targets the connected tab — byte-for-byte the behaviour before targeting
 * existed. Supplying one targets any attached tab without moving the pin, which is what lets an
 * agent drive several tabs at once with the whole command surface on each.
 *
 * This list is the server's view of a fact that lives in the extension: a command belongs here
 * iff its handler resolves its tab through `resolveTargetTab()` or `requireDebuggerTab(command)`. The two are checked against each
 * other by tests/unit/tab-scoped-commands.test.ts, which parses background.ts — so adding a
 * handler without updating this list fails the suite rather than silently ignoring a caller's
 * `tabId`.
 *
 * Deliberately excluded: commands that take a *required* tabId naming a tab to operate on rather
 * than to act within (`close_tab`, `switch_tab`, `connect_tab`, `agent_session_claim_tab`), and
 * commands with no tab at all (`list_tabs`, `ping`, `get_capabilities`).
 */
export const TAB_SCOPED_COMMANDS = [
  "attach_to_target",
  "browser_click",
  "browser_double_click",
  "browser_drag",
  "browser_evaluate",
  "browser_file_upload",
  "browser_fill_form",
  "browser_hover",
  "browser_intercept",
  "browser_navigate",
  "browser_press_key",
  "browser_scroll",
  "browser_select_option",
  "browser_snapshot",
  "browser_type",
  "bypass_service_worker",
  "capture_page",
  "clear_database",
  "clear_serp_overlay",
  "clear_storage",
  "compare_raw_rendered",
  "create_browser_context",
  "delete_cookies",
  "detect_fonts",
  "detect_framework",
  "diff_snapshot",
  "emulate_device",
  "emulate_network",
  "export_session_raw",
  "force_gc",
  "force_pseudo_state",
  "get_accessibility_tree",
  "get_active_tab",
  "get_computed_style",
  "get_cookies",
  "get_databases",
  "get_dom_counters",
  "get_dom_snapshot",
  "get_frame_tree",
  "get_performance_metrics",
  "get_response_body",
  "get_security_state",
  "get_storage",
  "get_targets",
  "get_websocket_connections",
  "get_websocket_messages",
  "handle_dialog",
  "highlight_element",
  "ignore_certificate_errors",
  "inject_serp_overlay",
  "inspect_datalayer",
  "list_service_workers",
  "print_to_pdf",
  "query_object_store",
  "remove_attribute",
  "remove_node",
  "replay_request",
  "set_attribute",
  "set_cache_disabled",
  "set_cookie",
  "set_extra_headers",
  "set_geolocation",
  "set_outer_html",
  "set_storage",
  "set_user_agent",
  "set_viewport",
  "show_layout_shifts",
  "show_paint_rects",
  "start_css_coverage",
  "start_js_coverage",
  "start_network_capture",
  "start_recording",
  "stop_css_coverage",
  "stop_js_coverage",
  "stop_service_worker",
  "switch_to_frame",
  "switch_to_main_frame",
  "take_heap_snapshot",
  "take_screenshot",
  "wait_for_selector",
] as const;

export type TabScopedCommand = (typeof TAB_SCOPED_COMMANDS)[number];

const TAB_SCOPED_SET: ReadonlySet<string> = new Set(TAB_SCOPED_COMMANDS);

export function isTabScopedCommand(type: unknown): type is TabScopedCommand {
  return typeof type === "string" && TAB_SCOPED_SET.has(type);
}

/** Shared JSON-Schema fragment, so every tool describes `tabId` the same way. */
export const TAB_ID_SCHEMA = {
  type: "number",
  description:
    "Target tab id from list_tabs (default: the connected tab). Acts on that tab without changing which tab connect_tab points at, so several tabs can be driven in parallel.",
} as const;
