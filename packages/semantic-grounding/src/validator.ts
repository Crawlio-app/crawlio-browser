import type {
  GroundingContext,
  GroundingResult,
  ProviderCapability,
  ProviderKind,
  SemanticGroundingProviderDescriptor,
} from "./generated/types.js";

const providerKinds = new Set<ProviderKind>(["ane", "onnx", "heuristic", "llm"]);
const capabilities = new Set<ProviderCapability>(["embed", "classify", "rerank", "ground", "reason"]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string" && (record[key] as string).length > 0;
}

export function validateProviderDescriptor(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["provider must be an object"] };
  if (!hasString(value, "id")) errors.push("id must be a non-empty string");
  if (!hasString(value, "modelVersion")) errors.push("modelVersion must be a non-empty string");
  if (typeof value.kind !== "string" || !providerKinds.has(value.kind as ProviderKind)) {
    errors.push("kind must be one of ane|onnx|heuristic|llm");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    errors.push("capabilities must be a non-empty array");
  } else {
    for (const capability of value.capabilities) {
      if (typeof capability !== "string" || !capabilities.has(capability as ProviderCapability)) {
        errors.push(`unsupported capability: ${String(capability)}`);
      }
    }
  }
  if (value.adapterId !== undefined && !hasString(value, "adapterId")) {
    errors.push("adapterId must be a non-empty string when present");
  }
  return { valid: errors.length === 0, errors };
}

export function assertProviderDescriptor(value: unknown): asserts value is SemanticGroundingProviderDescriptor {
  const result = validateProviderDescriptor(value);
  if (!result.valid) throw new Error(`Invalid SemanticGroundingProvider: ${result.errors.join("; ")}`);
}

export function validateGroundingContext(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["context must be an object"] };
  if (value.pageSnapshot !== undefined && typeof value.pageSnapshot !== "string" && !isRecord(value.pageSnapshot)) {
    errors.push("pageSnapshot must be a string or object when present");
  }
  if (value.candidateActions !== undefined) {
    if (!Array.isArray(value.candidateActions)) {
      errors.push("candidateActions must be an array when present");
    } else {
      value.candidateActions.forEach((candidate, index) => {
        if (!isRecord(candidate)) {
          errors.push(`candidateActions[${index}] must be an object`);
        } else if (!hasString(candidate, "ref")) {
          errors.push(`candidateActions[${index}].ref must be a non-empty string`);
        }
      });
    }
  }
  if (value.evidenceRefs !== undefined && (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some(ref => typeof ref !== "string"))) {
    errors.push("evidenceRefs must be a string array when present");
  }
  return { valid: errors.length === 0, errors };
}

export function assertGroundingContext(value: unknown): asserts value is GroundingContext {
  const result = validateGroundingContext(value);
  if (!result.valid) throw new Error(`Invalid GroundingContext: ${result.errors.join("; ")}`);
}

export function validateGroundingResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["result must be an object"] };
  if (!hasString(value, "provider")) errors.push("provider must be a non-empty string");
  if (!hasString(value, "modelVersion")) errors.push("modelVersion must be a non-empty string");
  if (typeof value.kind !== "string" || !providerKinds.has(value.kind as ProviderKind)) {
    errors.push("kind must be one of ane|onnx|heuristic|llm");
  }
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }
  if (!("output" in value)) errors.push("output is required");
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some(ref => typeof ref !== "string")) {
    errors.push("evidenceRefs must be a string array");
  }
  if (!hasString(value, "routedBecause")) errors.push("routedBecause must be a non-empty string");
  if (value.adapterId !== undefined && !hasString(value, "adapterId")) {
    errors.push("adapterId must be a non-empty string when present");
  }
  return { valid: errors.length === 0, errors };
}

export function assertGroundingResult(value: unknown): asserts value is GroundingResult {
  const result = validateGroundingResult(value);
  if (!result.valid) throw new Error(`Invalid GroundingResult: ${result.errors.join("; ")}`);
}
