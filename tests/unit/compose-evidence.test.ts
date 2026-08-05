import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeEvidence, readEvidence } from "../../src/evidence/store.js";
import { wrapEvidence } from "../../src/evidence/wrap.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEnvelope } from "../../src/evidence/schema.js";
import type {
  CompetitiveDossier,
  DossierRecommendation,
  Finding,
} from "../../src/shared/evidence-types.js";

// ── Factory Functions ──────────────────────────────────────────

function makeFinding(overrides?: Partial<Finding>): Finding {
  return {
    claim: "Site uses React 18 with SSR",
    evidence: ["ev_crawl_1", "ev_analyze_1"],
    sourceUrl: "https://example.com",
    confidence: "high",
    method: "framework detection",
    ...overrides,
  };
}

function makeRecommendation(
  overrides?: Partial<DossierRecommendation>
): DossierRecommendation {
  return {
    priority: "medium",
    category: "performance",
    action: "Optimize LCP by lazy-loading below-the-fold images",
    evidence: ["ev_blueprint_1"],
    ...overrides,
  };
}

function makeDossier(
  overrides?: Partial<CompetitiveDossier>
): CompetitiveDossier {
  return {
    url: "https://example.com",
    generatedAt: "2026-03-12T00:00:00.000Z",
    sections: {
      techBlueprint: "ev_blueprint_1",
      testResults: "ev_audit_1",
      extractedData: ["ev_design_1"],
      comparisons: [],
    },
    executiveSummary:
      "Example.com runs React 18 with SSR. Performance is good but security headers are missing.",
    strengths: [
      makeFinding({ claim: "Modern framework with SSR" }),
      makeFinding({ claim: "Fast LCP at 1.2s", confidence: "high" }),
    ],
    weaknesses: [
      makeFinding({
        claim: "Missing CSP and HSTS headers",
        confidence: "high",
        method: "security audit",
      }),
    ],
    opportunities: [
      makeFinding({
        claim: "Could add service worker for offline support",
        confidence: "medium",
        method: "architecture analysis",
      }),
    ],
    recommendations: [
      makeRecommendation({
        priority: "critical",
        category: "security",
        action: "Add Content-Security-Policy header",
      }),
      makeRecommendation({
        priority: "high",
        category: "security",
        action: "Enable HSTS with includeSubDomains",
      }),
      makeRecommendation({
        priority: "medium",
        category: "performance",
        action: "Lazy-load below-the-fold images",
      }),
      makeRecommendation({
        priority: "low",
        category: "seo",
        action: "Add structured data markup",
      }),
    ],
    evidenceChain: [
      "ev_crawl_1",
      "ev_analyze_1",
      "ev_blueprint_1",
      "ev_audit_1",
      "ev_design_1",
    ],
    familiesExecuted: ["investigate", "test", "extract"],
    ...overrides,
  };
}

// ── CompetitiveDossier Type Validation ────────────────────────

describe("CompetitiveDossier type validation", () => {
  it("should have required fields", () => {
    const dossier = makeDossier();
    expect(dossier.url).toBe("https://example.com");
    expect(dossier.generatedAt).toBe("2026-03-12T00:00:00.000Z");
    expect(dossier.executiveSummary).toBeTruthy();
    expect(dossier.strengths.length).toBeGreaterThan(0);
    expect(dossier.weaknesses.length).toBeGreaterThan(0);
    expect(dossier.opportunities.length).toBeGreaterThan(0);
    expect(dossier.recommendations.length).toBeGreaterThan(0);
    expect(dossier.evidenceChain.length).toBeGreaterThan(0);
    expect(dossier.familiesExecuted.length).toBeGreaterThan(0);
  });

  it("should have sections referencing evidence IDs", () => {
    const dossier = makeDossier();
    expect(dossier.sections.techBlueprint).toBe("ev_blueprint_1");
    expect(dossier.sections.testResults).toBe("ev_audit_1");
    expect(dossier.sections.extractedData).toContain("ev_design_1");
    expect(dossier.sections.comparisons).toHaveLength(0);
  });

  it("should handle null sections when families fail", () => {
    const dossier = makeDossier({
      sections: {
        techBlueprint: "ev_blueprint_1",
        testResults: null,
        extractedData: [],
        comparisons: [],
      },
      familiesExecuted: ["investigate"],
    });
    expect(dossier.sections.testResults).toBeNull();
    expect(dossier.sections.extractedData).toHaveLength(0);
    expect(dossier.familiesExecuted).toEqual(["investigate"]);
  });

  it("should handle all families succeeding", () => {
    const dossier = makeDossier({
      sections: {
        techBlueprint: "ev_blueprint_1",
        testResults: "ev_audit_1",
        extractedData: ["ev_design_1", "ev_api_1"],
        comparisons: ["ev_compare_1"],
      },
      familiesExecuted: ["investigate", "test", "extract", "compare"],
    });
    expect(dossier.sections.techBlueprint).toBeTruthy();
    expect(dossier.sections.testResults).toBeTruthy();
    expect(dossier.sections.extractedData).toHaveLength(2);
    expect(dossier.sections.comparisons).toHaveLength(1);
    expect(dossier.familiesExecuted).toHaveLength(4);
  });

  it("should handle empty strengths/weaknesses/opportunities", () => {
    const dossier = makeDossier({
      strengths: [],
      weaknesses: [],
      opportunities: [],
      recommendations: [],
    });
    expect(dossier.strengths).toHaveLength(0);
    expect(dossier.weaknesses).toHaveLength(0);
    expect(dossier.opportunities).toHaveLength(0);
    expect(dossier.recommendations).toHaveLength(0);
  });
});

