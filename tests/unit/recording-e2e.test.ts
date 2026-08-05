import { describe, it, expect, vi } from "vitest";
import {
  createTools,
  createCodeModeTools,
  TOOL_TIMEOUTS,
  PERMISSION_EXEMPT_TOOLS,
} from "@/mcp-server/tools";
import type { ServerCommand } from "@/shared/protocol";
import type {
  RecordingSession,
  RecordingPage,
  RecordingInteraction,
  RecordingStatus,
} from "@/shared/types";

// --- Helpers ---

function createMockBridge(handler?: (cmd: any) => any) {
  return {
    send: vi.fn(async (cmd: any, _timeout?: number) => {
      if (handler) return handler(cmd);
      return {};
    }),
    isConnected: true,
    push: vi.fn(),
  };
}

function createMockCrawlio() {
  return { request: vi.fn() } as any;
}

function findTool(tools: any[], name: string) {
  const t = tools.find((t: any) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

// Realistic session data for stop_recording responses
function makeSession(overrides?: Partial<RecordingSession>): RecordingSession {
  return {
    id: "e2e-sess-001",
    startedAt: "2026-03-02T12:00:00.000Z",
    stoppedAt: "2026-03-02T12:05:00.000Z",
    duration: 300,
    pages: [
      {
        url: "https://example.com",
        title: "Example",
        enteredAt: "2026-03-02T12:00:00.000Z",
        console: [{ level: "info", text: "loaded", timestamp: "2026-03-02T12:00:01.000Z" }],
        network: [{ url: "https://example.com/api", method: "GET", status: 200, mimeType: "application/json", size: 512, transferSize: 256, durationMs: 80, resourceType: "xhr" }],
        interactions: [
          {
            timestamp: "2026-03-02T12:00:10.000Z",
            tool: "browser_click",
            args: { selector: "#submit" },
            result: { success: true, action: "click" },
            durationMs: 45,
            pageUrl: "https://example.com",
          },
        ],
      },
    ],
    metadata: {
      tabId: 1,
      initialUrl: "https://example.com",
      stopReason: "manual",
    },
    ...overrides,
  };
}

// ============================================================
// 1. Discoverability — search catalog includes recording tools
// ============================================================

describe("1. Discoverability", () => {
  const bridge = createMockBridge();
  const crawlio = createMockCrawlio();
  const codeModeTools = createCodeModeTools(bridge as any, crawlio);
  const searchTool = findTool(codeModeTools, "search");

  it('search("recording") returns all 3 recording commands', async () => {
    const result = await searchTool.handler({ query: "recording" });
    const entries = JSON.parse(result.content[0].text);
    const names = entries.map((e: any) => e.name);
    expect(names).toContain("start_recording");
    expect(names).toContain("stop_recording");
    expect(names).toContain("get_recording_status");
  });

  it('search("session") returns recording-related results', async () => {
    const result = await searchTool.handler({ query: "session" });
    const entries = JSON.parse(result.content[0].text);
    const names = entries.map((e: any) => e.name);
    // "session" appears in recording tool descriptions
    expect(names.some((n: string) => n.includes("recording"))).toBe(true);
  });
});

// ============================================================
// 2. Protocol contract — ServerCommand types
// ============================================================

describe("2. Protocol contract", () => {
  it("start_recording is a valid ServerCommand variant with optional params", () => {
    const cmd: ServerCommand = {
      type: "start_recording",
      id: "test-1",
      maxDurationSec: 120,
      maxInteractions: 50,
    };
    expect(cmd.type).toBe("start_recording");
    // Verify optional params compile
    const cmdMinimal: ServerCommand = { type: "start_recording", id: "test-2" };
    expect(cmdMinimal.type).toBe("start_recording");
  });

  it("stop_recording is a valid ServerCommand variant", () => {
    const cmd: ServerCommand = { type: "stop_recording", id: "test-3" };
    expect(cmd.type).toBe("stop_recording");
  });

  it("get_recording_status is a valid ServerCommand variant", () => {
    const cmd: ServerCommand = { type: "get_recording_status", id: "test-4" };
    expect(cmd.type).toBe("get_recording_status");
  });
});

// ============================================================
// 3. Type contract — types.ts shapes
// ============================================================

describe("3. Type contract", () => {
  it("RecordingSession has all required fields", () => {
    const session: RecordingSession = makeSession();
    expect(session.id).toBeDefined();
    expect(session.startedAt).toBeDefined();
    expect(session.duration).toBeDefined();
    expect(session.pages).toBeDefined();
    expect(session.metadata).toBeDefined();
    expect(session.metadata.stopReason).toBeDefined();
    // stoppedAt is optional
    expect(session.stoppedAt).toBeDefined();
  });

  it("RecordingPage has url, enteredAt, console[], network[], interactions[]", () => {
    const page: RecordingPage = {
      url: "https://example.com",
      enteredAt: "2026-03-02T12:00:00Z",
      console: [],
      network: [],
      interactions: [],
    };
    expect(page.url).toBe("https://example.com");
    expect(Array.isArray(page.console)).toBe(true);
    expect(Array.isArray(page.network)).toBe(true);
    expect(Array.isArray(page.interactions)).toBe(true);
    // title is optional
    expect(page.title).toBeUndefined();
  });

  it("RecordingInteraction has timestamp, tool, args, durationMs, pageUrl", () => {
    const interaction: RecordingInteraction = {
      timestamp: "2026-03-02T12:00:10Z",
      tool: "browser_click",
      args: { selector: "#btn" },
      durationMs: 42,
      pageUrl: "https://example.com",
    };
    expect(interaction.tool).toBe("browser_click");
    expect(interaction.durationMs).toBe(42);
    // result is optional
    expect(interaction.result).toBeUndefined();
  });

  it("RecordingStatus has active field and optional counters", () => {
    const idle: RecordingStatus = { active: false };
    expect(idle.active).toBe(false);
    expect(idle.sessionId).toBeUndefined();

    const active: RecordingStatus = {
      active: true,
      sessionId: "s1",
      durationSec: 60,
      pageCount: 2,
      interactionCount: 5,
      currentPageUrl: "https://example.com",
    };
    expect(active.pageCount).toBe(2);
  });

  it("metadata.stopReason accepts all 5 union values", () => {
    const reasons: RecordingSession["metadata"]["stopReason"][] = [
      "manual",
      "max_duration",
      "max_interactions",
      "tab_closed",
      "tab_disconnected",
    ];
    for (const reason of reasons) {
      const s = makeSession({ metadata: { tabId: 1, initialUrl: "x", stopReason: reason } });
      expect(s.metadata.stopReason).toBe(reason);
    }
  });
});

// ============================================================
// 4. Zod validation boundaries
// ============================================================

describe("4. Zod validation boundaries", () => {
  function freshStartTool() {
    const bridge = createMockBridge(() => ({ sessionId: "zod-test" }));
    const tools = createTools(bridge as any, createMockCrawlio());
    return findTool(tools, "start_recording");
  }

  describe("maxDurationSec", () => {
    it.each([10, 300, 600])("accepts %d", async (val) => {
      const tool = freshStartTool();
      const r = await tool.handler({ maxDurationSec: val });
      expect(r.isError).toBe(false);
    });

    it.each([9, 0, -1])("rejects %d (below min)", async (val) => {
      const tool = freshStartTool();
      await expect(tool.handler({ maxDurationSec: val })).rejects.toThrow();
    });

    it("rejects 601 (above max)", async () => {
      const tool = freshStartTool();
      await expect(tool.handler({ maxDurationSec: 601 })).rejects.toThrow();
    });
  });

  describe("maxInteractions", () => {
    it.each([1, 250, 500])("accepts %d", async (val) => {
      const tool = freshStartTool();
      const r = await tool.handler({ maxInteractions: val });
      expect(r.isError).toBe(false);
    });

    it.each([0, -1])("rejects %d (below min)", async (val) => {
      const tool = freshStartTool();
      await expect(tool.handler({ maxInteractions: val })).rejects.toThrow();
    });

    it("rejects 501 (above max)", async () => {
      const tool = freshStartTool();
      await expect(tool.handler({ maxInteractions: 501 })).rejects.toThrow();
    });
  });

  it("accepts empty object (both optional)", async () => {
    const tool = freshStartTool();
    const r = await tool.handler({});
    expect(r.isError).toBe(false);
  });
});

// ============================================================
// 5. Extension state machine contract
// ============================================================

describe("5. Extension state machine contract", () => {
  // We test the contract expectations that the extension must fulfill.
  // These tests verify the MCP tool layer correctly propagates extension responses.

  it("start_recording with no tab returns isError with message", async () => {
    const bridge = createMockBridge(() => {
      throw new Error("No tab connected. Use connect_tab first.");
    });
    const tools = createTools(bridge as any, createMockCrawlio());
    const tool = findTool(tools, "start_recording");
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No tab connected");
  });

  it("start_recording twice returns isError", async () => {
    let callCount = 0;
    const bridge = createMockBridge(() => {
      callCount++;
      if (callCount === 1) return { sessionId: "s1" };
      throw new Error("Recording already active");
    });
    const tools = createTools(bridge as any, createMockCrawlio());
    const tool = findTool(tools, "start_recording");
    await tool.handler({});
    const r2 = await tool.handler({});
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain("Recording already active");
  });

  it("stop_recording with no active recording returns isError", async () => {
    const bridge = createMockBridge(() => {
      throw new Error("No active recording to stop.");
    });
    const tools = createTools(bridge as any, createMockCrawlio());
    const tool = findTool(tools, "stop_recording");
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No active recording");
  });

  it("stop_recording after auto-stop returns cached session", async () => {
    const autoStoppedSession = makeSession({ metadata: { tabId: 1, initialUrl: "x", stopReason: "max_duration" } });
    const bridge = createMockBridge((cmd) => {
      if (cmd.type === "stop_recording") return autoStoppedSession;
      return {};
    });
    const tools = createTools(bridge as any, createMockCrawlio());
    const tool = findTool(tools, "stop_recording");
    const result = await tool.handler({});
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.metadata.stopReason).toBe("max_duration");
  });

  it("get_recording_status with no recording returns { active: false }", async () => {
    const bridge = createMockBridge(() => ({ active: false }));
    const tools = createTools(bridge as any, createMockCrawlio());
    const tool = findTool(tools, "get_recording_status");
    const result = await tool.handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data.active).toBe(false);
  });

  it("full lifecycle: start → status → stop → verify session shape", async () => {
    let phase = 0;
    const bridge = createMockBridge((cmd) => {
      switch (cmd.type) {
        case "start_recording":
          phase = 1;
          return { sessionId: "lc-001", startedAt: "2026-03-02T12:00:00Z", tabId: 42, url: "https://example.com" };
        case "get_recording_status":
          return { active: true, sessionId: "lc-001", durationSec: 15, pageCount: 1, interactionCount: 2, currentPageUrl: "https://example.com" };
        case "stop_recording":
          phase = 2;
          return makeSession();
        default:
          return {};
      }
    });
    const tools = createTools(bridge as any, createMockCrawlio());

    // Start
    const startResult = await findTool(tools, "start_recording").handler({ maxDurationSec: 120 });
    expect(startResult.isError).toBe(false);
    expect(phase).toBe(1);

    // Status
    const statusResult = await findTool(tools, "get_recording_status").handler({});
    const status = JSON.parse(statusResult.content[0].text);
    expect(status.active).toBe(true);
    expect(status.sessionId).toBe("lc-001");

    // Stop
    const stopResult = await findTool(tools, "stop_recording").handler({});
    expect(stopResult.isError).toBe(false);
    expect(phase).toBe(2);
    const session = JSON.parse(stopResult.content[0].text);
    expect(session.id).toBeDefined();
    expect(session.pages.length).toBeGreaterThan(0);
    expect(session.metadata.stopReason).toBe("manual");
  });
});

