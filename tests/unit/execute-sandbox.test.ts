import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCodeModeTools, saveArtifactToDisk } from "@/mcp-server/tools";
import { CrawlioClient } from "@/mcp-server/crawlio-client";
import type { ActionPolicy } from "@/mcp-server/action-policy";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// --- Command-type-based bridge router ---

function createRoutingBridge() {
  const sendSpy = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "get_connection_status":
        return { connectedTab: { url: "" } }; // empty URL bypasses smartObjectCache
      case "detect_framework":
        return { detections: [] };
      case "list_tabs":
        return { tabs: [] };
      case "browser_evaluate":
        return { result: "evaluated" };
      case "browser_snapshot":
        return { snapshot: "ok" };
      default:
        return { ok: true };
    }
  });
  return {
    send: sendSpy,
    isConnected: true,
    push: vi.fn(),
  };
}

function getExecuteTool(bridge: ReturnType<typeof createRoutingBridge>, actionPolicy: ActionPolicy | null = null) {
  const crawlio = new CrawlioClient("http://localhost:0");
  const tools = createCodeModeTools(bridge as never, crawlio, { getActionPolicy: () => actionPolicy });
  const execute = tools.find((t) => t.name === "execute");
  if (!execute) throw new Error("execute tool not found");
  return execute;
}

// ============================================================
// Group 1: Parameter Accessibility
// ============================================================

