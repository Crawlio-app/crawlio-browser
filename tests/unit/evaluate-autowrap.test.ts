import { describe, it, expect } from "vitest";
import { wrapEvaluateExpression } from "../../src/mcp-server/tools";
import { buildDetectTablesJs, buildExtractTableJs, buildDetectSectionsJs } from "../../src/mcp-server/extraction-js";

// CDP's Runtime.evaluate takes an expression, so a bare top-level `return` must be wrapped.
// Wrapping something that is ALREADY an expression is the dangerous direction: the wrapper
// has no return of its own, so an IIFE's value would be silently discarded.
describe("wrapEvaluateExpression", () => {
  it("should wrap a bare top-level return", () => {
    expect(wrapEvaluateExpression("return document.title"))
      .toBe("(async () => { return document.title })()");
  });

  it("should still wrap when a block comment precedes the return", () => {
    // A prefix test on "/*" alone would skip the wrap here, leaving an illegal top-level
    // `return` in expression position.
    const out = wrapEvaluateExpression("/* pick the title */ return document.title");
    expect(out).toContain("(async () => {");
    expect(out).toContain("return document.title");
  });

  it("should still wrap after a line comment", () => {
    expect(wrapEvaluateExpression("// grab it\nreturn document.title")).toContain("(async () => {");
  });

  it("should still wrap after several stacked comments", () => {
    const out = wrapEvaluateExpression("// one\n/* two */\n// three\nreturn 1");
    expect(out).toContain("(async () => {");
  });

  it("should not wrap an already-parenthesized expression", () => {
    const program = "(() => { return 1 })()";
    expect(wrapEvaluateExpression(program)).toBe(program);
  });

  it("should leave an expression with no return untouched", () => {
    expect(wrapEvaluateExpression("document.title")).toBe("document.title");
  });

  it("should not wrap any generated extraction program", () => {
    // These are sentinel-prefixed IIFEs. If the wrapper swallowed their value, every
    // table/section call would return undefined.
    const programs = [
      buildDetectTablesJs({ maxCandidates: 5 }),
      buildDetectSectionsJs({ maxDepth: 2 }),
      buildExtractTableJs("div.grid", { maxRows: 200 }),
    ];
    for (const program of programs) {
      expect(wrapEvaluateExpression(program)).toBe(program);
    }
  });
});