// ============================================================
// 6. Interaction interception — RECORDING_INTERACTION_TOOLS set
// ============================================================

describe("6. Interaction interception", () => {
  // The RECORDING_INTERACTION_TOOLS set is defined in background.ts (IIFE, not importable).
  // We verify the expected set by checking that all 12 interaction tools exist in the tool registry
  // and that non-interaction tools are distinct.

  const EXPECTED_INTERACTION_TOOLS = new Set([
    "browser_navigate", "browser_click", "browser_type", "browser_press_key",
    "browser_hover", "browser_select_option", "browser_scroll",
    "browser_double_click", "browser_drag", "browser_fill_form",
    "browser_evaluate", "browser_file_upload",
  ]);

  const NON_INTERACTION_TOOLS = [
    "capture_page", "get_cookies", "take_screenshot",
    "get_dom_snapshot", "get_console_logs", "detect_framework",
  ];

  const bridge = createMockBridge();
  const tools = createTools(bridge as any, createMockCrawlio());
  const toolNames = new Set(tools.map(t => t.name));

  it("all 12 expected interaction tools are registered", () => {
    for (const name of EXPECTED_INTERACTION_TOOLS) {
      expect(toolNames.has(name)).toBe(true);
    }
  });

  it("exactly 12 interaction tools", () => {
    expect(EXPECTED_INTERACTION_TOOLS.size).toBe(12);
  });

  it("non-interaction tools are NOT in the interaction set", () => {
    for (const name of NON_INTERACTION_TOOLS) {
      expect(EXPECTED_INTERACTION_TOOLS.has(name)).toBe(false);
    }
  });
});

