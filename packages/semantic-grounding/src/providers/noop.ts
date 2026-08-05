import type { GroundingContext, GroundingResult, SemanticGroundingProvider } from "../types.js";

export const noopProvider: SemanticGroundingProvider = {
  id: "crawlio-noop",
  kind: "heuristic",
  modelVersion: "noop-1.0.0",
  capabilities: ["embed", "classify", "rerank", "ground"],
  isAvailable: () => true,
  async embed(texts: string[]): Promise<GroundingResult> {
    return {
      provider: "crawlio-noop",
      kind: "heuristic",
      modelVersion: "noop-1.0.0",
      confidence: 0,
      output: { vectors: texts.map(() => []), dim: 0 },
      evidenceRefs: [],
      routedBecause: "noop provider returns schema-valid empty embeddings",
    };
  },
  async classify(_input: string, labels: string[]): Promise<GroundingResult> {
    return {
      provider: "crawlio-noop",
      kind: "heuristic",
      modelVersion: "noop-1.0.0",
      confidence: 0,
      output: { ranked: labels.map(label => ({ label, score: 0 })) },
      evidenceRefs: [],
      routedBecause: "noop provider returns schema-valid zero scores",
    };
  },
  async rerank(_query: string, candidates): Promise<GroundingResult> {
    return {
      provider: "crawlio-noop",
      kind: "heuristic",
      modelVersion: "noop-1.0.0",
      confidence: 0,
      output: { ranked: candidates.map(candidate => ({ id: candidate.id, score: 0 })) },
      evidenceRefs: candidates.flatMap(candidate => candidate.evidenceRefs ?? []),
      routedBecause: "noop provider returns schema-valid candidate order",
    };
  },
  async ground(_query: string, context: GroundingContext): Promise<GroundingResult> {
    return {
      provider: "crawlio-noop",
      kind: "heuristic",
      modelVersion: "noop-1.0.0",
      confidence: 0,
      output: { candidates: [] },
      evidenceRefs: context.evidenceRefs ?? [],
      routedBecause: "noop provider returns schema-valid empty grounding result",
    };
  },
};
