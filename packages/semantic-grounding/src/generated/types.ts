/**
 * Generated from packages/semantic-grounding/contract/*.schema.json.
 * Keep this file schema-shaped; implementation helpers belong outside generated/.
 */

export type ProviderKind = "ane" | "onnx" | "heuristic" | "llm";

export type ProviderCapability = "embed" | "classify" | "rerank" | "ground" | "reason";

export interface SemanticGroundingProviderDescriptor {
  id: string;
  kind: ProviderKind;
  modelVersion: string;
  adapterId?: string;
  capabilities: ProviderCapability[];
}

export interface GroundingActionCandidate {
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  evidenceRefs?: string[];
  [key: string]: unknown;
}

export interface GroundingContext {
  pageSnapshot?: string | Record<string, unknown>;
  frameworkState?: unknown;
  hydrationPayload?: unknown;
  networkObservations?: unknown[];
  apiObservations?: unknown[];
  candidateActions?: GroundingActionCandidate[];
  evidenceRefs?: string[];
  [key: string]: unknown;
}

export interface GroundingResult {
  provider: string;
  kind: ProviderKind;
  modelVersion: string;
  adapterId?: string;
  confidence: number;
  output: unknown;
  evidenceRefs: string[];
  routedBecause: string;
}
