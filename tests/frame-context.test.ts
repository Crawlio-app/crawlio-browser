import { describe, it, expect } from "vitest";
import { buildEvalParams } from "../src/shared/frame-context";

describe("buildEvalParams", () => {
  it("should return base params when activeFrameId is null", () => {
    const params = buildEvalParams("1+1", null, undefined);
    expect(params).toEqual({
      expression: "1+1",
      returnByValue: true,
    });
  });

  it("should default returnByValue to true", () => {
    const params = buildEvalParams("1+1", null, undefined);
    expect(params.returnByValue).toBe(true);
  });

  it("should allow returnByValue to be set to false", () => {
    const params = buildEvalParams("document.body", null, undefined, { returnByValue: false });
    expect(params.returnByValue).toBeUndefined();
  });

  it("should set awaitPromise when specified", () => {
    const params = buildEvalParams("new Promise(r => r(1))", null, undefined, { awaitPromise: true });
    expect(params).toEqual({
      expression: "new Promise(r => r(1))",
      returnByValue: true,
      awaitPromise: true,
    });
  });

  it("should not set awaitPromise when not specified", () => {
    const params = buildEvalParams("1+1", null, undefined);
    expect(params.awaitPromise).toBeUndefined();
  });

  it("should inject contextId when activeFrameId is set and context exists", () => {
    const params = buildEvalParams("1+1", "frame-123", 42);
    expect(params).toEqual({
      expression: "1+1",
      returnByValue: true,
      contextId: 42,
    });
  });

  it("should omit contextId when activeFrameId is set but no context found", () => {
    const params = buildEvalParams("1+1", "frame-123", undefined);
    expect(params).toEqual({
      expression: "1+1",
      returnByValue: true,
    });
    expect(params.contextId).toBeUndefined();
  });

  it("should respect useFrameContext: false override", () => {
    const params = buildEvalParams("1+1", "frame-123", 42, { useFrameContext: false });
    expect(params).toEqual({
      expression: "1+1",
      returnByValue: true,
    });
    expect(params.contextId).toBeUndefined();
  });

  it("should default useFrameContext to true", () => {
    const params = buildEvalParams("1+1", "frame-123", 42);
    expect(params.contextId).toBe(42);
  });

  it("should combine all options correctly", () => {
    const params = buildEvalParams(
      "await fetch('/api')",
      "frame-456",
      99,
      { returnByValue: false, awaitPromise: true }
    );
    expect(params).toEqual({
      expression: "await fetch('/api')",
      awaitPromise: true,
      contextId: 99,
    });
  });
});
