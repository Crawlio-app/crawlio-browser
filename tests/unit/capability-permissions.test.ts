import { describe, expect, it } from "vitest";
import { applyCapabilityPermissions } from "../../src/extension/capability-permissions.js";

describe("permission-aware browser capabilities", () => {
  const noOptionalPermissions = new Set<string>();

  it.each(["list_tabs", "get_user_tabs", "agent_session_claim_tab"])(
    "marks %s unavailable without tabs",
    (name) => {
      expect(applyCapabilityPermissions({ name, status: "available" }, noOptionalPermissions)).toEqual({
        name,
        status: "unavailable",
        note: "Requires the optional tabs permission. Complete onboarding to enable it.",
      });
    },
  );

  it.each(["connect_tab", "agent_session_create"])(
    "reports the owned-tab fallback for %s without tabs",
    (name) => {
      const result = applyCapabilityPermissions({ name, status: "available" }, noOptionalPermissions);
      expect(result.status).toBe("fallback");
      expect(result.note).toContain("existing tab");
    },
  );

  it("preserves unrelated and already-unavailable capabilities", () => {
    expect(applyCapabilityPermissions(
      { name: "capture_page", status: "available" },
      noOptionalPermissions,
    )).toEqual({ name: "capture_page", status: "available" });
    expect(applyCapabilityPermissions(
      { name: "connect_tab", status: "unavailable", note: "Offline" },
      noOptionalPermissions,
    )).toEqual({ name: "connect_tab", status: "unavailable", note: "Offline" });
  });

  it("preserves base statuses when tabs is granted", () => {
    const base = { name: "list_tabs", status: "available" as const, note: "base" };
    expect(applyCapabilityPermissions(base, new Set(["tabs"]))).toEqual(base);
  });
});
