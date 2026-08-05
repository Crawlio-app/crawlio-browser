import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeEvidence, readEvidence } from "../../src/evidence/store.js";
import { wrapEvidence } from "../../src/evidence/wrap.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceEnvelope } from "../../src/evidence/schema.js";
import type {
  TestSuite,
  TestAudit,
  TestFlow,
} from "../../src/shared/evidence-types.js";

// ── Factory Functions ──────────────────────────────────────────

function makeAudit(overrides?: Partial<TestAudit>): TestAudit {
  return {
    category: "accessibility",
    name: "Images have alt text",
    status: "pass",
    score: 100,
    details: "All 5 images have alt attributes",
    recommendation: null,
    evidence: [],
    ...overrides,
  };
}

function makeFlow(overrides?: Partial<TestFlow>): TestFlow {
  return {
    name: "Login flow",
    steps: ["Navigate to /login", "Fill email field", "Fill password field", "Click submit"],
    status: "discovered",
    url: "https://example.com/login",
    method: "form detection",
    ...overrides,
  };
}

function makeTestSuite(overrides?: Partial<TestSuite>): TestSuite {
  return {
    url: "https://example.com",
    audits: [
      makeAudit(),
      makeAudit({
        category: "performance",
        name: "LCP under 2.5s",
        status: "pass",
        score: 100,
        details: "LCP: 1.8s",
      }),
      makeAudit({
        category: "security",
        name: "HTTPS enforced",
        status: "pass",
        score: 100,
        details: "Page served over HTTPS",
      }),
      makeAudit({
        category: "seo",
        name: "Has title tag",
        status: "pass",
        score: 100,
        details: "Title: Example Domain",
      }),
      makeAudit({
        category: "best-practices",
        name: "Has viewport meta",
        status: "pass",
        score: 100,
        details: "viewport meta tag present",
      }),
    ],
    flows: [makeFlow()],
    summary: {
      totalTests: 5,
      passed: 5,
      failed: 0,
      warnings: 0,
      score: 100,
    },
    ...overrides,
  };
}

// ── TestSuite Type Validation ─────────────────────────────────

describe("TestSuite type validation", () => {
  it("should have required fields", () => {
    const suite = makeTestSuite();
    expect(suite.url).toBe("https://example.com");
    expect(suite.audits).toHaveLength(5);
    expect(suite.flows).toHaveLength(1);
    expect(suite.summary.totalTests).toBe(5);
    expect(suite.summary.passed).toBe(5);
    expect(suite.summary.failed).toBe(0);
    expect(suite.summary.warnings).toBe(0);
    expect(suite.summary.score).toBe(100);
  });

  it("should handle all audit categories", () => {
    const suite = makeTestSuite();
    const categories = suite.audits.map(a => a.category);
    expect(categories).toContain("accessibility");
    expect(categories).toContain("performance");
    expect(categories).toContain("security");
    expect(categories).toContain("seo");
    expect(categories).toContain("best-practices");
  });

  it("should handle perfect page (all pass)", () => {
    const suite = makeTestSuite();
    expect(suite.summary.score).toBe(100);
    expect(suite.summary.passed).toBe(5);
    expect(suite.summary.failed).toBe(0);
  });

  it("should handle broken page (all fail)", () => {
    const suite = makeTestSuite({
      audits: [
        makeAudit({ status: "fail", score: 0, category: "accessibility" }),
        makeAudit({ status: "fail", score: 0, category: "performance" }),
        makeAudit({ status: "fail", score: 0, category: "security" }),
        makeAudit({ status: "fail", score: 0, category: "seo" }),
        makeAudit({ status: "fail", score: 0, category: "best-practices" }),
      ],
      summary: { totalTests: 5, passed: 0, failed: 5, warnings: 0, score: 0 },
    });
    expect(suite.summary.score).toBe(0);
    expect(suite.summary.failed).toBe(5);
    expect(suite.summary.passed).toBe(0);
  });

  it("should handle partial data with skipped audits", () => {
    const suite = makeTestSuite({
      audits: [
        makeAudit({ status: "pass", score: 100 }),
        makeAudit({ status: "skip", score: null, category: "performance" }),
        makeAudit({ status: "warning", score: 50, category: "security" }),
      ],
      summary: { totalTests: 2, passed: 1, failed: 0, warnings: 1, score: 75 },
    });
    expect(suite.summary.totalTests).toBe(2); // excluding skipped
    expect(suite.audits).toHaveLength(3);
    const skipped = suite.audits.find(a => a.status === "skip");
    expect(skipped?.score).toBeNull();
  });

  it("should handle empty audits and flows", () => {
    const suite = makeTestSuite({
      audits: [],
      flows: [],
      summary: { totalTests: 0, passed: 0, failed: 0, warnings: 0, score: 0 },
    });
    expect(suite.audits).toHaveLength(0);
    expect(suite.flows).toHaveLength(0);
  });
});

// ── TestAudit Validation ──────────────────────────────────────

describe("TestAudit type validation", () => {
  it("should support all statuses", () => {
    const statuses = ["pass", "fail", "warning", "skip"] as const;
    for (const status of statuses) {
      const audit = makeAudit({ status, score: status === "skip" ? null : 50 });
      expect(audit.status).toBe(status);
    }
  });

  it("should support all categories", () => {
    const categories = ["accessibility", "performance", "security", "seo", "best-practices"] as const;
    for (const category of categories) {
      const audit = makeAudit({ category });
      expect(audit.category).toBe(category);
    }
  });

  it("should hold recommendations", () => {
    const audit = makeAudit({
      status: "fail",
      score: 0,
      recommendation: "Add alt text to all images",
    });
    expect(audit.recommendation).toBe("Add alt text to all images");
  });

  it("should hold evidence references", () => {
    const audit = makeAudit({
      evidence: ["ev_crawl_1", "ev_analyze_1"],
    });
    expect(audit.evidence).toHaveLength(2);
    expect(audit.evidence).toContain("ev_crawl_1");
  });
});

