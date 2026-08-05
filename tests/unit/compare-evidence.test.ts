import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeEvidence, readEvidence } from "../../src/evidence/store.js";
import { wrapEvidence } from "../../src/evidence/wrap.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEnvelope } from "../../src/evidence/schema.js";
import type {
  ComparisonReport,
  DimensionComparison,
} from "../../src/shared/evidence-types.js";

// ── Factory Functions ──────────────────────────────────────────

function makeDimensionComparison(
  overrides?: Partial<DimensionComparison>
): DimensionComparison {
  return {
    dimension: "framework",
    siteA: { name: "React", version: "18.2.0" },
    siteB: { name: "Vue", version: "3.4.0" },
    comparable: true,
    differences: ["Different framework: React vs Vue"],
    verdict: "incomparable",
    confidence: "high",
    ...overrides,
  };
}

const TEN_DIMENSIONS = [
  "framework",
  "performance",
  "security",
  "seo",
  "accessibility",
  "error-surface",
  "third-party",
  "architecture",
  "content-delivery",
  "mobile-readiness",
] as const;

function makeComparisonReport(
  overrides?: Partial<ComparisonReport>
): ComparisonReport {
  return {
    urlA: "https://site-a.com",
    urlB: "https://site-b.com",
    dimensions: TEN_DIMENSIONS.map((dim) =>
      makeDimensionComparison({ dimension: dim })
    ),
    summary: {
      totalDifferences: 4,
      criticalDifferences: 1,
      winner: "A",
      winnerReason: "Site A has better performance and security",
    },
    evidenceChain: ["ev_crawl_a", "ev_crawl_b", "ev_analyze_a", "ev_analyze_b"],
    ...overrides,
  };
}

// ── ComparisonReport Type Validation ─────────────────────────

describe("ComparisonReport type validation", () => {
  it("should have required fields", () => {
    const report = makeComparisonReport();
    expect(report.urlA).toBe("https://site-a.com");
    expect(report.urlB).toBe("https://site-b.com");
    expect(report.dimensions).toHaveLength(10);
    expect(report.summary.totalDifferences).toBe(4);
    expect(report.summary.criticalDifferences).toBe(1);
    expect(report.summary.winner).toBe("A");
    expect(report.summary.winnerReason).toBe(
      "Site A has better performance and security"
    );
    expect(report.evidenceChain).toHaveLength(4);
  });

  it("should cover all 10 dimensions", () => {
    const report = makeComparisonReport();
    const dimensions = report.dimensions.map((d) => d.dimension);
    for (const dim of TEN_DIMENSIONS) {
      expect(dimensions).toContain(dim);
    }
  });

  it("should handle tie result", () => {
    const report = makeComparisonReport({
      summary: {
        totalDifferences: 0,
        criticalDifferences: 0,
        winner: "tie",
        winnerReason: null,
      },
    });
    expect(report.summary.winner).toBe("tie");
    expect(report.summary.winnerReason).toBeNull();
  });

  it("should handle inconclusive result", () => {
    const report = makeComparisonReport({
      dimensions: TEN_DIMENSIONS.map((dim) =>
        makeDimensionComparison({
          dimension: dim,
          comparable: false,
          verdict: "incomparable",
          confidence: "low",
        })
      ),
      summary: {
        totalDifferences: 0,
        criticalDifferences: 0,
        winner: "inconclusive",
        winnerReason: "Too many dimensions lack comparable data",
      },
    });
    expect(report.summary.winner).toBe("inconclusive");
    expect(report.dimensions.every((d) => !d.comparable)).toBe(true);
  });
});

// ── DimensionComparison Verdict Logic ────────────────────────