// ============================================================
// 7. Permission exemption
// ============================================================

describe("7. Permission exemption", () => {
  it("get_recording_status IS permission-exempt", () => {
    expect(PERMISSION_EXEMPT_TOOLS.has("get_recording_status")).toBe(true);
  });

  it("start_recording is NOT permission-exempt", () => {
    expect(PERMISSION_EXEMPT_TOOLS.has("start_recording")).toBe(false);
  });

  it("stop_recording is NOT permission-exempt", () => {
    expect(PERMISSION_EXEMPT_TOOLS.has("stop_recording")).toBe(false);
  });
});

// ============================================================
// 8. Timeout configuration
// ============================================================

describe("8. Timeout configuration", () => {
  it("start_recording timeout is 10000ms", () => {
    expect(TOOL_TIMEOUTS.start_recording).toBe(10000);
  });

  it("stop_recording timeout is 10000ms", () => {
    expect(TOOL_TIMEOUTS.stop_recording).toBe(10000);
  });

  it("get_recording_status timeout is 5000ms", () => {
    expect(TOOL_TIMEOUTS.get_recording_status).toBe(5000);
  });

  it("timeouts are passed to bridge.send", async () => {
    const sendCalls: Array<{ cmd: any; timeout: number }> = [];
    const bridge = {
      send: vi.fn(async (cmd: any, timeout: number) => {
        sendCalls.push({ cmd, timeout });
        return { active: false };
      }),
      isConnected: true,
      push: vi.fn(),
    };
    const tools = createTools(bridge as any, createMockCrawlio());

    await findTool(tools, "start_recording").handler({});
    await findTool(tools, "stop_recording").handler({});
    await findTool(tools, "get_recording_status").handler({});

    expect(sendCalls[0].timeout).toBe(10000);
    expect(sendCalls[1].timeout).toBe(10000);
    expect(sendCalls[2].timeout).toBe(5000);
  });
});

