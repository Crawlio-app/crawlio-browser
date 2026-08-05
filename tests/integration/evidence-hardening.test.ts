import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  wrapEvidence,
  writeEvidence,
  readEvidence,
  listEvidence,
  listRuns,
  auditEvidence,
} from "../../src/evidence/index.js";

describe("evidence hardening", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ev-hardening-"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true });
  });

  it("wrapEvidence stamps metadata.writtenVia", () => {
    const env = wrapEvidence({
      type: "page",
      url: "https://example.com",
      payload: { title: "Test", capture: null, meta: { _canonical: null } } as any,
      provenance: { source: "browser", tool: "test" },
      confidence: { level: "high", basis: "test" },
    });
    expect(env.metadata?.writtenVia).toBe("wrapEvidence");
    expect(env.metadata?.version).toBe("1.0");
  });

  it("writeEvidence stamps metadata.validatedBy", async () => {
    const env = wrapEvidence({
      type: "page",
      url: "https://example.com",
      payload: { title: "Test" } as any,
      provenance: { source: "browser", tool: "test" },
      confidence: { level: "high", basis: "test" },
    });
    await writeEvidence(env, tmp);
    const read = await readEvidence(env.evidenceId, tmp);
    expect(read.metadata?.validatedBy).toBe("writeEvidence");
  });

  it("runId routes evidence to isolated subdirectory", async () => {
    const env = wrapEvidence({
      type: "framework",
      url: "https://example.com",
      payload: { name: null, version: null, rendering: "SSG" } as any,
      provenance: { source: "inferred", tool: "test" },
      confidence: { level: "high", basis: "test" },
      runId: "run-monitor-001",
    });
    const path = await writeEvidence(env, tmp);
    expect(path).toContain("runs/run-monitor-001");
    expect(env.metadata?.runId).toBe("run-monitor-001");
  });

  it("separate runs don't interfere with each other", async () => {
    const env = wrapEvidence({
      type: "framework",
      url: "https://iana.org",
      payload: { name: "jQuery", version: "3.7.1", rendering: "static" } as any,
      provenance: { source: "inferred", tool: "test" },
      confidence: { level: "high", basis: "test" },
      runId: "run-extract-001",
    });
    await writeEvidence(env, tmp);

    const runs = await listRuns(tmp);
    expect(runs.sort()).toEqual(["run-extract-001", "run-monitor-001"]);

    const monIds = await listEvidence(tmp, "run-monitor-001");
    const extIds = await listEvidence(tmp, "run-extract-001");
    expect(monIds).toHaveLength(1);
    expect(extIds).toHaveLength(1);
  });

  it("auditEvidence passes for valid evidence", async () => {
    const results = await auditEvidence(tmp, "run-monitor-001");
    expect(results).toHaveLength(1);
    expect(results[0].valid).toBe(true);
    expect(results[0].errors).toHaveLength(0);
  });

  it("auditEvidence detects bypass (missing metadata)", async () => {
    const bypassDir = join(tmp, ".crawlio", "evidence");
    await writeFile(
      join(bypassDir, "ev_bypass_test.json"),
      JSON.stringify({
        evidenceId: "ev_bypass_test",
        type: "page",
        url: "https://example.com",
        provenance: { source: "browser", tool: "curl", timestamp: new Date().toISOString() },
        confidence: { level: "high", basis: "direct" },
        gaps: [],
        quality: "complete",
        payload: { title: "Bypassed" },
        createdAt: new Date().toISOString(),
      })
    );

    const results = await auditEvidence(tmp);
    const bypass = results.find((r) => r.evidenceId === "ev_bypass_test");
    expect(bypass).toBeDefined();
    expect(bypass!.valid).toBe(false);
    expect(bypass!.errors.some((e) => e.includes("writtenVia"))).toBe(true);
    expect(bypass!.errors.some((e) => e.includes("validatedBy"))).toBe(true);
  });

  it("writeEvidence auto-corrects inflated quality", async () => {
    const env = wrapEvidence({
      type: "page",
      url: "https://example.com",
      payload: { title: "Test", capture: null } as any,
      provenance: { source: "browser", tool: "test" },
      confidence: { level: "high", basis: "test" },
    });
    // Corrupt quality before writing
    (env as any).quality = "complete";
    await writeEvidence(env, tmp);
    const read = await readEvidence(env.evidenceId, tmp);
    // writeEvidence re-derives quality — capture:null creates a gap, so it should be "partial"
    expect(read.quality).toBe("partial");
  });
});
