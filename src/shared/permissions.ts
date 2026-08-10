// The optional permissions Crawlio acquires at runtime.
//
// None of these are in the install manifest's required set — that is deliberate and is the
// whole CWS strategy: the install prompt shows only `alarms`, `debugger` and `storage`, and
// everything else is granted later during explicit onboarding, with Chrome showing its own
// prompt. Runtime tools may check and explain missing capabilities, but they never prompt from
// the popup/widget. Keep acquisition centralized so future optional grants cannot create a second
// surprise prompt surface.
//
// This lives in shared/ because onboarding, status surfaces, and the feature broker must derive
// their checks from one declared surface instead of carrying lists that silently drift.

/** Required install-time permissions declared by the build that is actually running. */
export function declaredRequiredPermissions(): string[] {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    permissions?: string[];
  };
  return [...(manifest.permissions ?? [])];
}

/** Union of the optional surface declared in manifest.prod.json; requested once in onboarding. */
export const CORE_OPTIONAL_PERMISSIONS: chrome.permissions.Permissions = {
  // `tabs` — read tab metadata for list_tabs / connect_tab.
  //
  // `nativeMessaging` — activates the rogue-server defense. It lets the extension receive the
  // real bridge token over Chrome's authenticated native channel (connectNative →
  // set_crawlio_token). Without it the extension is permanently trust-on-first-use and a rogue
  // local server can win the bridge election and drive CDP.
  permissions: ["tabs", "nativeMessaging"],
  // Only for the /health probe to a local MCP server. Never a wildcard host.
  origins: ["http://127.0.0.1/*"],
};

/**
 * Optional capabilities declared by the build that is actually running.
 *
 * Production is pinned to CORE_OPTIONAL_PERMISSIONS by a manifest parity test. Development may
 * declare additional diagnostic permissions; deriving from its manifest makes the same onboarding
 * page request all of them without introducing a second hardcoded list.
 */
export function declaredOptionalPermissions(): chrome.permissions.Permissions {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    optional_permissions?: string[];
    optional_host_permissions?: string[];
  };
  return {
    permissions: [...(manifest.optional_permissions ?? [])],
    origins: [...(manifest.optional_host_permissions ?? [])],
  };
}

/**
 * The subset of `target` that is not currently granted.
 *
 * Each entry is probed on its own because `chrome.permissions.contains()` is all-or-nothing:
 * asking about the whole set only says "some of this is missing", never which part. Callers use
 * the result to request exactly the gap, so a denial cannot revoke something already held.
 */
export async function missingPermissions(
  target: chrome.permissions.Permissions = CORE_OPTIONAL_PERMISSIONS,
): Promise<chrome.permissions.Permissions> {
  const has = (query: chrome.permissions.Permissions) =>
    new Promise<boolean>((resolve) => chrome.permissions.contains(query, (ok) => resolve(ok === true)));

  const permissions: string[] = [];
  for (const p of target.permissions ?? []) {
    if (!(await has({ permissions: [p] }))) permissions.push(p);
  }
  const origins: string[] = [];
  for (const o of target.origins ?? []) {
    if (!(await has({ origins: [o] }))) origins.push(o);
  }
  return { permissions, origins };
}

/** True when nothing in `target` is outstanding. */
export function isComplete(missing: chrome.permissions.Permissions): boolean {
  return !missing.permissions?.length && !missing.origins?.length;
}