describe("DimensionComparison verdict logic", () => {
  it("should support A-better verdict", () => {
    const dim = makeDimensionComparison({
      dimension: "performance",
      siteA: { lcp: 1200 },
      siteB: { lcp: 3500 },
      verdict: "A-better",
      differences: ["LCP: 1200ms vs 3500ms"],
    });
    expect(dim.verdict).toBe("A-better");
    expect(dim.comparable).toBe(true);
  });

  it("should support B-better verdict", () => {
    const dim = makeDimensionComparison({
      dimension: "security",
      siteA: { headers: ["X-Frame-Options"] },
      siteB: { headers: ["X-Frame-Options", "CSP", "HSTS"] },
      verdict: "B-better",
      differences: ["Site B has more security headers"],
    });
    expect(dim.verdict).toBe("B-better");
  });

  it("should support equivalent verdict", () => {
    const dim = makeDimensionComparison({
      dimension: "mobile-readiness",
      siteA: { hasViewportMeta: true, mediaQueryCount: 5 },
      siteB: { hasViewportMeta: true, mediaQueryCount: 6 },
      differences: [],
      verdict: "equivalent",
    });
    expect(dim.verdict).toBe("equivalent");
    expect(dim.differences).toHaveLength(0);
  });

  it("should support incomparable verdict when data missing", () => {
    const dim = makeDimensionComparison({
      dimension: "error-surface",
      siteA: null,
      siteB: { consoleErrors: 3 },
      comparable: false,
      verdict: "incomparable",
      confidence: "low",
      differences: ["Site A has no error data"],
    });
    expect(dim.verdict).toBe("incomparable");
    expect(dim.comparable).toBe(false);
    expect(dim.confidence).toBe("low");
  });

  it("should support all confidence levels", () => {
    for (const level of ["high", "medium", "low"] as const) {
      const dim = makeDimensionComparison({ confidence: level });
      expect(dim.confidence).toBe(level);
    }
  });
});

// ── Compare Loop Definition ──────────────────────────────────

// ── Investigator Agent Tools ─────────────────────────────────

// ── writeEvidence with ComparisonReport ──────────────────────