describe("Execute Sandbox — Parameter Accessibility", () => {
  let bridge: ReturnType<typeof createRoutingBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createRoutingBridge();
    execute = getExecuteTool(bridge);
  });

  it("T1: bridge is accessible and calls reach the mock", async () => {
    const result = await execute.handler({ code: 'return await bridge.send({ type: "list_tabs" })' });
    expect(result.isError).toBe(false);
    // bridge.send is called for get_connection_status + detect_framework before user code
    const userCall = bridge.send.mock.calls.find((c: unknown[]) => (c[0] as { type: string }).type === "list_tabs");
    expect(userCall).toBeTruthy();
  });

  it("T2: crawlio is accessible", async () => {
    const result = await execute.handler({ code: "return typeof crawlio.getStatus" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toBe("function");
  });

  it("T3: sleep resolves without error", async () => {
    const result = await execute.handler({ code: 'await sleep(10); return "slept"' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toBe("slept");
  });

  it("T4: TIMEOUTS.connect_tab is 30000", async () => {
    const result = await execute.handler({ code: "return TIMEOUTS.connect_tab" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toBe(30000);
  });

  it("T5: smart has 7 core keys", async () => {
    const result = await execute.handler({ code: "return Object.keys(smart).sort()" });
    expect(result.isError).toBe(false);
    const keys = JSON.parse(result.content[0].text);
    expect(keys).toEqual(
      expect.arrayContaining(["click", "evaluate", "navigate", "rebuild", "snapshot", "type", "waitFor"]),
    );
    expect(keys.length).toBeGreaterThanOrEqual(7);
  });

  it("T6: compileRecording produces valid output", async () => {
    const code = `
      const session = {
        id: "test-1",
        startedAt: "2026-01-01T00:00:00Z",
        duration: 5000,
        pages: [{
          url: "https://example.com",
          title: "Example",
          enteredAt: "2026-01-01T00:00:00Z",
          console: [],
          network: [],
          interactions: [
            { timestamp: "2026-01-01T00:00:01Z", tool: "browser_click", args: { selector: "#btn" }, durationMs: 100, pageUrl: "https://example.com" }
          ]
        }],
        metadata: { tabId: 1, initialUrl: "https://example.com", stopReason: "manual" }
      };
      const result = compileRecording(session, { name: "test-flow" });
      return { name: result.name, pageCount: result.pageCount, interactionCount: result.interactionCount };
    `;
    const result = await execute.handler({ code });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe("test-flow");
    expect(parsed.pageCount).toBe(1);
    expect(parsed.interactionCount).toBe(1);
  });
});

// ============================================================
// Group 2: Error Paths
// ============================================================

describe("Execute Sandbox — Error Paths", () => {
  let bridge: ReturnType<typeof createRoutingBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createRoutingBridge();
    execute = getExecuteTool(bridge);
  });

  it("T7: syntax error surfaces clearly", async () => {
    const result = await execute.handler({ code: "if (" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Syntax error/i);
  });

  it("T8: thrown error surfaces as execution error", async () => {
    const result = await execute.handler({ code: 'throw new Error("boom")' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Execution error/);
    expect(result.content[0].text).toMatch(/boom/);
  });

  it("T9: empty code string rejected by Zod", async () => {
    await expect(execute.handler({ code: "" })).rejects.toThrow();
  });
});

// ============================================================
// Group 3: Integration
// ============================================================

describe("Execute Sandbox — Integration", () => {
  let bridge: ReturnType<typeof createRoutingBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createRoutingBridge();
    execute = getExecuteTool(bridge);
  });

  it("T10: bridge.send error in user code surfaces original message", async () => {
    bridge.send.mockImplementationOnce(async () => ({ connectedTab: { url: "" } }));
    bridge.send.mockImplementationOnce(async () => ({ detections: [] }));
    bridge.send.mockImplementation(async () => { throw new Error("extension dead"); });

    const result = await execute.handler({ code: 'return await bridge.send({ type: "capture_page" })' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/extension dead/);
  });

  it("T11: no return yields empty object", async () => {
    const result = await execute.handler({ code: "const x = 42;" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({});
  });

  it("T12: smart.evaluate reaches bridge with browser_evaluate type", async () => {
    const result = await execute.handler({ code: 'return await smart.evaluate("1+1")' });
    expect(result.isError).toBe(false);
    expect(bridge.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "browser_evaluate", expression: "1+1" }),
      expect.any(Number),
    );
  });
});

// ============================================================
// Group 4: Escape Resistance
// ============================================================

describe("Execute Sandbox — Escape Resistance", () => {
  let bridge: ReturnType<typeof createRoutingBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createRoutingBridge();
    execute = getExecuteTool(bridge);
  });

  it("T13: process is not available", async () => {
    const result = await execute.handler({ code: "return typeof process" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toBe("undefined");
  });

  it("T14: constructor.constructor escape is blocked", async () => {
    const result = await execute.handler({ code: 'return bridge.send.constructor.constructor("return process")()' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Execution error/);
  });

  it("T15: dynamic import is blocked", async () => {
    const result = await execute.handler({ code: 'return await import("node:fs")' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Execution error/);
  });

  it("T16: bridge command types are policy-gated", async () => {
    const result = await execute.handler({ code: 'return await bridge.send({ type: "not_a_real_command" })' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bridge.send command type denied");
  });

  it("T17: crawlio.api rejects hosted model destinations", async () => {
    const result = await execute.handler({ code: 'return await crawlio.api("GET", "https://api.crawlio.app/grounding")' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("crawlio.api destination denied");
  });

  it("T18: bridge.send honors action policy for inner commands", async () => {
    execute = getExecuteTool(bridge, { default: "allow", deny: ["set_cookie"] });
    const result = await execute.handler({ code: 'return await bridge.send({ type: "set_cookie", name: "sid", value: "abc123456", domain: "example.com" })' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("denied by action policy");
    expect(bridge.send.mock.calls.some((c: unknown[]) => (c[0] as { type: string }).type === "set_cookie")).toBe(false);
  });

  it("T19: bridge.send still allows policy-approved inner commands", async () => {
    execute = getExecuteTool(bridge, { default: "deny", allow: ["list_tabs"] });
    const result = await execute.handler({ code: 'return await bridge.send({ type: "list_tabs" })' });
    expect(result.isError).toBe(false);
    expect(bridge.send.mock.calls.some((c: unknown[]) => (c[0] as { type: string }).type === "list_tabs")).toBe(true);
  });

  it("T20: async microtask floods terminate under the worker watchdog", async () => {
    const startedAt = Date.now();
    const result = await execute.handler({
      code: "return await (async function flood() { return Promise.resolve().then(flood); })();",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out|timeout/i);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 7_000);

  it("T21: TIMEOUTS realm-escape is blocked", async () => {
    // Before the fix, TIMEOUTS was the WORKER-realm object, so TIMEOUTS.constructor.constructor
    // reached the worker realm's Function — NOT bound by this context's codeGeneration:{strings:false}
    // — and `Function("return typeof process")()` ran in the worker realm (host RCE → "object").
    // TIMEOUTS is now a context-realm, null-prototype map, so `.constructor` is undefined and the
    // chain throws instead of yielding a callable Function.
    const result = await execute.handler({
      code: "return TIMEOUTS.constructor.constructor('return typeof process')()",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Execution error/);
  });

  it("T22: TIMEOUTS is a null-prototype value map (no constructor) yet values still work", async () => {
    const ctor = await execute.handler({ code: "return typeof TIMEOUTS.constructor" });
    expect(ctor.isError).toBe(false);
    expect(JSON.parse(ctor.content[0].text)).toBe("undefined"); // null prototype → no constructor to climb
    // The hardening must not break legitimate TIMEOUTS access (cf. T4).
    const val = await execute.handler({ code: "return TIMEOUTS.connect_tab" });
    expect(val.isError).toBe(false);
    expect(JSON.parse(val.content[0].text)).toBe(30000);
  });
});

// ============================================================
// Group 4b: saveArtifact — sandbox -> disk egress
// ============================================================

describe("Execute Sandbox — saveArtifact egress", () => {
  let bridge: ReturnType<typeof createRoutingBridge>;
  let execute: ReturnType<typeof getExecuteTool>;
  let dir: string;
  const prevDir = process.env.CRAWLIO_ARTIFACT_DIR;
  const prevMax = process.env.CRAWLIO_ARTIFACT_MAX_BYTES;

  beforeEach(async () => {
    bridge = createRoutingBridge();
    execute = getExecuteTool(bridge);
    dir = await mkdtemp(join(tmpdir(), "crawlio-artifacts-"));
    process.env.CRAWLIO_ARTIFACT_DIR = dir;
    delete process.env.CRAWLIO_ARTIFACT_MAX_BYTES;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CRAWLIO_ARTIFACT_DIR; else process.env.CRAWLIO_ARTIFACT_DIR = prevDir;
    if (prevMax === undefined) delete process.env.CRAWLIO_ARTIFACT_MAX_BYTES; else process.env.CRAWLIO_ARTIFACT_MAX_BYTES = prevMax;
  });

  it("SA1: writes bulk data to disk and returns { path, bytes } (not the payload)", async () => {
    const result = await execute.handler({ code: "return await saveArtifact('sub/data.ndjson', 'a\\nb\\nc');" });
    expect(result.isError).toBe(false);
    const out = JSON.parse(result.content[0].text) as { path: string; bytes: number };
    expect(out.bytes).toBe(5);
    expect(out.path.startsWith(dir)).toBe(true);
    expect(await readFile(out.path, "utf-8")).toBe("a\nb\nc");
  });

  it("SA2: append mode concatenates across calls (streaming large exports)", async () => {
    await execute.handler({ code: "return await saveArtifact('log.ndjson', 'row1\\n');" });
    const result = await execute.handler({ code: "return await saveArtifact('log.ndjson', 'row2\\n', { append: true });" });
    expect(result.isError).toBe(false);
    expect(await readFile(join(dir, "log.ndjson"), "utf-8")).toBe("row1\nrow2\n");
  });

  it("SA3: non-string contents are JSON-stringified", async () => {
    const result = await execute.handler({ code: "return await saveArtifact('o.json', { a: 1, b: [2, 3] });" });
    expect(result.isError).toBe(false);
    expect(await readFile(join(dir, "o.json"), "utf-8")).toBe('{"a":1,"b":[2,3]}');
  });

  it("SA4: path traversal is rejected (cannot escape the artifacts dir)", async () => {
    const result = await execute.handler({ code: "return await saveArtifact('../escape.txt', 'x');" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/safe relative path/);
  });

  it("SA5: absolute paths are rejected", async () => {
    const result = await execute.handler({ code: "return await saveArtifact('/etc/pwned', 'x');" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/safe relative path/);
  });

  it("SA6: total size is capped (CRAWLIO_ARTIFACT_MAX_BYTES)", async () => {
    process.env.CRAWLIO_ARTIFACT_MAX_BYTES = "4";
    const result = await execute.handler({ code: "return await saveArtifact('big.txt', '123456');" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/exceed/);
  });

  it("SA7: saveArtifactToDisk confines writes even when called directly", async () => {
    await expect(saveArtifactToDisk("../../escape", "x")).rejects.toThrow(/safe relative path/);
    const ok = await saveArtifactToDisk("nested/ok.txt", "hello");
    expect(ok.bytes).toBe(5);
    expect(ok.path.startsWith(dir)).toBe(true);
  });
});

// ============================================================
// Group 5: Code-mode search hints (catalog honesty)
// ============================================================

describe("Code-mode search — invocation hints", () => {
  async function findEntry(query: string, name: string) {
    const crawlio = new CrawlioClient("http://localhost:0");
    const tools = createCodeModeTools(createRoutingBridge() as never, crawlio);
    const search = tools.find((t) => t.name === "search");
    if (!search) throw new Error("search tool not found");
    const res = await search.handler({ query, limit: 50 });
    const entries = JSON.parse(res.content[0].text) as Array<{ name: string; codeMode?: string }>;
    return entries.find((e) => e.name === name);
  }

  it("flags server-composed tools with no code-mode path as full-mode only", async () => {
    for (const name of ["seo_audit", "crux_metrics", "check_robots_txt"]) {
      const entry = await findEntry(name, name);
      expect(entry?.codeMode).toMatch(/full-mode/i);
    }
  });

  it("points detect_technologies / extract_data at their smart.* helpers", async () => {
    expect((await findEntry("detect_technologies", "detect_technologies"))?.codeMode).toContain("smart.detectTechnologies");
    expect((await findEntry("extract_data", "extract_data"))?.codeMode).toContain("smart.extractData");
  });

  it("tells storage tools to use storageType, not the colliding `type` envelope key", async () => {
    expect((await findEntry("get_storage", "get_storage"))?.codeMode).toContain("storageType");
  });

  it("leaves ordinary bridge commands unannotated", async () => {
    expect((await findEntry("take_screenshot", "take_screenshot"))?.codeMode).toBeUndefined();
  });
});

// ============================================================
// Group 6: Async fire-and-poll background jobs
// ============================================================

describe("Execute Sandbox — Background jobs", () => {
  // The jobRegistry is module-level in tools.ts, so execute + job tools share it across
  // createCodeModeTools() instances. Tests target their own random jobId → isolation-safe.
  function codeTools() {
    const crawlio = new CrawlioClient("http://localhost:0");
    return createCodeModeTools(createRoutingBridge() as never, crawlio, { getActionPolicy: () => null });
  }
  const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  it("execute({background:true}) returns a jobId immediately, before the job finishes", async () => {
    const execute = codeTools().find(t => t.name === "execute")!;
    const t0 = Date.now();
    const r = await execute.handler({ code: "await sleep(700); return 42", background: true });
    const elapsed = Date.now() - t0;
    expect((r as { isError: boolean }).isError).toBe(false);
    const out = parse(r);
    expect(typeof out.jobId).toBe("string");
    expect(out.status).toBe("running");
    expect(elapsed).toBeLessThan(400); // returned well before the 700ms job
  });

  it("get_job_result transitions running → done and carries the return value", async () => {
    const tools = codeTools();
    const execute = tools.find(t => t.name === "execute")!;
    const getJob = tools.find(t => t.name === "get_job_result")!;
    const { jobId } = parse(await execute.handler({ code: "await sleep(150); return { ok: 7 };", background: true }));
    await vi.waitFor(async () => {
      const s = parse(await getJob.handler({ jobId }));
      expect(s.status).toBe("done");
      expect(s.value).toEqual({ ok: 7 });
    }, { timeout: 4000, interval: 40 });
  });

  it("get_job_result reports not_found for an unknown jobId", async () => {
    const getJob = codeTools().find(t => t.name === "get_job_result")!;
    expect(parse(await getJob.handler({ jobId: "nope-does-not-exist" })).status).toBe("not_found");
  });

  it("list_jobs includes a launched job", async () => {
    const tools = codeTools();
    const execute = tools.find(t => t.name === "execute")!;
    const listJobs = tools.find(t => t.name === "list_jobs")!;
    const { jobId } = parse(await execute.handler({ code: "await sleep(400); return 1;", background: true }));
    const list = parse(await listJobs.handler({}));
    expect(list.jobs.some((j: { jobId: string }) => j.jobId === jobId)).toBe(true);
  });

  it("a long background job returns fast and completes past a normal synchronous wait", async () => {
    const tools = codeTools();
    const execute = tools.find(t => t.name === "execute")!;
    const getJob = tools.find(t => t.name === "get_job_result")!;
    const t0 = Date.now();
    const { jobId } = parse(await execute.handler({ code: "await sleep(900); return 'late';", background: true }));
    expect(Date.now() - t0).toBeLessThan(400); // handler returned long before the 900ms job
    await vi.waitFor(async () => {
      expect(parse(await getJob.handler({ jobId })).value).toBe("late");
    }, { timeout: 5000, interval: 50 });
  });

  it("cancel_job terminates a running job and stays cancelled (no late done)", async () => {
    const tools = codeTools();
    const execute = tools.find(t => t.name === "execute")!;
    const getJob = tools.find(t => t.name === "get_job_result")!;
    const cancel = tools.find(t => t.name === "cancel_job")!;
    const { jobId } = parse(await execute.handler({ code: "await sleep(5000); return 'never';", background: true }));
    expect(parse(await cancel.handler({ jobId })).status).toBe("cancelled");
    // Give the aborted worker a beat; it must not flip back to done.
    await new Promise(res => setTimeout(res, 250));
    expect(parse(await getJob.handler({ jobId })).status).toBe("cancelled");
  });
});
