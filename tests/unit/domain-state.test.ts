import { describe, it, expect } from "vitest";
import { DOMAIN_ENABLE_PARAMS, mergeDomainState, type DomainEnableResult } from "../../src/extension/domain-state";

const ok = (domain: string) => ({ domain, success: true });
const fail = (domain: string, error = "boom") => ({ domain, success: false, error });

describe("mergeDomainState", () => {
  it("should return incoming unchanged when there is no existing record", () => {
    const incoming: DomainEnableResult = { required: [ok("Page.enable")], optional: [], allRequiredOk: true };
    expect(mergeDomainState(undefined, incoming)).toBe(incoming);
  });

  it("should keep domains the incoming record does not mention", () => {
    const capture: DomainEnableResult = {
      required: [ok("Page.enable"), ok("Network.enable"), ok("Runtime.enable"), ok("Log.enable")],
      optional: [ok("Security.enable"), ok("CSS.enable")],
      allRequiredOk: true,
    };
    const ensure: DomainEnableResult = {
      required: [ok("Page.enable"), ok("Runtime.enable")],
      optional: [ok("DOMStorage.enable"), ok("Performance.enable")],
      allRequiredOk: true,
    };
    const merged = mergeDomainState(capture, ensure);
    expect(merged.required.map(d => d.domain)).toEqual(
      ["Page.enable", "Network.enable", "Runtime.enable", "Log.enable"]
    );
    expect(merged.optional.map(d => d.domain)).toEqual(
      ["Security.enable", "CSS.enable", "DOMStorage.enable", "Performance.enable"]
    );
  });

  it("should let the newest status win per domain", () => {
    const existing: DomainEnableResult = { required: [fail("Network.enable")], optional: [], allRequiredOk: false };
    const incoming: DomainEnableResult = { required: [ok("Network.enable")], optional: [], allRequiredOk: true };
    const merged = mergeDomainState(existing, incoming);
    expect(merged.required).toEqual([ok("Network.enable")]);
  });

  it("should AND allRequiredOk so a recorded failure is not erased", () => {
    const existing: DomainEnableResult = { required: [ok("Page.enable")], optional: [], allRequiredOk: false };
    const incoming: DomainEnableResult = { required: [ok("Runtime.enable")], optional: [], allRequiredOk: true };
    expect(mergeDomainState(existing, incoming).allRequiredOk).toBe(false);
  });
});

describe("DOMAIN_ENABLE_PARAMS", () => {
  it("should carry the params the non-trivial enables require on replay", () => {
    expect(DOMAIN_ENABLE_PARAMS["Performance.enable"]).toEqual({ timeDomain: "timeTicks" });
    expect(DOMAIN_ENABLE_PARAMS["Page.setInterceptFileChooserDialog"]).toEqual({ enabled: true });
  });

  it("should only contain full CDP method names as keys", () => {
    for (const key of Object.keys(DOMAIN_ENABLE_PARAMS)) {
      expect(key).toMatch(/^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/);
    }
  });
});
