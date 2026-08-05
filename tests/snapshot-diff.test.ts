import { describe, it, expect } from "vitest";
import { myersDiff, diffSnapshots } from "../src/mcp-server/snapshot-diff.js";
describe("myersDiff", () => {
  it("returns empty array for two empty arrays", () => {
    expect(myersDiff([], [])).toEqual([]);
  });

  it("returns all equal for identical arrays", () => {
    const lines = ["a", "b", "c"];
    const result = myersDiff(lines, lines);
    expect(result).toEqual([
      { type: "equal", line: "a" },
      { type: "equal", line: "b" },
      { type: "equal", line: "c" },
    ]);
  });

  it("detects pure insertions", () => {
    const result = myersDiff([], ["x", "y"]);
    expect(result).toEqual([
      { type: "insert", line: "x" },
      { type: "insert", line: "y" },
    ]);
  });

  it("detects pure deletions", () => {
    const result = myersDiff(["x", "y"], []);
    expect(result).toEqual([
      { type: "delete", line: "x" },
      { type: "delete", line: "y" },
    ]);
  });

  it("handles insertions in the middle", () => {
    const a = ["a", "c"];
    const b = ["a", "b", "c"];
    const result = myersDiff(a, b);

    const types = result.map(e => e.type);
    expect(types).toContain("insert");

    const insertedLines = result.filter(e => e.type === "insert").map(e => e.line);
    expect(insertedLines).toContain("b");

    // a and c should be equal
    const equalLines = result.filter(e => e.type === "equal").map(e => e.line);
    expect(equalLines).toContain("a");
    expect(equalLines).toContain("c");
  });

  it("handles deletions in the middle", () => {
    const a = ["a", "b", "c"];
    const b = ["a", "c"];
    const result = myersDiff(a, b);

    const deletedLines = result.filter(e => e.type === "delete").map(e => e.line);
    expect(deletedLines).toContain("b");
  });

  it("handles modifications (delete + insert)", () => {
    const a = ["a", "b", "c"];
    const b = ["a", "x", "c"];
    const result = myersDiff(a, b);

    const equalLines = result.filter(e => e.type === "equal").map(e => e.line);
    expect(equalLines).toContain("a");
    expect(equalLines).toContain("c");

    const deletedLines = result.filter(e => e.type === "delete").map(e => e.line);
    expect(deletedLines).toContain("b");

    const insertedLines = result.filter(e => e.type === "insert").map(e => e.line);
    expect(insertedLines).toContain("x");
  });

  it("handles completely different arrays", () => {
    const a = ["a", "b"];
    const b = ["x", "y"];
    const result = myersDiff(a, b);

    const deletedLines = result.filter(e => e.type === "delete").map(e => e.line);
    const insertedLines = result.filter(e => e.type === "insert").map(e => e.line);

    expect(deletedLines).toEqual(expect.arrayContaining(["a", "b"]));
    expect(insertedLines).toEqual(expect.arrayContaining(["x", "y"]));
    expect(result.filter(e => e.type === "equal")).toHaveLength(0);
  });

  it("uses Int32Array for performance (large input)", () => {
    const a = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const b = [...a.slice(0, 50), "NEW", ...a.slice(51)];
    const result = myersDiff(a, b);

    expect(result.filter(e => e.type === "insert").map(e => e.line)).toContain("NEW");
    expect(result.filter(e => e.type === "delete").map(e => e.line)).toContain("line-50");
    expect(result.filter(e => e.type === "equal")).toHaveLength(99);
  });
});

describe("diffSnapshots", () => {
  it("returns no changes for identical snapshots", () => {
    const snapshot = "- document\n  - heading 'Hello'\n  - paragraph 'World'";
    const result = diffSnapshots(snapshot, snapshot);

    expect(result.changed).toBe(false);
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
    expect(result.unchanged).toBe(3);
  });

  it("returns correct unified diff format", () => {
    const before = "- document\n  - heading 'Hello'\n  - paragraph 'World'";
    const after = "- document\n  - heading 'Changed'\n  - paragraph 'World'";
    const result = diffSnapshots(before, after);

    expect(result.changed).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(1);
    expect(result.unchanged).toBe(2);

    // Check unified diff format: "  " for equal, "+ " for insert, "- " for delete
    const lines = result.diff.split("\n");
    expect(lines.some(l => l.startsWith("  "))).toBe(true);
    expect(lines.some(l => l.startsWith("+ "))).toBe(true);
    expect(lines.some(l => l.startsWith("- "))).toBe(true);
  });

  it("handles empty before", () => {
    const result = diffSnapshots("", "- heading 'New'");
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(1); // empty string splits to [""]
  });

  it("handles empty after", () => {
    const result = diffSnapshots("- heading 'Old'", "");
    expect(result.changed).toBe(true);
    expect(result.removals).toBe(1);
  });

  it("handles both empty", () => {
    const result = diffSnapshots("", "");
    expect(result.changed).toBe(false);
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(0);
    expect(result.unchanged).toBe(1); // [""]
  });

  it("handles ARIA snapshot with additions", () => {
    const before = [
      "- document",
      "  - navigation",
      "    - link 'Home'",
      "  - main",
      "    - heading 'Title'",
    ].join("\n");

    const after = [
      "- document",
      "  - navigation",
      "    - link 'Home'",
      "    - link 'About'",
      "  - main",
      "    - heading 'Title'",
      "    - paragraph 'New content'",
    ].join("\n");

    const result = diffSnapshots(before, after);
    expect(result.changed).toBe(true);
    expect(result.additions).toBe(2);
    expect(result.removals).toBe(0);
    expect(result.unchanged).toBe(5);
    expect(result.diff).toContain("+ ");
    expect(result.diff).toContain("link 'About'");
    expect(result.diff).toContain("paragraph 'New content'");
  });

  it("handles ARIA snapshot with removals", () => {
    const before = [
      "- document",
      "  - heading 'Title'",
      "  - paragraph 'Content'",
      "  - paragraph 'Footer'",
    ].join("\n");

    const after = [
      "- document",
      "  - heading 'Title'",
    ].join("\n");

    const result = diffSnapshots(before, after);
    expect(result.changed).toBe(true);
    expect(result.removals).toBe(2);
    expect(result.additions).toBe(0);
    expect(result.unchanged).toBe(2);
  });
});
