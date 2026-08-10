export type BrowserCapabilityStatus = "available" | "fallback" | "unavailable";

export interface BrowserCapability {
  name: string;
  status: BrowserCapabilityStatus;
  note?: string;
}

const TAB_PERMISSION_REQUIRED = new Set([
  "list_tabs",
  "get_user_tabs",
  "agent_session_claim_tab",
]);

const TAB_PERMISSION_PARTIAL: Record<string, string> = {
  connect_tab: "URL mode is available; discovering or adopting an existing tab requires the optional tabs permission.",
  agent_session_create: "Owned-tab mode is available; adopting an existing tab requires the optional tabs permission.",
};

/** Apply optional-permission truth to an otherwise state-derived browser capability. */
export function applyCapabilityPermissions(
  capability: BrowserCapability,
  grantedOptionalPermissions: ReadonlySet<string>,
): BrowserCapability {
  if (grantedOptionalPermissions.has("tabs")) return capability;

  if (TAB_PERMISSION_REQUIRED.has(capability.name)) {
    return {
      name: capability.name,
      status: "unavailable",
      note: "Requires the optional tabs permission. Complete onboarding to enable it.",
    };
  }

  const partialNote = TAB_PERMISSION_PARTIAL[capability.name];
  if (partialNote && capability.status !== "unavailable") {
    return { name: capability.name, status: "fallback", note: partialNote };
  }

  return capability;
}
