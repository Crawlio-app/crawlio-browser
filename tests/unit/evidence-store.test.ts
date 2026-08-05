import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeEvidence, readEvidence, listEvidence } from "../../src/evidence/store.js";
import { wrapEvidence, deriveQuality } from "../../src/evidence/wrap.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEnvelope } from "../../src/evidence/schema.js";

function makeEnvelope(overrides?: Partial<EvidenceEnvelope<Record<string, unknown>>>): EvidenceEnvelope<Record<string, unknown>> {
  return {
    evidenceId: "ev_test_abc123",
    type: "page",
    url: "https://example.com",
    provenance: { source: "browser", tool: "crawlio-crawler", timestamp: new Date().toISOString() },
    confidence: { level: "medium", basis: "test" },
    gaps: [],
    quality: "partial",
    payload: { capture: { html: "<html></html>", url: "https://example.com" }, performance: null, security: null, fonts: null, meta: null, accessibility: null, mobileReadiness: null },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("evidence store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "evidence-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read evidence", async () => {
    const envelope = makeEnvelope();
    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_test_abc123.json");
    const read = await readEvidence("ev_test_abc123", tmpDir);
    expect(read.evidenceId).toBe("ev_test_abc123");
    expect(read.url).toBe("https://example.com");
  });

  it("should augment gaps for null payload values not already in gaps", async () => {
    const envelope = makeEnvelope({
      gaps: [{ dimension: "performance", reason: "No browser", impact: "data-absent", reducesConfidence: true }],
    });
    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<Record<string, unknown>>("ev_test_abc123", tmpDir);
    const dimensions = read.gaps.map(g => g.dimension);
    expect(dimensions).toContain("performance");
    expect(dimensions).toContain("security");
    expect(dimensions).toContain("fonts");
    expect(dimensions).toContain("meta");
    expect(dimensions).toContain("accessibility");
    expect(dimensions).toContain("mobileReadiness");
  });

  it("should not duplicate gaps already present", async () => {
    const envelope = makeEnvelope({
      gaps: [
        { dimension: "performance", reason: "No browser", impact: "data-absent", reducesConfidence: true },
        { dimension: "fonts", reason: "No fonts", impact: "data-absent", reducesConfidence: false },
      ],
    });
    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<Record<string, unknown>>("ev_test_abc123", tmpDir);
    const fontGaps = read.gaps.filter(g => g.dimension === "fonts");
    expect(fontGaps).toHaveLength(1);
  });

  it("should not add gaps when payload has no null values", async () => {
    const envelope = makeEnvelope({
      payload: { capture: { html: "<html></html>" }, status: "ok" },
      gaps: [],
    });
    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<Record<string, unknown>>("ev_test_abc123", tmpDir);
    expect(read.gaps).toHaveLength(0);
  });

  it("should list evidence IDs", async () => {
    await writeEvidence(makeEnvelope(), tmpDir);
    await writeEvidence(makeEnvelope({ evidenceId: "ev_test_def456" }), tmpDir);
    const ids = await listEvidence(tmpDir);
    expect(ids).toContain("ev_test_abc123");
    expect(ids).toContain("ev_test_def456");
  });

  it("should return empty array when evidence directory does not exist", async () => {
    const ids = await listEvidence(join(tmpDir, "nonexistent"));
    expect(ids).toEqual([]);
  });
});

describe("wrapEvidence gap dedup", () => {
  it("should deduplicate gaps when explicit gap overlaps with null-detected gap", () => {
    const envelope = wrapEvidence({
      type: "page",
      url: "https://example.com",
      payload: {
        capture: { html: "<html></html>", url: "https://example.com" },
        performance: null,
        security: null,
        fonts: null,
        meta: null,
        accessibility: null,
        mobileReadiness: null,
      },
      provenance: { source: "browser", tool: "test" },
      confidence: { level: "medium", basis: "test" },
      gaps: [{ dimension: "fonts", reason: "Font extraction failed", impact: "method-failed", reducesConfidence: true }],
    });

    const fontsGaps = envelope.gaps.filter(g => g.dimension === "fonts");
    expect(fontsGaps).toHaveLength(1);
    expect(fontsGaps[0].reason).toBe("Font extraction failed");
    expect(fontsGaps[0].impact).toBe("method-failed");
  });

  it("should still detect null gaps for dimensions without explicit gaps", () => {
    const envelope = wrapEvidence({
      type: "page",
      url: "https://example.com",
      payload: {
        capture: { html: "<html></html>", url: "https://example.com" },
        performance: null,
        security: null,
        fonts: null,
        meta: null,
        accessibility: null,
        mobileReadiness: null,
      },
      provenance: { source: "browser", tool: "test" },
      confidence: { level: "medium", basis: "test" },
      gaps: [{ dimension: "fonts", reason: "Font extraction failed", impact: "method-failed", reducesConfidence: true }],
    });

    const dimensions = envelope.gaps.map(g => g.dimension);
    expect(dimensions).toContain("performance");
    expect(dimensions).toContain("security");
    expect(dimensions).toContain("meta");
    expect(dimensions).toContain("accessibility");
    expect(dimensions).toContain("mobileReadiness");
  });

  it("should produce no gaps when payload has no null values and no explicit gaps", () => {
    const envelope = wrapEvidence({
      type: "page",
      url: "https://example.com",
      payload: {
        capture: { html: "<html></html>", url: "https://example.com" },
        performance: { lcp: 100 },
        security: { https: true },
        fonts: { list: [] },
        meta: { _title: "Test" },
        accessibility: { nodeCount: 10 },
        mobileReadiness: { hasViewportMeta: true },
      } as any,
      provenance: { source: "browser", tool: "test" },
      confidence: { level: "high", basis: "test" },
    });

    expect(envelope.gaps).toHaveLength(0);
    expect(envelope.quality).toBe("complete");
  });
});

describe("deriveQuality", () => {
  it("should return 'complete' when 0 gaps regardless of confidence level", () => {
    expect(deriveQuality([], { level: "high", basis: "test" })).toBe("complete");
    expect(deriveQuality([], { level: "medium", basis: "test" })).toBe("complete");
    expect(deriveQuality([], { level: "low", basis: "test" })).toBe("complete");
    expect(deriveQuality([], { level: "speculative", basis: "test" })).toBe("complete");
  });

  it("should return 'unavailable' for speculative confidence with gaps", () => {
    const gaps = [{ dimension: "fonts", reason: "test", impact: "data-absent" as const, reducesConfidence: false }];
    expect(deriveQuality(gaps, { level: "speculative", basis: "test" })).toBe("unavailable");
  });
});
