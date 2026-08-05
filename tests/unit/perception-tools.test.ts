import { describe, it, expect, vi } from "vitest";
import { createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";

function createMockBridge(response: unknown = {}) {
  return { send: vi.fn(async () => response), isConnected: true, push: vi.fn() };
}
function createMockCrawlio() {
  return { request: vi.fn() } as any;
}
describe("Phase 2 perception tools", () => {
  it("registers get_user_tabs with a timeout", () => {
    const registered = createTools(createMockBridge() as any, createMockCrawlio()).map(t => t.name);
    expect(registered).toContain("get_user_tabs");
    expect(TOOL_TIMEOUTS.get_user_tabs).toBeGreaterThan(0);
  });

  // get_user_history (history perm) and get_downloads (downloads perm) were removed
  // when those optional permissions were dropped from the manifest — the extension
  // never requests them, so the tools could only ever fail. Keep them de-registered
  // so code mode's allowlist (built from TOOL_TIMEOUTS keys) never advertises them.
  it("does NOT register get_user_history / get_downloads (their optional permissions were dropped)", () => {
    const registered = createTools(createMockBridge() as any, createMockCrawlio()).map(t => t.name);
    expect(registered).not.toContain("get_user_history");
    expect(registered).not.toContain("get_downloads");
    expect(TOOL_TIMEOUTS.get_user_history).toBeUndefined();
    expect(TOOL_TIMEOUTS.get_downloads).toBeUndefined();
  });

  it("get_user_tabs sends a bare command", async () => {
    const bridge = createMockBridge({ tabs: [], count: 0 });
    const t = createTools(bridge as any, createMockCrawlio()).find(x => x.name === "get_user_tabs")!;
    const result = await t.handler({}) as any;
    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith({ type: "get_user_tabs" }, TOOL_TIMEOUTS.get_user_tabs);
  });
});

describe("Phase 4 turn_id correlation", () => {
  it("agent_session_action forwards an optional turnId", async () => {
    const bridge = createMockBridge({ ok: true });
    const t = createTools(bridge as any, createMockCrawlio()).find(x => x.name === "agent_session_action")!;
    const result = await t.handler({ sessionId: "as_1", action: "click", selector: "#go", turnId: "turn_42" }) as any;
    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith(
      { type: "agent_session_action", sessionId: "as_1", action: "click", selector: "#go", turnId: "turn_42" },
      TOOL_TIMEOUTS.agent_session_action,
    );
  });
});
