import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, vi } from "vitest";
import { createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";

function createMockBridge(responses: unknown[] = []) {
  const queue = [...responses];
  return {
    send: vi.fn(async () => queue.shift() ?? {}),
    isConnected: true,
    push: vi.fn(),
  };
}

function createMockCrawlio() {
  return { request: vi.fn() } as any;
}

describe("robot training MCP tools", () => {
  const names = [
    "robot_training_start",
    "robot_training_status",
    "robot_training_stop",
    "robot_training_artifacts",
    "recording_start",
    "recording_status",
    "recording_stop",
    "recording_artifacts",
    "recording_capture_bundle",
    "recording_validate_bundle",
  ];

  it("registers the robot training tool surface", () => {
    const tools = createTools(createMockBridge() as any, createMockCrawlio());
    const registered = tools.map(t => t.name);
    for (const name of names) {
      expect(registered).toContain(name);
      expect(TOOL_TIMEOUTS[name]).toBeGreaterThan(0);
    }
  });

  it("starts a fresh monitored recording run and writes a manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "robot-training-start-"));
    try {
      const bridge = createMockBridge([
        { tabId: 101, url: "https://example.com", title: "Example", connected: true },
        "started",
        { sessionId: "rec_1" },
        { result: { ok: true, monitor: "robot-training", entries: 1 }, type: "object" },
      ]);
      const tool = createTools(bridge as any, createMockCrawlio()).find(t => t.name === "robot_training_start")!;

      const result = await tool.handler({
        url: "https://example.com",
        runId: "rt_test",
        outputDir,
        active: true,
      }) as any;
      const payload = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(false);
      expect(payload.runId).toBe("rt_test");
      expect(payload.tabId).toBe(101);
      expect(bridge.send).toHaveBeenNthCalledWith(1, {
        type: "create_tab",
        url: "https://example.com",
        active: true,
        connect: true,
      }, TOOL_TIMEOUTS.robot_training_start);
      expect(bridge.send).toHaveBeenNthCalledWith(2, { type: "start_network_capture" }, 5000);
      expect(bridge.send).toHaveBeenNthCalledWith(3, {
        type: "start_recording",
        maxDurationSec: undefined,
        maxInteractions: undefined,
      }, 10000);

      const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf-8"));
      expect(manifest.id).toBe("rt_test");
      expect(manifest.schemaVersion).toBe("crawlio.recordingBundle.v1");
      expect(manifest.producer).toBe("chrome");
      expect(manifest.fidelity).toBe("cdpFull");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stops a run and writes split artifacts plus mentu-interceptor flows", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "robot-training-stop-"));
    try {
      const recording = {
        id: "rec_1",
        startedAt: "2026-05-19T00:00:00Z",
        duration: 1,
        pages: [{
          url: "https://example.com",
          enteredAt: "2026-05-19T00:00:00Z",
          console: [],
          interactions: [{ timestamp: "2026-05-19T00:00:00Z", tool: "user_click", args: {}, durationMs: 1, pageUrl: "https://example.com", source: "user" }],
          network: [{
            requestId: "1",
            url: "https://example.com/api/do",
            method: "POST",
            status: 200,
            mimeType: "application/json",
            size: 12,
            transferSize: 12,
            durationMs: 42,
            resourceType: "XHR",
            requestHeaders: { "content-type": "application/json" },
            requestBody: "{\"ok\":true}",
          }],
        }],
        metadata: { tabId: 101, initialUrl: "https://example.com", stopReason: "manual" },
      };
      const bridge = createMockBridge([
        { tabId: 101, url: "https://example.com", title: "Example", connected: true },
        "started",
        { sessionId: "rec_1" },
        { result: { ok: true, monitor: "robot-training", entries: 1 }, type: "object" },
        { result: [{ id: 1, reason: "init" }], type: "object" },
        recording,
        { body: "{\"done\":true}", base64Encoded: false, truncated: false, mimeType: "application/json" },
        recording.pages[0].network,
        [],
        { cookies: [] },
        { result: { url: "https://example.com", title: "Example" }, type: "object" },
      ]);
      const tools = createTools(bridge as any, createMockCrawlio());
      const start = tools.find(t => t.name === "robot_training_start")!;
      const stop = tools.find(t => t.name === "robot_training_stop")!;

      await start.handler({ url: "https://example.com", runId: "rt_stop", outputDir });
      const result = await stop.handler({ runId: "rt_stop", closeTab: false }) as any;
      const payload = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(false);
      expect(payload.network.total).toBe(1);
      expect(payload.network.withBodies).toBe(1);
      expect(payload.artifacts.artifacts.map((a: { name: string }) => a.name)).toContain("flows.jsonl");
      expect(payload.artifacts.artifacts.map((a: { name: string }) => a.name)).toContain("causal-graph.json");
      expect(payload.artifacts.artifacts.map((a: { name: string }) => a.name)).toContain("recipe.json");

      const flows = await readFile(join(outputDir, "flows.jsonl"), "utf-8");
      expect(flows).toContain("\"request\"");
      expect(flows).toContain("https://example.com/api/do");
      expect(JSON.parse(await readFile(join(outputDir, "state-log.json"), "utf-8"))).toHaveLength(1);
      expect(JSON.parse(await readFile(join(outputDir, "recording.json"), "utf-8")).pages[0].interactions[0].source).toBe("user");

      const sentTypes = bridge.send.mock.calls.map(([command]) => (command as { type?: string }).type);
      expect(sentTypes.indexOf("browser_evaluate")).toBeLessThan(sentTypes.indexOf("stop_recording"));
      expect(sentTypes.indexOf("stop_recording")).toBeLessThan(sentTypes.indexOf("get_response_body"));
      expect(sentTypes.indexOf("get_response_body")).toBeLessThan(sentTypes.indexOf("stop_network_capture"));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("validates a canonical bundle directory without reading body payloads into the response", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "recording-validate-"));
    try {
      await Promise.all([
        "manifest.json",
        "recording.json",
        "network.json",
        "bodies.json",
        "state-log.json",
        "state.json",
        "flows.jsonl",
      ].map(name => import("fs/promises").then(fs => fs.writeFile(join(outputDir, name), name === "flows.jsonl" ? "" : "{}"))));
      const tool = createTools(createMockBridge() as any, createMockCrawlio()).find(t => t.name === "recording_validate_bundle")!;

      const result = await tool.handler({ outputDir }) as any;
      const payload = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(false);
      expect(payload.ok).toBe(true);
      expect(payload.missing).toEqual([]);
      expect(result.content[0].text).not.toContain("body payload");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
