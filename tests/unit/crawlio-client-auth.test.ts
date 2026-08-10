import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CrawlioClient,
  resolveCrawlioMcpToken,
} from "@/mcp-server/crawlio-client";

const ORIGINAL_TOKEN = process.env.CRAWLIO_MCP_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_TOKEN === undefined) delete process.env.CRAWLIO_MCP_TOKEN;
  else process.env.CRAWLIO_MCP_TOKEN = ORIGINAL_TOKEN;
});

describe("Crawlio ControlServer authentication", () => {
  it("prefers the explicit environment capability and otherwise reads the local 0600 token file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crawlio-token-test-"));
    const tokenFile = join(dir, "mcp.token");
    try {
      await writeFile(tokenFile, "disk-test-capability\n", { mode: 0o600 });
      await expect(resolveCrawlioMcpToken({ CRAWLIO_MCP_TOKEN: " env-test-capability " }, tokenFile))
        .resolves.toEqual({ value: "env-test-capability", source: "env:CRAWLIO_MCP_TOKEN" });
      await expect(resolveCrawlioMcpToken({}, tokenFile))
        .resolves.toEqual({ value: "disk-test-capability", source: "disk:mcp.token" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attaches the capability as both transport token and master Bearer", async () => {
    process.env.CRAWLIO_MCP_TOKEN = "unit-test-control-capability";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ status: "idle" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new CrawlioClient();
    vi.spyOn(client, "getPort").mockResolvedValue(8787);

    await expect(client.getStatus()).resolves.toEqual({ status: "idle" });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);

    expect(url).toBe("http://127.0.0.1:8787/status");
    expect(headers.get("X-Crawlio-MCP-Token")).toBe("unit-test-control-capability");
    expect(headers.get("Authorization")).toBe("Bearer unit-test-control-capability");
  });

  it("rejects control characters instead of constructing an unsafe header", async () => {
    await expect(resolveCrawlioMcpToken({ CRAWLIO_MCP_TOKEN: "bad\nheader" }, "/missing/token"))
      .resolves.toBeNull();
  });
});
