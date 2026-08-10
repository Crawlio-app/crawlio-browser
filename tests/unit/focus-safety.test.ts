import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTools } from "../../src/mcp-server/tools.js";

const ROOT = join(__dirname, "../..");

describe("autonomous browser focus safety", () => {
  it("keeps every shipped URL-based skill connection in the background", () => {
    const skillCalls = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const path = join(ROOT, "skills", entry.name, "SKILL.md");
        let source: string;
        try { source = readFileSync(path, "utf-8"); } catch { return []; }
        return [...source.matchAll(/connect_tab\s*\(\s*\{[^)]*\burl\s*:[^)]*\}\s*\)/gs)]
          .map((match) => ({ skill: entry.name, call: match[0] }));
      });

    expect(skillCalls.length).toBeGreaterThan(0);
    for (const { skill, call } of skillCalls) {
      expect(call, `${skill} must not take the user's foreground`).toMatch(/\bbackground\s*:\s*true\b/);
    }
  });

  it("creates an owned background tab when enrich_url starts disconnected", async () => {
    const bridge = {
      isConnected: true,
      push: vi.fn(),
      send: vi.fn(async (command: { type?: string }) => {
        if (command.type === "get_connection_status") return { connected: false };
        if (command.type === "connect_tab") return { tabId: 44, url: "https://example.com" };
        if (command.type === "capture_page") {
          return {
            url: "https://example.com",
            title: "Example",
            framework: null,
            networkRequests: [],
            consoleLogs: [],
            domSnapshot: null,
          };
        }
        throw new Error(`unexpected bridge command: ${command.type}`);
      }),
    };
    const crawlio = { postEnrichment: vi.fn(async () => true) };
    const tool = createTools(bridge as any, crawlio as any)
      .find((candidate) => candidate.name === "enrich_url")!;

    const result = await tool.handler({ url: "https://example.com", waitMs: 0 }) as any;

    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith({
      type: "connect_tab",
      url: "https://example.com",
      background: true,
    }, 15_000);
    expect(bridge.send.mock.calls.some(([command]) => command.type === "browser_navigate")).toBe(false);
    expect(crawlio.postEnrichment).toHaveBeenCalledOnce();
  });

  it("keeps the default-mode automated recording recipe explicitly backgrounded", () => {
    const source = readFileSync(join(ROOT, "skills/canonical-recording/SKILL.md"), "utf-8");
    expect(source).toContain("automated smoke capture");
    expect(source).toContain("`recording_start` with `active: false`");
  });
});
