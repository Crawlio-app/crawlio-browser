import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ACTIONABILITY_BACKOFF,
  checkActionability,
  pollActionability,
  parseSnapshotRef,
} from "@/mcp-server/tools";

// Mock bridge that returns sequential responses
function createMockBridge(responses: Array<{ data?: unknown; error?: string }>) {
  let callIndex = 0;
  return {
    send: vi.fn(async () => {
      const resp = responses[callIndex++];
      if (!resp) throw new Error("No more mock responses");
      if (resp.error) throw new Error(resp.error);
      return resp.data;
    }),
    isConnected: true,
  };
}

describe("ACTIONABILITY_BACKOFF", () => {
  it("matches the progressive backoff schedule", () => {
    expect(ACTIONABILITY_BACKOFF).toEqual([0, 20, 100, 100, 500]);
  });

  it("has 5 entries starting at 0 and ending at 500", () => {
    expect(ACTIONABILITY_BACKOFF).toHaveLength(5);
    expect(ACTIONABILITY_BACKOFF[0]).toBe(0);
    expect(ACTIONABILITY_BACKOFF[ACTIONABILITY_BACKOFF.length - 1]).toBe(500);
  });
});

describe("checkActionability", () => {
  it("returns actionable when element passes all checks", async () => {
    const bridge = createMockBridge([
      { data: { actionable: true } },
    ]);
    const result = await checkActionability(bridge as never, "#btn");
    expect(result).toEqual({ actionable: true });
    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "browser_evaluate" }),
      5000,
    );
  });

  it("returns not actionable with reason when element is hidden", async () => {
    const bridge = createMockBridge([
      { data: { actionable: false, reason: "Element is hidden (visibility)" } },
    ]);
    const result = await checkActionability(bridge as never, ".hidden");
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("Element is hidden (visibility)");
  });

  it("returns not actionable when element is disabled", async () => {
    const bridge = createMockBridge([
      { data: { actionable: false, reason: "Element is disabled" } },
    ]);
    const result = await checkActionability(bridge as never, "button");
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("Element is disabled");
  });

  it("returns not actionable when element not found", async () => {
    const bridge = createMockBridge([
      { data: { actionable: false, reason: "Element not found" } },
    ]);
    const result = await checkActionability(bridge as never, ".missing");
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("Element not found");
  });

  it("returns not actionable when pointer-events none", async () => {
    const bridge = createMockBridge([
      { data: { actionable: false, reason: "Element has pointer-events: none" } },
    ]);
    const result = await checkActionability(bridge as never, ".no-click");
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("Element has pointer-events: none");
  });

  it("returns not actionable when element is covered", async () => {
    const bridge = createMockBridge([
      { data: { actionable: false, reason: "Element is covered by another element" } },
    ]);
    const result = await checkActionability(bridge as never, ".covered");
    expect(result.actionable).toBe(false);
    expect(result.reason).toBe("Element is covered by another element");
  });

  it("includes selector in the evaluate expression", async () => {
    const bridge = createMockBridge([
      { data: { actionable: true } },
    ]);
    await checkActionability(bridge as never, '[data-test="submit"]');
    const call = bridge.send.mock.calls[0][0] as { expression: string };
    expect(call.expression).toContain('[data-test=\\"submit\\"]');
  });
});

describe("parseSnapshotRef", () => {
  it("extracts ref id from [ref=e3]", () => {
    expect(parseSnapshotRef("[ref=e3]")).toBe("e3");
  });

  it("extracts ref id from [ref=abc123]", () => {
    expect(parseSnapshotRef("[ref=abc123]")).toBe("abc123");
  });

  it("handles whitespace around the selector", () => {
    expect(parseSnapshotRef("  [ref=e3]  ")).toBe("e3");
  });

  it("returns null for CSS selectors", () => {
    expect(parseSnapshotRef("button.submit")).toBeNull();
    expect(parseSnapshotRef("#my-id")).toBeNull();
    expect(parseSnapshotRef("[data-test=foo]")).toBeNull();
    expect(parseSnapshotRef("div > span")).toBeNull();
  });

  it("returns null for partial ref-like selectors", () => {
    expect(parseSnapshotRef("[ref=e3] button")).toBeNull();
    expect(parseSnapshotRef("div [ref=e3]")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSnapshotRef("")).toBeNull();
  });
});

describe("pollActionability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("resolves immediately when element is actionable", async () => {
    const bridge = createMockBridge([
      { data: { actionable: true } },
    ]);
    // Use real timers for simple case
    vi.useRealTimers();
    await pollActionability(bridge as never, "#btn", 3000);
    expect(bridge.send).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on second attempt", async () => {
    const bridge = createMockBridge([
      { data: { actionable: false, reason: "Element not found" } },
      { data: { actionable: true } },
    ]);
    vi.useRealTimers();
    await pollActionability(bridge as never, "#btn", 5000);
    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it("throws with reason after timeout", async () => {
    // All attempts return not-actionable
    const bridge = {
      send: vi.fn(async () => ({ actionable: false, reason: "Element is hidden (display:none)" })),
      isConnected: true,
    };
    vi.useRealTimers();
    await expect(
      pollActionability(bridge as never, ".gone", 150),
    ).rejects.toThrow(/not actionable after 150ms.*Element is hidden/);
  });

  it("throws with bridge failure reason when bridge errors", async () => {
    const bridge = {
      send: vi.fn(async () => { throw new Error("WebSocket closed"); }),
      isConnected: true,
    };
    vi.useRealTimers();
    await expect(
      pollActionability(bridge as never, "#btn", 150),
    ).rejects.toThrow(/bridge communication failure/);
  });
});
