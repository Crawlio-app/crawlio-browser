// ── Platform Evidence Envelope ──────────────────────────────────

export type ProvenanceSource = "browser" | "crawl" | "network" | "inferred" | "user";

export interface Provenance {
  source: ProvenanceSource;
  tool: string;           // MCP tool or method that produced this evidence
  timestamp: string;      // ISO 8601
  sessionId?: string;     // Links evidence to a specific investigation session
}

export type ConfidenceLevel = "high" | "medium" | "low" | "speculative";

export interface Confidence {
  level: ConfidenceLevel;
  basis: string;          // Why this confidence level (e.g., "direct DOM observation")
  cappedBy?: string;      // What reduced confidence (e.g., "enrichment timeout")
}

export interface EvidenceGap {
  dimension: string;      // What's missing (e.g., "performance", "security")
  reason: string;         // Why it's missing
  impact: "data-absent" | "data-stale" | "method-failed" | "timeout";
  reducesConfidence: boolean;
}

export interface EvidenceMetadata {
  writtenVia: "wrapEvidence";           // Proves evidence was created through the typed API
  validatedBy?: "writeEvidence";        // Proves evidence was persisted through the validated store
  runId?: string;                       // Groups evidence from the same pipeline run
  version: "1.0";
}

export interface EvidenceEnvelope<T> {
  evidenceId: string;     // Unique ID: ev_<timestamp>_<random>
  type: string;           // Discriminant: "page", "framework", "comparison", etc.
  url: string;            // Target URL this evidence relates to
  provenance: Provenance;
  confidence: Confidence;
  gaps: EvidenceGap[];
  quality: "complete" | "partial" | "degraded" | "unavailable";
  payload: T;             // The actual evidence data
  createdAt: string;      // ISO 8601
  parentId?: string;      // Links to parent evidence (for derived evidence)
  metadata?: EvidenceMetadata;
}

// ── Evidence Type Registry ──────────────────────────────────────
// Maps discriminant strings to payload types for type-safe dispatch

export type EvidenceTypeMap = {
  page: import("../shared/evidence-types.js").PageEvidence;
  comparison: import("../shared/evidence-types.js").ComparisonEvidence;
  finding: import("../shared/evidence-types.js").Finding;
  scroll: import("../shared/evidence-types.js").ScrollEvidence;
  table: import("../shared/evidence-types.js").TableExtraction;
  data: import("../shared/evidence-types.js").DataExtraction;
  trace: import("../shared/evidence-types.js").MethodTrace;
  gap: import("../shared/evidence-types.js").CoverageGap;
  framework: import("../shared/evidence-types.js").FrameworkEvidence;
  apimap: import("../shared/evidence-types.js").APIMap;
  blueprint: import("../shared/evidence-types.js").TechBlueprint;
  monitor: import("../shared/evidence-types.js").DiffReport;
  design: import("../shared/evidence-types.js").DesignTokens;
  auth: import("../shared/evidence-types.js").AuthFlow;
  "comparison-report": import("../shared/evidence-types.js").ComparisonReport;
  clone: import("../shared/evidence-types.js").CloneBlueprint;
  "test-suite": import("../shared/evidence-types.js").TestSuite;
  dossier: import("../shared/evidence-types.js").CompetitiveDossier;
  "traffic_analysis": import("../shared/evidence-types.js").TrafficAnalysis;
};

export type EvidenceType = keyof EvidenceTypeMap;
