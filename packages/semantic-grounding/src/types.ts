import type {
  GroundingActionCandidate,
  GroundingContext,
  GroundingResult,
  ProviderCapability,
  ProviderKind,
  SemanticGroundingProviderDescriptor,
} from "./generated/types.js";

export type {
  GroundingActionCandidate,
  GroundingContext,
  GroundingResult,
  ProviderCapability,
  ProviderKind,
  SemanticGroundingProviderDescriptor,
};

export interface EmbedResult {
  vectors: number[][];
  dim: number;
  provider: string;
  modelVersion: string;
}

export interface RankedLabel {
  label: string;
  score: number;
}

export interface ClassifyOutput {
  ranked: RankedLabel[];
}

export interface RerankCandidate {
  id: string;
  text: string;
  evidenceRefs?: string[];
}

export interface RankedCandidate {
  id: string;
  score: number;
}

export interface RerankOutput {
  ranked: RankedCandidate[];
}

export interface GroundedCandidate {
  ref: string;
  score: number;
  why: string;
  evidenceRefs?: string[];
}

export interface GroundOutput {
  candidates: GroundedCandidate[];
}

export interface SemanticGroundingProvider extends SemanticGroundingProviderDescriptor {
  isAvailable?(): Promise<boolean> | boolean;
  embed?(texts: string[]): Promise<GroundingResult>;
  classify?(input: string, labels: string[]): Promise<GroundingResult>;
  rerank?(query: string, candidates: RerankCandidate[]): Promise<GroundingResult>;
  ground?(query: string, context: GroundingContext): Promise<GroundingResult>;
}

export type GroundingOperation = "embed" | "classify" | "rerank" | "ground";

export const PROVIDER_PRECEDENCE: ProviderKind[] = ["ane", "onnx", "heuristic", "llm"];