// ── Recommendation Priority Ordering ─────────────────────────

describe("recommendation priority ordering", () => {
  const PRIORITY_ORDER = ["critical", "high", "medium", "low"] as const;

  it("should support all priority levels", () => {
    for (const priority of PRIORITY_ORDER) {
      const rec = makeRecommendation({ priority });
      expect(rec.priority).toBe(priority);
    }
  });

  it("should sort recommendations by priority", () => {
    const dossier = makeDossier();
    const priorities = dossier.recommendations.map((r) => r.priority);
    const sortedPriorities = [...priorities].sort(
      (a, b) => PRIORITY_ORDER.indexOf(a) - PRIORITY_ORDER.indexOf(b)
    );
    expect(priorities).toEqual(sortedPriorities);
  });

  it("should have category on each recommendation", () => {
    const dossier = makeDossier();
    for (const rec of dossier.recommendations) {
      expect(rec.category).toBeTruthy();
      expect(rec.action).toBeTruthy();
      expect(Array.isArray(rec.evidence)).toBe(true);
    }
  });
});

// ── Evidence Chain Aggregation ────────────────────────────────

describe("evidence chain aggregation", () => {
  it("should collect evidence IDs from all families", () => {
    const dossier = makeDossier();
    expect(dossier.evidenceChain).toContain("ev_crawl_1");
    expect(dossier.evidenceChain).toContain("ev_analyze_1");
    expect(dossier.evidenceChain).toContain("ev_blueprint_1");
    expect(dossier.evidenceChain).toContain("ev_audit_1");
    expect(dossier.evidenceChain).toContain("ev_design_1");
  });

  it("should handle single family evidence chain", () => {
    const dossier = makeDossier({
      evidenceChain: ["ev_crawl_1", "ev_analyze_1", "ev_blueprint_1"],
      familiesExecuted: ["investigate"],
    });
    expect(dossier.evidenceChain).toHaveLength(3);
  });

  it("should handle evidence chain with comparisons", () => {
    const dossier = makeDossier({
      evidenceChain: [
        "ev_crawl_1",
        "ev_crawl_2",
        "ev_compare_1",
        "ev_blueprint_1",
      ],
      sections: {
        techBlueprint: "ev_blueprint_1",
        testResults: null,
        extractedData: [],
        comparisons: ["ev_compare_1"],
      },
    });
    expect(dossier.evidenceChain).toHaveLength(4);
    expect(dossier.sections.comparisons).toContain("ev_compare_1");
  });
});

// ── Executive Summary ────────────────────────────────────────

describe("executive summary", () => {
  it("should be a non-empty string", () => {
    const dossier = makeDossier();
    expect(typeof dossier.executiveSummary).toBe("string");
    expect(dossier.executiveSummary.length).toBeGreaterThan(0);
  });

  it("should summarize key findings", () => {
    const dossier = makeDossier({
      executiveSummary:
        "Target site uses Next.js 14 with excellent performance (LCP 0.8s) but lacks security headers.",
    });
    expect(dossier.executiveSummary).toContain("Next.js");
    expect(dossier.executiveSummary).toContain("performance");
    expect(dossier.executiveSummary).toContain("security");
  });
});

