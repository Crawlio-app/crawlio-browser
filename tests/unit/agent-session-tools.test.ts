import { describe, it, expect, vi } from "vitest";
import { createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";

function createMockBridge(response: unknown = {}) {
  return {
    send: vi.fn(async () => response),
    isConnected: true,
    push: vi.fn(),
  };
}

function createMockCrawlio() {
  return { request: vi.fn() } as any;
}

describe("agent session MCP tools", () => {
  const names = [
    "agent_session_create",
    "agent_session_list",
    "agent_session_status",
    "agent_session_close",
    "agent_session_snapshot",
    "agent_session_action",
    "agent_session_batch",
    "agent_session_artifacts",
    "agent_session_create_tab",
    "agent_session_claim_tab",
    "agent_session_name",
    "agent_session_finalize",
  ];

  it("registers the background agent session tool surface", () => {
    const tools = createTools(createMockBridge() as any, createMockCrawlio());
    const registered = tools.map(t => t.name);
    for (const name of names) {
      expect(registered).toContain(name);
      expect(TOOL_TIMEOUTS[name]).toBeGreaterThan(0);
    }
  });

  it("creates a background session without requesting foreground activation by default", async () => {
    const bridge = createMockBridge({ id: "as_test", tabId: 42, background: true });
    const tool = createTools(bridge as any, createMockCrawlio()).find(t => t.name === "agent_session_create")!;

    const result = await tool.handler({ url: "https://example.com", name: "example" }) as any;

    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith(
      {
        type: "agent_session_create",
        url: "https://example.com",
        name: "example",
        active: false,
        background: true,
      },
      TOOL_TIMEOUTS.agent_session_create,
    );
  });

  it("routes semantic actions to the selected session", async () => {
    const bridge = createMockBridge({ ok: true });
    const tool = createTools(bridge as any, createMockCrawlio()).find(t => t.name === "agent_session_action")!;

    const result = await tool.handler({
      sessionId: "as_test",
      action: "insertText",
      selector: "#email",
      text: "agent@example.com",
      clearFirst: true,
    }) as any;

    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith(
      {
        type: "agent_session_action",
        sessionId: "as_test",
        action: "insertText",
        selector: "#email",
        text: "agent@example.com",
        clearFirst: true,
      },
      TOOL_TIMEOUTS.agent_session_action,
    );
  });

  it("validates batch actions before sending to the bridge", async () => {
    const bridge = createMockBridge({ ok: true });
    const tool = createTools(bridge as any, createMockCrawlio()).find(t => t.name === "agent_session_batch")!;

    await expect(tool.handler({ sessionId: "as_test", actions: [{ action: "not-a-real-action" }] }))
      .rejects
      .toThrow();
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it("accepts move_mouse with coordinates and forwards x/y to the bridge", async () => {
    const bridge = createMockBridge({ ok: true });
    const tool = createTools(bridge as any, createMockCrawlio()).find(t => t.name === "agent_session_action")!;

    const result = await tool.handler({ sessionId: "as_test", action: "move_mouse", x: 120, y: 240 }) as any;

    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith(
      { type: "agent_session_action", sessionId: "as_test", action: "move_mouse", x: 120, y: 240 },
      TOOL_TIMEOUTS.agent_session_action,
    );
  });
});
