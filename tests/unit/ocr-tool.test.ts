import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";

// --- Mock bridge factory ---

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
    push: vi.fn(),
  };
}

function createMockCrawlio() {
  return {
    startCrawl: vi.fn(),
    getCrawlStatus: vi.fn(),
    getEnrichment: vi.fn(),
    getCrawledUrls: vi.fn(),
    enrichUrl: vi.fn(),
  };
}

describe("ocr_screenshot tool", () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("has a 30s timeout configured", () => {
    expect(TOOL_TIMEOUTS.ocr_screenshot).toBe(30000);
  });

  it("exists in createTools output", () => {
    const bridge = createMockBridge([]);
    const crawlio = createMockCrawlio();
    const tools = createTools(bridge as never, crawlio as never);
    const ocrTool = tools.find(t => t.name === "ocr_screenshot");
    expect(ocrTool).toBeDefined();
    expect(ocrTool!.description).toContain("Vision.framework");
  });

  it("returns error on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const bridge = createMockBridge([]);
    const crawlio = createMockCrawlio();
    const tools = createTools(bridge as never, crawlio as never);
    const ocrTool = tools.find(t => t.name === "ocr_screenshot")!;

    const result = await ocrTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires macOS");
  });

  it("returns error when screenshot capture fails", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const bridge = createMockBridge([{ data: { data: null } }]);
    const crawlio = createMockCrawlio();
    const tools = createTools(bridge as never, crawlio as never);
    const ocrTool = tools.find(t => t.name === "ocr_screenshot")!;

    const result = await ocrTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Screenshot capture failed");
  });

  it("returns error when bridge throws", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const bridge = createMockBridge([{ error: "Not connected" }]);
    const crawlio = createMockCrawlio();
    const tools = createTools(bridge as never, crawlio as never);
    const ocrTool = tools.find(t => t.name === "ocr_screenshot")!;

    const result = await ocrTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Not connected");
  });

  it("has correct inputSchema with fullPage and selector properties", () => {
    const bridge = createMockBridge([]);
    const crawlio = createMockCrawlio();
    const tools = createTools(bridge as never, crawlio as never);
    const ocrTool = tools.find(t => t.name === "ocr_screenshot")!;

    expect(ocrTool.inputSchema.properties).toHaveProperty("fullPage");
    expect(ocrTool.inputSchema.properties).toHaveProperty("selector");
    expect(ocrTool.inputSchema.properties.fullPage.type).toBe("boolean");
    expect(ocrTool.inputSchema.properties.selector.type).toBe("string");
  });

  it("passes fullPage and selector to bridge.send", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    // Return a screenshot with no image data so the handler bails before spawning the
    // Swift shim. Previously this test let the spawn happen and relied on it failing fast,
    // which held on macOS but hung past the 5s timeout on Linux CI — the assertion is about
    // the bridge parameters, so reaching a subprocess at all was incidental.
    const bridge = createMockBridge([{ data: {} }]);
    const crawlio = createMockCrawlio();
    const tools = createTools(bridge as never, crawlio as never);
    const ocrTool = tools.find(t => t.name === "ocr_screenshot")!;

    await ocrTool.handler({ fullPage: true, selector: "#content" }).catch(() => {});

    expect(bridge.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "take_screenshot",
        fullPage: true,
        selector: "#content",
      }),
      30000,
    );
  });
});
