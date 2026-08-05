import { describe, it, expect } from "vitest";
import {
  buildDetectTablesJs, buildExtractTableJs, buildDetectSectionsJs,
  MAX_EXTRACTION_PROGRAM_CHARS,
} from "../../src/mcp-server/extraction-js";
import { MAX_EVAL_EXPRESSION_LENGTH } from "../../src/shared/protocol";

const U2028 = " ";
const U2029 = " ";

// The selector reaches these builders from tool input and is embedded into JavaScript
// source that runs in the page. Nothing in it may terminate the string literal, close the
// IIFE, or change how the program parses.
describe("generated program escaping", () => {
  const hostile: Record<string, string> = {
    doubleQuote: 'div[a="x"]',
    singleQuote: "div[a='x']",
    backslash: "div\\x",
    scriptClose: "div</script><script>alert(1)</script>",
    backtick: "div`${alert(1)}`",
    dollarBrace: "div${alert(1)}",
    newline: "div\n;alert(1);//",
    carriageReturn: "div\r;alert(1);//",
    lineSeparator: `div${U2028};alert(1);//`,
    paragraphSeparator: `div${U2029};alert(1);//`,
    closeParen: "div) ;alert(1); (",
    commentOpen: "div/*",
    commentClose: "div*/",
  };

  for (const [name, selector] of Object.entries(hostile)) {
    it(`should produce a parseable program for a ${name} selector`, () => {
      const program = buildExtractTableJs(selector, { maxRows: 5 });
      expect(() => new Function(program)).not.toThrow();
    });
  }

  it("should never emit a raw JS line terminator", () => {
    // U+2028/U+2029 are valid JSON but are line terminators in JavaScript source, so
    // JSON.stringify alone leaves the program at the mercy of the parsing engine.
    const program = buildExtractTableJs(`div${U2028}${U2029}x`, { maxRows: 5 });
    expect(program).not.toContain(U2028);
    expect(program).not.toContain(U2029);
    expect(program).toContain("\\u2028");
    expect(program).toContain("\\u2029");
  });

  it("should embed a hostile selector as data, never as code", () => {
    // A text assertion cannot prove this: the payload legitimately appears inside the
    // escaped literal. Running the program is the proof — if escaping failed, the injected
    // assignment would execute.
    const selector = 'div"); window.__pwned = 1; ("';
    const program = buildExtractTableJs(selector, { maxRows: 5 });
    expect(program).toContain(JSON.stringify(selector));

    const win: Record<string, unknown> = {};
    const doc = {
      querySelector: () => null,
      querySelectorAll: () => [],
      body: null,
      documentElement: null,
    };
    const run = new Function("document", "window", "CSS", `return ${program};`);
    expect(() => run(doc, win, { escape: (s: string) => s })).not.toThrow();
    expect(win.__pwned).toBeUndefined();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("should stay within the compatibility budget for realistic selectors", () => {
    // The selector schema allows 1000 chars; quotes and backslashes double under escaping,
    // which is the worst case any real CSS selector can reach.
    for (const selector of ['"'.repeat(1000), "\\".repeat(1000), "d".repeat(1000)]) {
      const program = buildExtractTableJs(selector, { maxRows: 1000 });
      expect(program.length, `produced ${program.length}`).toBeLessThan(MAX_EXTRACTION_PROGRAM_CHARS);
    }
  });

  it("should stay within the enforced cap even for a pathological selector", () => {
    // Line separators expand six-fold when escaped (1 char to "\\u2028"), so a selector made
    // entirely of them exceeds the older-extension compatibility budget. Escaping is still
    // the right trade: such a selector cannot occur in real CSS, and the program stays well
    // inside the cap that current extensions actually enforce — an older extension rejects
    // it with a clear "expression too long" error rather than mis-parsing it.
    const program = buildExtractTableJs(U2028.repeat(1000), { maxRows: 1000 });
    expect(program.length).toBeGreaterThan(MAX_EXTRACTION_PROGRAM_CHARS);
    expect(program.length).toBeLessThan(MAX_EVAL_EXPRESSION_LENGTH);
    expect(() => new Function(program)).not.toThrow();
  });

  it("should keep every builder parseable and within budget at default options", () => {
    for (const program of [buildDetectTablesJs({}), buildDetectSectionsJs({}), buildExtractTableJs("div", {})]) {
      expect(() => new Function(program)).not.toThrow();
      expect(program.length).toBeLessThan(MAX_EXTRACTION_PROGRAM_CHARS);
    }
  });
});
