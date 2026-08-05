import { describe, expect, it } from "vitest";
import {
  SemanticGroundingRouter,
  type GroundingResult,
  type ProviderKind,
  type SemanticGroundingProvider,
} from "../../../packages/semantic-grounding/src/index.js";

function result(kind: ProviderKind, provider: string): GroundingResult {
  return {
    provider,
    kind,
    modelVersion: `${provider}-1`,
    confidence: 0.9,
    output: { candidates: [{ ref: provider, score: 0.9, why: "test" }] },
    evidenceRefs: [`ev_${provider}`],
    routedBecause: `${provider} test route`,
  };
}

function provider(kind: ProviderKind, available: boolean): SemanticGroundingProvider {
  return {
    id: kind,
    kind,
    modelVersion: `${kind}-1`,
    capabilities: ["classify", "ground"],
    isAvailable: () => available,
    classify: async () => result(kind, kind),
    ground: async () => result(kind, kind),
  };
}

describe("SemanticGroundingRouter", () => {
  it("routes by ANE -> ONNX -> heuristic precedence", async () => {
    const router = new SemanticGroundingRouter({
      providers: [provider("heuristic", true), provider("onnx", true), provider("ane", false)],
    });
    const routed = await router.ground("submit", { candidateActions: [{ ref: "e1", name: "Submit" }] });
    expect(routed.kind).toBe("onnx");
  });

  it("prefers ANE when available", async () => {
    const router = new SemanticGroundingRouter({
      providers: [provider("heuristic", true), provider("onnx", true), provider("ane", true)],
    });
    const routed = await router.classify("checkout", ["checkout", "docs"]);
    expect(routed.kind).toBe("ane");
  });

  it("falls back to heuristic when accelerators are absent", async () => {
    const router = new SemanticGroundingRouter({
      providers: [provider("heuristic", true), provider("onnx", false), provider("ane", false)],
    });
    const routed = await router.ground("submit", { candidateActions: [{ ref: "e1", name: "Submit" }] });
    expect(routed.kind).toBe("heuristic");
    expect(routed.routedBecause).toContain("test route");
  });

  it("continues to the next provider when an available accelerator fails", async () => {
    const failingAne: SemanticGroundingProvider = {
      id: "ane",
      kind: "ane",
      modelVersion: "ane-1",
      capabilities: ["ground"],
      isAvailable: () => true,
      ground: async () => { throw new Error("daemon handshake failed"); },
    };
    const router = new SemanticGroundingRouter({
      providers: [provider("heuristic", true), failingAne],
    });
    const routed = await router.ground("submit", { candidateActions: [{ ref: "e1", name: "Submit" }] });
    expect(routed.kind).toBe("heuristic");
  });
});