// ============================================================
// 9. Error propagation
// ============================================================

describe("9. Error propagation", () => {
  it("bridge throw returns isError with original message preserved", async () => {
    const bridge = createMockBridge(() => {
      throw new Error("WebSocket disconnected");
    });
    const tools = createTools(bridge as any, createMockCrawlio());

    for (const name of ["start_recording", "stop_recording", "get_recording_status"]) {
      const result = await findTool(tools, name).handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("WebSocket disconnected");
    }
  });

  it("bridge error message is not swallowed", async () => {
    const bridge = createMockBridge(() => {
      throw new Error("CDP timeout");
    });
    const tools = createTools(bridge as any, createMockCrawlio());
    const result = await findTool(tools, "start_recording").handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CDP timeout");
  });
});

// ============================================================
// 10. Session data integrity
// ============================================================

describe("10. Session data integrity", () => {
  const session = makeSession();
  const bridge = createMockBridge(() => session);
  const tools = createTools(bridge as any, createMockCrawlio());

  it("stop_recording response is valid JSON and parseable", async () => {
    const result = await findTool(tools, "stop_recording").handler({});
    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("session has UUID-like id", async () => {
    const result = await findTool(tools, "stop_recording").handler({});
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.id).toBe("string");
    expect(data.id.length).toBeGreaterThan(0);
  });

  it("startedAt and stoppedAt are ISO 8601 strings", async () => {
    const result = await findTool(tools, "stop_recording").handler({});
    const data = JSON.parse(result.content[0].text);
    expect(new Date(data.startedAt).toISOString()).toBe(data.startedAt);
    expect(new Date(data.stoppedAt).toISOString()).toBe(data.stoppedAt);
  });

  it("duration is a positive number", async () => {
    const result = await findTool(tools, "stop_recording").handler({});
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.duration).toBe("number");
    expect(data.duration).toBeGreaterThan(0);
  });

  it("pages is a non-empty array with required fields", async () => {
    const result = await findTool(tools, "stop_recording").handler({});
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.pages)).toBe(true);
    expect(data.pages.length).toBeGreaterThan(0);

    for (const page of data.pages) {
      expect(typeof page.url).toBe("string");
      expect(Array.isArray(page.interactions)).toBe(true);
      expect(Array.isArray(page.console)).toBe(true);
      expect(Array.isArray(page.network)).toBe(true);
    }
  });

  it("metadata.stopReason is a valid union value", async () => {
    const validReasons = new Set(["manual", "max_duration", "max_interactions", "tab_closed", "tab_disconnected"]);
    const result = await findTool(tools, "stop_recording").handler({});
    const data = JSON.parse(result.content[0].text);
    expect(validReasons.has(data.metadata.stopReason)).toBe(true);
  });

  it("each interaction has required fields", async () => {
    const result = await findTool(tools, "stop_recording").handler({});
    const data = JSON.parse(result.content[0].text);
    for (const page of data.pages) {
      for (const interaction of page.interactions) {
        expect(typeof interaction.timestamp).toBe("string");
        expect(typeof interaction.tool).toBe("string");
        expect(typeof interaction.args).toBe("object");
        expect(typeof interaction.durationMs).toBe("number");
        expect(typeof interaction.pageUrl).toBe("string");
      }
    }
  });
});
