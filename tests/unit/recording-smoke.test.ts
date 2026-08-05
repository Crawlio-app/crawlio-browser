import { describe, it, expect, vi } from "vitest";
import { createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";
// Mock bridge that returns realistic recording responses
function createRecordingBridge() {
  const calls: Array<{ cmd: any; timeout: number }> = [];
  return {
    calls,
    bridge: {
      send: vi.fn(async (cmd: any, timeout: number) => {
        calls.push({ cmd, timeout });
        switch (cmd.type) {
          case "start_recording":
            return {
              sessionId: "smoke-001",
              startedAt: "2026-03-02T00:00:00Z",
              tabId: 42,
              url: "https://example.com",
            };
          case "stop_recording":
            return {
              id: "smoke-001",
              startedAt: "2026-03-02T00:00:00Z",
              stoppedAt: "2026-03-02T00:01:00Z",
              duration: 60,
              pages: [
                {
                  url: "https://example.com",
                  enteredAt: "2026-03-02T00:00:00Z",
                  interactions: [
                    {
                      timestamp: "2026-03-02T00:00:10Z",
                      tool: "browser_click",
                      args: { selector: "#btn" },
                      result: { success: true, action: "click" },
                      durationMs: 50,
                      pageUrl: "https://example.com",
                    },
                    {
                      timestamp: "2026-03-02T00:00:15Z",
                      tool: "browser_type",
                      args: { selector: "input#email", text: "test@example.com" },
                      result: { success: true, action: "type" },
                      durationMs: 30,
                      pageUrl: "https://example.com",
                    },
                  ],
                  console: [{ level: "info", text: "loaded", timestamp: "2026-03-02T00:00:01Z" }],
                  network: [{ url: "https://example.com/api", method: "GET", status: 200, mimeType: "application/json", size: 1024, transferSize: 512, durationMs: 100, resourceType: "xhr" }],
                },
                {
                  url: "https://example.com/page2",
                  enteredAt: "2026-03-02T00:00:30Z",
                  interactions: [
                    {
                      timestamp: "2026-03-02T00:00:35Z",
                      tool: "browser_navigate",
                      args: { url: "https://example.com/page2" },
                      result: { success: true, action: "navigate", url: "https://example.com/page2" },
                      durationMs: 200,
                      pageUrl: "https://example.com/page2",
                    },
                  ],
                  console: [],
                  network: [],
                },
              ],
              metadata: {
                tabId: 42,
                initialUrl: "https://example.com",
                stopReason: "manual",
              },
            };
          case "get_recording_status":
            return {
              active: true,
              sessionId: "smoke-001",
              durationSec: 30,
              pageCount: 2,
              interactionCount: 3,
              currentPageUrl: "https://example.com/page2",
            };
          default:
            return {};
        }
      }),
      isConnected: true,
      push: vi.fn(),
    },
  };
}

describe("Recording Tools — Integration Smoke Test", () => {
  const { bridge, calls } = createRecordingBridge();
  const crawlio = { request: vi.fn() } as any;
  const tools = createTools(bridge as any, crawlio);

  const findTool = (name: string) => tools.find((t) => t.name === name)!;

  describe("full recording lifecycle", () => {
    it("start_recording sends correct command and returns session metadata", async () => {
      const tool = findTool("start_recording");
      const result = await tool.handler({ maxDurationSec: 120, maxInteractions: 50 });

      expect(result.isError).toBe(false);
      const data = JSON.parse(result.content[0].text);
      expect(data.sessionId).toBe("smoke-001");
      expect(data.tabId).toBe(42);
      expect(data.url).toBe("https://example.com");

      // Verify bridge was called with correct protocol message
      const call = calls[0];
      expect(call.cmd.type).toBe("start_recording");
      expect(call.cmd.maxDurationSec).toBe(120);
      expect(call.cmd.maxInteractions).toBe(50);
      expect(call.timeout).toBe(TOOL_TIMEOUTS.start_recording);
    });

    it("get_recording_status returns active session counters", async () => {
      const tool = findTool("get_recording_status");
      const result = await tool.handler({});

      expect(result.isError).toBe(false);
      const data = JSON.parse(result.content[0].text);
      expect(data.active).toBe(true);
      expect(data.sessionId).toBe("smoke-001");
      expect(data.durationSec).toBe(30);
      expect(data.pageCount).toBe(2);
      expect(data.interactionCount).toBe(3);
      expect(data.currentPageUrl).toBe("https://example.com/page2");
    });

    it("stop_recording returns full session with pages, interactions, network, console", async () => {
      const tool = findTool("stop_recording");
      const result = await tool.handler({});

      expect(result.isError).toBe(false);
      const session = JSON.parse(result.content[0].text);

      // Session shape
      expect(session.id).toBe("smoke-001");
      expect(session.duration).toBe(60);
      expect(session.metadata.stopReason).toBe("manual");
      expect(session.metadata.tabId).toBe(42);

      // Pages
      expect(session.pages).toHaveLength(2);

      // Page 1: interactions, console, network
      const page1 = session.pages[0];
      expect(page1.url).toBe("https://example.com");
      expect(page1.interactions).toHaveLength(2);
      expect(page1.interactions[0].tool).toBe("browser_click");
      expect(page1.interactions[0].args.selector).toBe("#btn");
      expect(page1.interactions[0].durationMs).toBe(50);
      expect(page1.interactions[1].tool).toBe("browser_type");
      expect(page1.interactions[1].args.text).toBe("test@example.com");
      expect(page1.console).toHaveLength(1);
      expect(page1.console[0].level).toBe("info");
      expect(page1.network).toHaveLength(1);
      expect(page1.network[0].url).toBe("https://example.com/api");

      // Page 2: navigation interaction
      const page2 = session.pages[1];
      expect(page2.url).toBe("https://example.com/page2");
      expect(page2.interactions).toHaveLength(1);
      expect(page2.interactions[0].tool).toBe("browser_navigate");
    });
  });

  describe("input validation", () => {
    it("accepts valid maxDurationSec range boundaries", async () => {
      const tool = findTool("start_recording");
      // Min boundary
      const r1 = await tool.handler({ maxDurationSec: 10 });
      expect(r1.isError).toBe(false);
      // Max boundary
      const r2 = await tool.handler({ maxDurationSec: 600 });
      expect(r2.isError).toBe(false);
    });

    it("accepts valid maxInteractions range boundaries", async () => {
      const tool = findTool("start_recording");
      const r1 = await tool.handler({ maxInteractions: 1 });
      expect(r1.isError).toBe(false);
      const r2 = await tool.handler({ maxInteractions: 500 });
      expect(r2.isError).toBe(false);
    });

    it("rejects maxDurationSec below 10", async () => {
      const tool = findTool("start_recording");
      await expect(tool.handler({ maxDurationSec: 9 })).rejects.toThrow();
      await expect(tool.handler({ maxDurationSec: 0 })).rejects.toThrow();
      await expect(tool.handler({ maxDurationSec: -1 })).rejects.toThrow();
    });

    it("rejects maxDurationSec above 600", async () => {
      const tool = findTool("start_recording");
      await expect(tool.handler({ maxDurationSec: 601 })).rejects.toThrow();
      await expect(tool.handler({ maxDurationSec: 1200 })).rejects.toThrow();
    });

    it("rejects maxInteractions below 1", async () => {
      const tool = findTool("start_recording");
      await expect(tool.handler({ maxInteractions: 0 })).rejects.toThrow();
      await expect(tool.handler({ maxInteractions: -1 })).rejects.toThrow();
    });

    it("rejects maxInteractions above 500", async () => {
      const tool = findTool("start_recording");
      await expect(tool.handler({ maxInteractions: 501 })).rejects.toThrow();
      await expect(tool.handler({ maxInteractions: 1000 })).rejects.toThrow();
    });

    it("accepts no params (defaults handled by extension)", async () => {
      const tool = findTool("start_recording");
      const callsBefore = calls.length;
      const result = await tool.handler({});
      expect(result.isError).toBe(false);
      const call = calls[callsBefore];
      expect(call.cmd.maxDurationSec).toBeUndefined();
      expect(call.cmd.maxInteractions).toBeUndefined();
    });
  });

  describe("protocol correctness", () => {
    it("stop_recording sends no extra fields", async () => {
      const callsBefore = calls.length;
      await findTool("stop_recording").handler({});
      const call = calls[callsBefore];
      expect(call.cmd.type).toBe("stop_recording");
      expect(Object.keys(call.cmd)).toEqual(["type"]);
      expect(call.timeout).toBe(TOOL_TIMEOUTS.stop_recording);
    });

    it("get_recording_status sends no extra fields", async () => {
      const callsBefore = calls.length;
      await findTool("get_recording_status").handler({});
      const call = calls[callsBefore];
      expect(call.cmd.type).toBe("get_recording_status");
      expect(Object.keys(call.cmd)).toEqual(["type"]);
      expect(call.timeout).toBe(TOOL_TIMEOUTS.get_recording_status);
    });
  });
});