describe("writeEvidence with ComparisonReport", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compare-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read a ComparisonReport envelope", async () => {
    const report = makeComparisonReport();
    const envelope: EvidenceEnvelope<ComparisonReport> = {
      evidenceId: "ev_compare_test1",
      type: "comparison-report",
      url: "https://site-a.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-comparator",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "high",
        basis: "10-dimension comparison of two page captures",
      },
      gaps: [],
      quality: "complete",
      payload: report,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_a",
    };

    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_compare_test1.json");

    const read = await readEvidence<ComparisonReport>(
      "ev_compare_test1",
      tmpDir
    );
    expect(read.type).toBe("comparison-report");
    expect(read.payload.urlA).toBe("https://site-a.com");
    expect(read.payload.urlB).toBe("https://site-b.com");
    expect(read.payload.dimensions).toHaveLength(10);
    expect(read.payload.summary.winner).toBe("A");
    expect(read.payload.evidenceChain).toHaveLength(4);
  });

  it("should derive partial quality when gaps exist", async () => {
    const report = makeComparisonReport({
      summary: {
        totalDifferences: 2,
        criticalDifferences: 0,
        winner: "inconclusive",
        winnerReason: "Insufficient data for definitive comparison",
      },
    });
    const envelope: EvidenceEnvelope<ComparisonReport> = {
      evidenceId: "ev_compare_test2",
      type: "comparison-report",
      url: "https://site-a.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-comparator",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "comparison with partial evidence",
      },
      gaps: [
        {
          dimension: "performance",
          reason: "Web Vitals unavailable for site B",
          impact: "data-absent",
          reducesConfidence: true,
        },
        {
          dimension: "error-surface",
          reason: "Console logs not captured for either site",
          impact: "data-absent",
          reducesConfidence: false,
        },
      ],
      quality: "partial",
      payload: report,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_a",
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<ComparisonReport>(
      "ev_compare_test2",
      tmpDir
    );
    expect(read.quality).toBe("partial");
    expect(read.gaps.length).toBeGreaterThanOrEqual(2);
  });

  it("should use wrapEvidence to create a comparison-report envelope", () => {
    const report = makeComparisonReport();
    const envelope = wrapEvidence({
      type: "comparison-report",
      url: "https://site-a.com",
      payload: report,
      provenance: { source: "inferred", tool: "crawlio-comparator" },
      confidence: {
        level: "high",
        basis: "10-dimension comparison of two page captures",
      },
      parentId: "ev_crawl_a",
    });

    expect(envelope.type).toBe("comparison-report");
    expect(envelope.evidenceId).toMatch(/^ev_/);
    expect(envelope.payload.urlA).toBe("https://site-a.com");
    expect(envelope.payload.dimensions).toHaveLength(10);
    expect(envelope.parentId).toBe("ev_crawl_a");
    expect(envelope.quality).toBe("complete");
  });

  it("should handle identical sites (all equivalent)", async () => {
    const report = makeComparisonReport({
      dimensions: TEN_DIMENSIONS.map((dim) =>
        makeDimensionComparison({
          dimension: dim,
          siteA: { value: "same" },
          siteB: { value: "same" },
          differences: [],
          verdict: "equivalent",
        })
      ),
      summary: {
        totalDifferences: 0,
        criticalDifferences: 0,
        winner: "tie",
        winnerReason: null,
      },
    });

    const envelope: EvidenceEnvelope<ComparisonReport> = {
      evidenceId: "ev_compare_identical",
      type: "comparison-report",
      url: "https://site-a.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-comparator",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "high",
        basis: "10-dimension comparison of two page captures",
      },
      gaps: [],
      quality: "complete",
      payload: report,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<ComparisonReport>(
      "ev_compare_identical",
      tmpDir
    );
    expect(read.payload.summary.totalDifferences).toBe(0);
    expect(read.payload.summary.winner).toBe("tie");
    expect(read.payload.dimensions.every((d) => d.verdict === "equivalent")).toBe(
      true
    );
  });

  it("should handle one site failing (all incomparable)", async () => {
    const report = makeComparisonReport({
      dimensions: TEN_DIMENSIONS.map((dim) =>
        makeDimensionComparison({
          dimension: dim,
          siteA: null,
          siteB: { value: "data" },
          comparable: false,
          verdict: "incomparable",
          confidence: "low",
          differences: ["Site A data unavailable"],
        })
      ),
      summary: {
        totalDifferences: 0,
        criticalDifferences: 0,
        winner: "inconclusive",
        winnerReason: "Site A capture failed — no comparable data",
      },
      evidenceChain: ["ev_crawl_b"],
    });

    const envelope = wrapEvidence({
      type: "comparison-report",
      url: "https://site-a.com",
      payload: report,
      provenance: { source: "inferred", tool: "crawlio-comparator" },
      confidence: {
        level: "low",
        basis: "comparison with one failed capture",
      },
      gaps: [
        {
          dimension: "all",
          reason: "Site A capture failed",
          impact: "method-failed",
          reducesConfidence: true,
        },
      ],
    });

    expect(envelope.quality).toBe("degraded");
    expect(envelope.payload.summary.winner).toBe("inconclusive");
    expect(
      envelope.payload.dimensions.every((d) => d.verdict === "incomparable")
    ).toBe(true);
  });
});

// ── Skill Entry Point ──────────────────────────────────────────

describe("compare skill entry point", () => {
  it("should exist with correct frontmatter", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/compare/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("name: compare");
    expect(content).toContain(
      "allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab"
    );
  });

  it("should use Evidence Mode with smart.finding() and smart.comparePages()", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/compare/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("smart.finding(");
    expect(content).toContain("smart.findings()");
    expect(content).toContain("smart.comparePages(");
  });

  it("should document all 11 dimensions", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/compare/SKILL.md"),
      "utf-8"
    );
    for (const dim of [
      "framework",
      "performance",
      "security",
      "seo",
      "accessibility",
      "error-surface",
      "third-party-load",
      "architecture",
      "content-delivery",
      "mobile-readiness",
      "data-structure",
    ]) {
      expect(content).toContain(dim);
    }
  });
});