// ── Compose Loop Definition ──────────────────────────────────

// ── writeEvidence with CompetitiveDossier ─────────────────────

describe("writeEvidence with CompetitiveDossier", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compose-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read a CompetitiveDossier envelope", async () => {
    const dossier = makeDossier();
    const envelope: EvidenceEnvelope<CompetitiveDossier> = {
      evidenceId: "ev_dossier_1",
      type: "dossier",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-composer",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "Synthesized from investigate + test + extract families",
      },
      gaps: [],
      quality: "complete",
      payload: dossier,
      createdAt: new Date().toISOString(),
    };

    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_dossier_1.json");

    const read = await readEvidence<CompetitiveDossier>(
      "ev_dossier_1",
      tmpDir
    );
    expect(read.type).toBe("dossier");
    expect(read.payload.url).toBe("https://example.com");
    expect(read.payload.strengths).toHaveLength(2);
    expect(read.payload.weaknesses).toHaveLength(1);
    expect(read.payload.recommendations).toHaveLength(4);
    expect(read.payload.familiesExecuted).toHaveLength(3);
  });

  it("should derive partial quality when gaps exist", async () => {
    const dossier = makeDossier({
      sections: {
        techBlueprint: "ev_blueprint_1",
        testResults: null,
        extractedData: [],
        comparisons: [],
      },
      familiesExecuted: ["investigate"],
    });
    const envelope: EvidenceEnvelope<CompetitiveDossier> = {
      evidenceId: "ev_dossier_partial",
      type: "dossier",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-composer",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "Only investigate family completed",
      },
      gaps: [
        {
          dimension: "test-results",
          reason: "Audit phase failed or timed out",
          impact: "method-failed",
          reducesConfidence: true,
        },
      ],
      quality: "partial",
      payload: dossier,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<CompetitiveDossier>(
      "ev_dossier_partial",
      tmpDir
    );
    expect(read.quality).toBe("degraded"); // method-failed → degraded
    expect(read.gaps.length).toBeGreaterThanOrEqual(1);
  });

  it("should use wrapEvidence to create a dossier envelope", () => {
    const dossier = makeDossier();
    const envelope = wrapEvidence({
      type: "dossier",
      url: "https://example.com",
      payload: dossier,
      provenance: { source: "inferred", tool: "crawlio-composer" },
      confidence: {
        level: "high",
        basis: "All families completed successfully",
      },
    });

    expect(envelope.type).toBe("dossier");
    expect(envelope.evidenceId).toMatch(/^ev_/);
    expect(envelope.payload.url).toBe("https://example.com");
    expect(envelope.payload.recommendations).toHaveLength(4);
    expect(envelope.quality).toBe("complete");
  });

  it("should handle dossier with only investigate family", async () => {
    const dossier = makeDossier({
      sections: {
        techBlueprint: "ev_blueprint_1",
        testResults: null,
        extractedData: [],
        comparisons: [],
      },
      strengths: [makeFinding()],
      weaknesses: [],
      opportunities: [],
      recommendations: [],
      evidenceChain: ["ev_crawl_1", "ev_blueprint_1"],
      familiesExecuted: ["investigate"],
    });

    const envelope: EvidenceEnvelope<CompetitiveDossier> = {
      evidenceId: "ev_dossier_minimal",
      type: "dossier",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-composer",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "low",
        basis: "Only investigate family ran — limited data",
      },
      gaps: [],
      quality: "partial",
      payload: dossier,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<CompetitiveDossier>(
      "ev_dossier_minimal",
      tmpDir
    );
    expect(read.payload.familiesExecuted).toEqual(["investigate"]);
    expect(read.payload.sections.testResults).toBeNull();
  });
});

// ── Skill Entry Point ────────────────────────────────────────

describe("dossier skill entry point", () => {
  it("should exist with correct frontmatter", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/dossier/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("name: dossier");
    expect(content).toContain(
      "allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab"
    );
  });

  it("should use Evidence Mode with smart.finding() and smart.comparePages()", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/dossier/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("smart.finding(");
    expect(content).toContain("smart.findings()");
    expect(content).toContain("smart.comparePages(");
  });

  it("should describe competitive comparison across dimensions", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/dossier/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("competitive");
    expect(content).toContain("competitors");
    expect(content).toContain("strengths");
    expect(content).toContain("weaknesses");
  });
});

// ── Composer Agent Definition ────────────────────────────────

// ── Investigator Agent Has Composer ──────────────────────────
