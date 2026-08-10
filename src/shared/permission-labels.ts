// Chrome permission names, in words a person can act on.
//
// From docs/UX-permission-broker.md: "One line per permission. No technical names. No Chrome
// IDs." Both dedicated onboarding and the message the MCP server hands the AI read from here, so
// the user is told the same thing during initial review and later recovery.
//
// Deliberately free of any chrome.* type reference so the MCP server can import it too — the
// server is a Node process and has no extension typings.

export const PERMISSION_LABELS: Record<string, string> = {
  tabs: "See your open tabs",
  activeTab: "Interact with the current page",
  "http://127.0.0.1/*": "Connect locally",
  nativeMessaging: "Confirm your AI server is genuine",
  history: "Read browser history for diagnostics",
  downloads: "Inspect and manage browser downloads",
  contextMenus: "Add Crawlio actions to page menus",
  clipboardRead: "Read clipboard content",
  clipboardWrite: "Copy to clipboard",
  notifications: "Send notifications",
};

/** Human-readable lines for a set of permission names and origins, in request order. */
export function describePermissions(
  missing: { permissions?: string[]; origins?: string[] } | undefined,
): string[] {
  const out: string[] = [];
  for (const p of missing?.permissions ?? []) out.push(PERMISSION_LABELS[p] ?? p);
  for (const o of missing?.origins ?? []) out.push(PERMISSION_LABELS[o] ?? o);
  return out;
}
