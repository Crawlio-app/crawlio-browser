import { describe, expect, it } from "vitest";
import {
  assertGroundingResult,
  createHeuristicProvider,
  noopProvider,
  validateGroundingContext,
  validateProviderDescriptor,
} from "../../../packages/semantic-grounding/src/index.js";

describe("@crawlio/semantic-grounding contract", () => {
  it("validates provider descriptors", () => {
    expect(validateProviderDescriptor(noopProvider).valid).toBe(true);
    expect(validateProviderDescriptor({ id: "", kind: "cloud", modelVersion: "", capabilities: [] }).valid).toBe(false);
  });

  it("validates grounding contexts", () => {
    expect(validateGroundingContext({
      candidateActions: [{ ref: "e1", role: "button", name: "Continue" }],
      evidenceRefs: ["snapshot:e1"],
    }).valid).toBe(true);
    expect(validateGroundingContext({ candidateActions: [{ role: "button" }] }).valid).toBe(false);
  });

  it("no-op provider returns a schema-valid result", async () => {
    const result = await noopProvider.ground!("anything", { evidenceRefs: ["ev_1"] });
    assertGroundingResult(result);
    expect(result.evidenceRefs).toEqual(["ev_1"]);
  });

  it("heuristic provider grounds accessible-name candidates", async () => {
    const provider = createHeuristicProvider();
    const result = await provider.ground!("continue", {
      candidateActions: [
        { ref: "e1", role: "button", name: "Cancel" },
        { ref: "e2", role: "button", name: "Continue checkout", evidenceRefs: ["snapshot:e2"] },
      ],
    });
    assertGroundingResult(result);
    expect(result.provider).toBe("crawlio-heuristic");
    expect((result.output as { candidates: Array<{ ref: string }> }).candidates[0]?.ref).toBe("e2");
    expect(result.evidenceRefs).toContain("snapshot:e2");
  });
});
