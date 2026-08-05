import { describe, it, expect, vi } from "vitest";
import {
  PERMISSION_EXEMPT_TOOLS,
  TOOL_TIMEOUTS,
  createTools,
} from "@/mcp-server/tools";

// --- Mock bridge factory ---

function createMockBridge(responses: Array<{ data?: unknown; error?: string }>) {
  let callIndex = 0;
  return {
    send: vi.fn(async (_cmd: unknown, _timeout?: number) => {
      const resp = responses[callIndex++];
      if (!resp) throw new Error("No more mock responses");
      if (resp.error) throw new Error(resp.error);
      return resp.data;
    }),
    isConnected: true,
    push: vi.fn(),
  };
}

function createMockCrawlio() {
  return { request: vi.fn() } as any;
}

// ============================================================
// Recording Tools
// ============================================================

describe("Recording Tools", () => {
  describe("tool registration", () => {
    it("registers start_recording, stop_recording, get_recording_status tools", () => {
      const bridge = createMockBridge([]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const names = tools.map(t => t.name);
      expect(names).toContain("start_recording");
      expect(names).toContain("stop_recording");
      expect(names).toContain("get_recording_status");
    });

    it("has timeouts for all 3 recording tools", () => {
      expect(TOOL_TIMEOUTS.start_recording).toBe(10000);
      expect(TOOL_TIMEOUTS.stop_recording).toBe(10000);
      expect(TOOL_TIMEOUTS.get_recording_status).toBe(5000);
    });

    it("exempts get_recording_status from permission checks", () => {
      expect(PERMISSION_EXEMPT_TOOLS.has("get_recording_status")).toBe(true);
    });

    it("does not exempt start_recording or stop_recording from permission checks", () => {
      expect(PERMISSION_EXEMPT_TOOLS.has("start_recording")).toBe(false);
      expect(PERMISSION_EXEMPT_TOOLS.has("stop_recording")).toBe(false);
    });
  });

  describe("start_recording tool", () => {
    it("sends start_recording command via bridge and returns result", async () => {
      const bridge = createMockBridge([
        { data: { sessionId: "abc-123", startedAt: "2026-03-02T00:00:00Z", tabId: 1, url: "https://example.com" } },
      ]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "start_recording")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.sessionId).toBe("abc-123");
      expect(parsed.tabId).toBe(1);
      expect(bridge.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "start_recording" }),
        10000,
      );
    });

    it("passes maxDurationSec and maxInteractions to bridge", async () => {
      const bridge = createMockBridge([
        { data: { sessionId: "def-456" } },
      ]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "start_recording")!;
      await tool.handler({ maxDurationSec: 120, maxInteractions: 50 });
      expect(bridge.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "start_recording",
          maxDurationSec: 120,
          maxInteractions: 50,
        }),
        10000,
      );
    });

    it("rejects invalid maxDurationSec below 10", async () => {
      const bridge = createMockBridge([]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "start_recording")!;
      await expect(tool.handler({ maxDurationSec: 5 })).rejects.toThrow();
    });

    it("rejects invalid maxDurationSec above 600", async () => {
      const bridge = createMockBridge([]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "start_recording")!;
      await expect(tool.handler({ maxDurationSec: 1200 })).rejects.toThrow();
    });
  });

  describe("stop_recording tool", () => {
    it("sends stop_recording command and returns session data", async () => {
      const session = {
        id: "abc-123",
        startedAt: "2026-03-02T00:00:00Z",
        stoppedAt: "2026-03-02T00:05:00Z",
        duration: 300,
        pages: [{ url: "https://example.com", interactions: [] }],
        metadata: { tabId: 1, initialUrl: "https://example.com", stopReason: "manual" },
      };
      const bridge = createMockBridge([{ data: session }]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "stop_recording")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("abc-123");
      expect(parsed.pages).toHaveLength(1);
      expect(parsed.metadata.stopReason).toBe("manual");
    });
  });

  describe("get_recording_status tool", () => {
    it("returns idle status when no recording active", async () => {
      const bridge = createMockBridge([
        { data: { active: false } },
      ]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "get_recording_status")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.active).toBe(false);
    });

    it("returns active status with counters when recording", async () => {
      const bridge = createMockBridge([
        { data: {
          active: true,
          sessionId: "abc-123",
          durationSec: 42,
          pageCount: 2,
          interactionCount: 5,
          currentPageUrl: "https://example.com/page2",
        }},
      ]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const tool = tools.find(t => t.name === "get_recording_status")!;
      const result = await tool.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.active).toBe(true);
      expect(parsed.sessionId).toBe("abc-123");
      expect(parsed.pageCount).toBe(2);
      expect(parsed.interactionCount).toBe(5);
    });
  });
});
