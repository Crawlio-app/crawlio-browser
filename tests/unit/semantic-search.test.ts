import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  semanticSearch,
  buildQueryEmbedding,
  normalizeScores,
} from "../../src/mcp-server/semantic-search.js";

// --- Cosine Similarity ---

describe("cosineSimilarity", () => {
  it("should return 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 5);
  });

  it("should return 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("should return -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("should return 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("should return 0 for empty vectors", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("should return 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("should handle non-unit vectors correctly", () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([4, 3]);
    // dot=24, normA=25, normB=25 → 24/25=0.96
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.96, 2);
  });
});

// --- Semantic Search ---

describe("semanticSearch", () => {
  it("should return tools ranked by cosine similarity", () => {
    const embeddings = new Map<string, Float32Array>([
      ["tool_a", new Float32Array([1, 0, 0])],
      ["tool_b", new Float32Array([0, 1, 0])],
      ["tool_c", new Float32Array([0.9, 0.1, 0])],
    ]);

    const query = new Float32Array([1, 0, 0]);
    const results = semanticSearch(query, embeddings, 3);

    expect(results[0].name).toBe("tool_a");
    expect(results[0].score).toBeCloseTo(1.0, 5);
    expect(results[1].name).toBe("tool_c");
    expect(results[2].name).toBe("tool_b");
  });

  it("should respect limit parameter", () => {
    const embeddings = new Map<string, Float32Array>([
      ["tool_a", new Float32Array([1, 0])],
      ["tool_b", new Float32Array([0, 1])],
      ["tool_c", new Float32Array([0.5, 0.5])],
    ]);

    const results = semanticSearch(new Float32Array([1, 0]), embeddings, 2);
    expect(results).toHaveLength(2);
  });

  it("should return empty for empty embeddings", () => {
    const results = semanticSearch(
      new Float32Array([1, 0]),
      new Map(),
      10,
    );
    expect(results).toHaveLength(0);
  });
});

// --- Build Query Embedding ---

describe("buildQueryEmbedding", () => {
  const catalog = [
    { name: "browser_fill_form", description: "Fill form fields in the browser" },
    { name: "browser_click", description: "Click an element on the page" },
    { name: "take_screenshot", description: "Take a screenshot of the page" },
    { name: "get_cookies", description: "Get cookies from the browser" },
  ];

  const embeddings = new Map<string, Float32Array>([
    ["browser_fill_form", new Float32Array([1, 0, 0])],
    ["browser_click", new Float32Array([0, 1, 0])],
    ["take_screenshot", new Float32Array([0, 0, 1])],
    ["get_cookies", new Float32Array([0.5, 0.5, 0])],
  ]);

  it("should return null for empty query", () => {
    expect(buildQueryEmbedding("", catalog, embeddings)).toBeNull();
  });

  it("should return null for empty embeddings", () => {
    expect(buildQueryEmbedding("fill form", catalog, new Map())).toBeNull();
  });

  it("should return null when no tokens match any tool", () => {
    expect(buildQueryEmbedding("xyzzy qqq", catalog, embeddings)).toBeNull();
  });

  it("should build vector from matching tools", () => {
    const result = buildQueryEmbedding("fill", catalog, embeddings);
    expect(result).not.toBeNull();
    // "fill" matches browser_fill_form (name contains "fill") and description "Fill form fields"
    expect(result!.length).toBe(3);
  });

  it("should average multiple matched tool embeddings", () => {
    // "click screenshot" should match browser_click + take_screenshot
    const result = buildQueryEmbedding("click screenshot", catalog, embeddings);
    expect(result).not.toBeNull();
    // Average of [0,1,0] and [0,0,1] = [0, 0.5, 0.5]
    expect(result![0]).toBeCloseTo(0, 5);
    expect(result![1]).toBeCloseTo(0.5, 5);
    expect(result![2]).toBeCloseTo(0.5, 5);
  });
});

// --- Score Normalization ---

describe("normalizeScores", () => {
  it("should normalize max score to 1.0", () => {
    const scores = new Map([["a", 10], ["b", 5], ["c", 0]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBeCloseTo(1.0, 5);
    expect(normalized.get("b")).toBeCloseTo(0.5, 5);
    expect(normalized.get("c")).toBeCloseTo(0.0, 5);
  });

  it("should handle zero scores", () => {
    const scores = new Map([["a", 0], ["b", 0]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(0);
    expect(normalized.get("b")).toBe(0);
  });

  it("should handle all-equal positive scores", () => {
    const scores = new Map([["a", 5], ["b", 5], ["c", 5]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(1);
    expect(normalized.get("b")).toBe(1);
    expect(normalized.get("c")).toBe(1);
  });

  it("should return empty map for empty input", () => {
    const normalized = normalizeScores(new Map());
    expect(normalized.size).toBe(0);
  });

  it("should handle single entry", () => {
    const scores = new Map([["a", 7]]);
    const normalized = normalizeScores(scores);
    expect(normalized.get("a")).toBe(1);
  });
});