// ── TestFlow Validation ───────────────────────────────────────

describe("TestFlow type validation", () => {
  it("should support all flow statuses", () => {
    const statuses = ["discovered", "tested", "failed"] as const;
    for (const status of statuses) {
      const flow = makeFlow({ status });
      expect(flow.status).toBe(status);
    }
  });

  it("should track discovery method", () => {
    const flow = makeFlow({ method: "nav-link analysis" });
    expect(flow.method).toBe("nav-link analysis");
  });

  it("should hold step descriptions", () => {
    const flow = makeFlow({
      steps: ["Navigate to /search", "Type query", "Press enter", "Verify results"],
    });
    expect(flow.steps).toHaveLength(4);
    expect(flow.steps[0]).toBe("Navigate to /search");
  });
});

// ── Test Loop Definition ──────────────────────────────────────

// ── writeEvidence with TestSuite ──────────────────────────────

describe("writeEvidence with TestSuite", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "test-suite-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should write and read a TestSuite envelope", async () => {
    const suite = makeTestSuite();
    const envelope: EvidenceEnvelope<TestSuite> = {
      evidenceId: "ev_test_suite1",
      type: "test-suite",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-auditor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "Automated audit from captured page evidence",
      },
      gaps: [],
      quality: "complete",
      payload: suite,
      createdAt: new Date().toISOString(),
      parentId: "ev_crawl_1",
    };

    const path = await writeEvidence(envelope, tmpDir);
    expect(path).toContain("ev_test_suite1.json");

    const read = await readEvidence<TestSuite>("ev_test_suite1", tmpDir);
    expect(read.type).toBe("test-suite");
    expect(read.payload.url).toBe("https://example.com");
    expect(read.payload.audits).toHaveLength(5);
    expect(read.payload.flows).toHaveLength(1);
    expect(read.payload.summary.score).toBe(100);
  });

  it("should derive partial quality when gaps exist", async () => {
    const suite = makeTestSuite({
      audits: [makeAudit()],
      summary: { totalTests: 1, passed: 1, failed: 0, warnings: 0, score: 100 },
    });
    const envelope: EvidenceEnvelope<TestSuite> = {
      evidenceId: "ev_test_suite2",
      type: "test-suite",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-auditor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "Partial audit — performance data missing",
      },
      gaps: [
        {
          dimension: "performance",
          reason: "No performance metrics in page capture",
          impact: "data-absent",
          reducesConfidence: true,
        },
      ],
      quality: "partial",
      payload: suite,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<TestSuite>("ev_test_suite2", tmpDir);
    expect(read.quality).toBe("partial");
    expect(read.gaps.length).toBeGreaterThanOrEqual(1);
  });

  it("should use wrapEvidence to create a test-suite envelope", () => {
    const suite = makeTestSuite();
    const envelope = wrapEvidence({
      type: "test-suite",
      url: "https://example.com",
      payload: suite,
      provenance: { source: "inferred", tool: "crawlio-auditor" },
      confidence: {
        level: "high",
        basis: "Full page capture with all audit data available",
      },
      parentId: "ev_crawl_1",
    });

    expect(envelope.type).toBe("test-suite");
    expect(envelope.evidenceId).toMatch(/^ev_/);
    expect(envelope.payload.url).toBe("https://example.com");
    expect(envelope.payload.audits).toHaveLength(5);
    expect(envelope.parentId).toBe("ev_crawl_1");
    expect(envelope.quality).toBe("partial");
  });

  it("should handle suite with only warnings", async () => {
    const suite = makeTestSuite({
      audits: [
        makeAudit({ status: "warning", score: 50, category: "accessibility" }),
        makeAudit({ status: "warning", score: 50, category: "security" }),
      ],
      summary: { totalTests: 2, passed: 0, failed: 0, warnings: 2, score: 50 },
    });
    const envelope: EvidenceEnvelope<TestSuite> = {
      evidenceId: "ev_test_warnings",
      type: "test-suite",
      url: "https://example.com",
      provenance: {
        source: "inferred",
        tool: "crawlio-auditor",
        timestamp: new Date().toISOString(),
      },
      confidence: {
        level: "medium",
        basis: "Automated audit",
      },
      gaps: [],
      quality: "complete",
      payload: suite,
      createdAt: new Date().toISOString(),
    };

    await writeEvidence(envelope, tmpDir);
    const read = await readEvidence<TestSuite>("ev_test_warnings", tmpDir);
    expect(read.payload.summary.warnings).toBe(2);
    expect(read.payload.summary.score).toBe(50);
  });
});

// ── Skill Entry Point ──────────────────────────────────────────

describe("test skill entry point", () => {
  it("should exist with correct frontmatter", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/test/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("name: test");
    expect(content).toContain(
      "allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab"
    );
  });

  it("should use Evidence Mode with smart.finding() and smart.extractPage()", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/test/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("smart.finding(");
    expect(content).toContain("smart.findings()");
    expect(content).toContain("smart.extractPage()");
  });

  it("should describe audit categories", async () => {
    const content = await readFile(
      join(process.cwd(), "skills/test/SKILL.md"),
      "utf-8"
    );
    expect(content).toContain("accessibility");
    expect(content).toContain("performance");
    expect(content).toContain("security");
  });
});
