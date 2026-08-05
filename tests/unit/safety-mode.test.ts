import { describe, it, expect } from "vitest";
import { isExplicitRawLane, envFlagEnabled } from "../../src/mcp-server/safety-mode";

/**
 * The raw-capture lane turns off redaction, truncation, and content-boundary wrapping. It is
 * selected by an environment variable, which makes it a public contract: the documented name
 * is CRAWLIO_RAW_LANE, and the earlier CRAWLIO_RE_LANE spelling stays honored so nobody's
 * existing config silently starts getting redacted output. These tests pin both.
 */
describe("raw-capture lane selection", () => {
  it("should enable via the documented flag", () => {
    expect(isExplicitRawLane({ CRAWLIO_RAW_LANE: "1" })).toBe(true);
  });

  it("should still enable via the earlier flag name", () => {
    expect(isExplicitRawLane({ CRAWLIO_RE_LANE: "1" })).toBe(true);
  });

  it("should accept the documented mode values on every mode variable", () => {
    for (const key of ["CRAWLIO_CONTEXT_MODE", "CRAWLIO_AGENT_MODE", "CRAWLIO_SAFETY_MODE", "CRAWLIO_LANE"]) {
      for (const value of ["raw", "traffic", "traffic-analysis", "traffic_analysis"]) {
        expect(isExplicitRawLane({ [key]: value }), `${key}=${value}`).toBe(true);
      }
    }
  });

  it("should still accept the earlier mode values", () => {
    for (const value of ["re", "reverse-engineering", "reverse_engineering"]) {
      expect(isExplicitRawLane({ CRAWLIO_LANE: value }), value).toBe(true);
    }
  });

  it("should be case- and whitespace-insensitive", () => {
    expect(isExplicitRawLane({ CRAWLIO_LANE: "  RAW  " })).toBe(true);
    expect(isExplicitRawLane({ CRAWLIO_RAW_LANE: "1" })).toBe(true);
  });

  it("should stay off by default and for unrelated values", () => {
    expect(isExplicitRawLane({})).toBe(false);
    expect(isExplicitRawLane({ CRAWLIO_LANE: "monitor" })).toBe(false);
    expect(isExplicitRawLane({ CRAWLIO_RAW_LANE: "0" })).toBe(false);
    expect(isExplicitRawLane({ CRAWLIO_RAW_LANE: "true" })).toBe(false); // only "1" arms the flag
  });
});

describe("envFlagEnabled", () => {
  it("should read the common truthy and falsy spellings", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) expect(envFlagEnabled({ K: v }, "K")).toBe(true);
    for (const v of ["0", "false", "no", "off"]) expect(envFlagEnabled({ K: v }, "K")).toBe(false);
  });

  it("should return null when unset or unrecognized, so callers can pick a default", () => {
    expect(envFlagEnabled({}, "K")).toBeNull();
    expect(envFlagEnabled({ K: "maybe" }, "K")).toBeNull();
  });
});
