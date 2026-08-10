import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, vi } from "vitest";
import { createCodeModeTools, createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";

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
    "robot_training_clear",
    "robot_training_artifacts",
    "recording_start",
    "recording_status",
    "recording_stop",
    "recording_clear",
    "recording_artifacts",
    "recording_capture_bundle",
    "recording_validate_bundle",
    "monitor_page",
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
      const bridge = createMockBridge([{
        runId: "rt_test",
        targetUrl: "https://example.com",
        outputDir,
        tabId: 101,
        recordingId: "rec_1",
        startedAt: "2026-05-19T00:00:00Z",
        status: "recording",
        monitor: { installed: true, survivesNavigation: true },
      }]);
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
      const types = bridge.send.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
      expect(types).toEqual(["robot_training_start"]);
      expect(bridge.send).toHaveBeenCalledWith({
        type: "robot_training_start",
        url: "https://example.com",
        runId: "rt_test",
        outputDir,
        maxDurationSec: undefined,
        maxInteractions: undefined,
        active: true,
        injectMonitor: true,
        captureStorageValues: false,
      }, 30_000);

      const manifest = JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf-8"));
      expect(manifest.id).toBe("rt_test");
      expect(manifest.schemaVersion).toBe("crawlio.recordingBundle.v1");
      expect(manifest.producer).toBe("chrome");
      expect(manifest.fidelity).toBe("cdpFull");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("keeps the automated one-shot bundle capture in an owned background tab", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "recording-capture-background-"));
    const startedAt = "2026-05-19T00:00:00Z";
    try {
      const bridge = createMockBridge([
        {
          runId: "bundle_bg",
          targetUrl: "https://example.com",
          outputDir,
          tabId: 202,
          recordingId: "rec_bg",
          startedAt,
          status: "recording",
        },
        { status: "idle" },
        {
          run: {
            runId: "bundle_bg",
            targetUrl: "https://example.com",
            outputDir,
            tabId: 202,
            recordingId: "rec_bg",
            startedAt,
            status: "stopped",
          },
          recording: {
            id: "rec_bg",
            startedAt,
            duration: 1,
            pages: [],
            metadata: { tabId: 202, initialUrl: "https://example.com", stopReason: "manual" },
          },
          network: [],
          bodies: {},
          state: {},
          stateLog: [],
        },
      ]);
      const capture = createTools(bridge as any, createMockCrawlio())
        .find((tool) => tool.name === "recording_capture_bundle")!;

      const result = await capture.handler({
        url: "https://example.com",
        bundleID: "bundle_bg",
        outputDir,
        idleTime: 100,
        timeout: 1_000,
      }) as any;

      expect(result.isError).toBe(false);
      expect(bridge.send).toHaveBeenNthCalledWith(1, {
        type: "robot_training_start",
        url: "https://example.com",
        runId: "bundle_bg",
        outputDir,
        maxDurationSec: undefined,
        maxInteractions: undefined,
        active: false,
        injectMonitor: true,
        captureStorageValues: false,
      }, 30_000);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stops a run and writes the canonical artifacts plus a captured-endpoint OpenAPI draft", async () => {
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
        {
          runId: "rt_stop", targetUrl: "https://example.com", outputDir, tabId: 101,
          recordingId: "rec_1", startedAt: "2026-05-19T00:00:00Z", status: "recording",
        },
        {
          run: {
            runId: "rt_stop", targetUrl: "https://example.com", outputDir, tabId: 101,
            recordingId: "rec_1", startedAt: "2026-05-19T00:00:00Z",
            stoppedAt: "2026-05-19T00:00:01Z", status: "stopped",
          },
          recording,
          network: recording.pages[0].network,
          bodies: { "1": { body: "{\"done\":true}", base64Encoded: false } },
          state: { cookies: [] },
          stateLog: [{ id: 1, reason: "init" }],
        },
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
      const openapi = JSON.parse(await readFile(join(outputDir, "api.openapi.yaml"), "utf-8"));
      expect(openapi.openapi).toBe("3.1.0");
      expect(openapi.paths["/api/do"].post.responses["200"]).toBeDefined();
      expect(openapi.paths["/api/do"].post.requestBody.content["application/json"]).toBeDefined();

      const sentTypes = bridge.send.mock.calls.map(([command]) => (command as { type?: string }).type);
      expect(sentTypes).toEqual(["robot_training_start", "robot_training_stop"]);
      expect(bridge.send).toHaveBeenLastCalledWith({
        type: "robot_training_stop",
        runId: "rt_stop",
        fetchBodies: true,
        closeTab: false,
      }, 90_000);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("exposes one default-mode observe control plane for resident lifecycles", async () => {
    const bridge = createMockBridge([{ resident: true, runs: [] }]);
    const tools = createCodeModeTools(bridge as any, createMockCrawlio());
    const observe = tools.find((tool) => tool.name === "observe");
    expect(observe).toBeDefined();
    expect(tools.map((tool) => tool.name)).toContain("observe");
    expect(observe!.inputSchema.properties).toHaveProperty("active");

    const result = await observe!.handler({ action: "training_status", runId: "rt_status" }) as any;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ resident: true, runs: [] });
    expect(bridge.send).toHaveBeenCalledWith({ type: "robot_training_status", runId: "rt_status" }, 10_000);
  });

  it("clears one stopped retained run only after explicit confirmation", async () => {
    const bridge = createMockBridge([{ cleared: "rt_clear", artifactsPreserved: true }]);
    const tools = createTools(bridge as any, createMockCrawlio());
    const clear = tools.find((tool) => tool.name === "robot_training_clear")!;

    await expect(clear.handler({ runId: "../../escape", confirm: true })).rejects.toThrow();
    await expect(clear.handler({ runId: "rt_clear", confirm: false })).rejects.toThrow();

    const result = await clear.handler({ runId: "rt_clear", confirm: true }) as any;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ cleared: "rt_clear", artifactsPreserved: true });
    expect(bridge.send).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledWith({
      type: "robot_training_clear",
      runId: "rt_clear",
      confirm: true,
    }, 10_000);
  });

  it("routes recording_clear through the default observe alias", async () => {
    const bridge = createMockBridge([{ cleared: "rec_clear", artifactsPreserved: true }]);
    const observe = createCodeModeTools(bridge as any, createMockCrawlio())
      .find((tool) => tool.name === "observe")!;

    const result = await observe.handler({ action: "recording_clear", bundleID: "rec_clear", confirm: true }) as any;
    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith({
      type: "robot_training_clear",
      runId: "rec_clear",
      confirm: true,
    }, 10_000);
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
