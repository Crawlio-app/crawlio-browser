import { describe, expect, it, vi } from "vitest";
import { createTools } from "@/mcp-server/tools";

function screenshotTool(response: Record<string, unknown>) {
  const bridge = {
    send: vi.fn(async () => response),
    isConnected: true,
    push: vi.fn(),
  };
  const crawlio = { request: vi.fn() };
  const tool = createTools(bridge as never, crawlio as never).find((candidate) => candidate.name === "take_screenshot");
  if (!tool) throw new Error("take_screenshot tool missing");
  return { bridge, tool };
}

describe("take_screenshot contract", () => {
  it("exposes the viewport/full-page/selector options that shipped skills document", () => {
    const { tool } = screenshotTool({ data: "abc", mimeType: "image/jpeg" });
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
      "fullPage", "selector", "format", "quality",
    ]));
  });

  it("passes screenshot options to the extension and labels bytes with their actual MIME type", async () => {
    const { bridge, tool } = screenshotTool({ data: "base64-jpeg", mimeType: "image/jpeg", format: "jpeg" });
    const result = await tool.handler({ fullPage: true, format: "png", quality: 90 }) as {
      content: Array<{ type: string; data: string; mimeType: string }>;
    };

    expect(bridge.send).toHaveBeenCalledWith({
      type: "take_screenshot",
      fullPage: true,
      selector: undefined,
      format: "png",
      quality: 90,
    }, 10_000);
    expect(result.content[0]).toMatchObject({
      type: "image",
      data: "base64-jpeg",
      mimeType: "image/jpeg",
    });
  });
});
