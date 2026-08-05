/**
 * Semantic search for tool discovery.
 *
 * - Pure TS cosine similarity (adequate at 100-tool scale)
 * - tool-embeddings.json (pre-computed at build time)
 * - 100 * 512-dim < 50KB, sub-ms search
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// --- Types ---

interface EmbeddingAsset {
  model: string;
  dimension: number;
  generated: string;
  embeddings: Record<string, number[]>;
}

// --- Cosine Similarity ---

/** Cosine similarity between two Float32Arrays. Returns 0 for mismatched or zero-length vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// --- Embedding Loading ---

/** Load pre-computed embeddings from the bundled JSON asset. Returns empty map on failure. */
export function loadEmbeddings(): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>();

  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const assetPath = join(thisDir, "tool-embeddings.json");
    const raw = readFileSync(assetPath, "utf-8");
    const asset: EmbeddingAsset = JSON.parse(raw);

    if (!asset.embeddings || typeof asset.embeddings !== "object") return map;

    for (const [name, vec] of Object.entries(asset.embeddings)) {
      if (Array.isArray(vec) && vec.length > 0) {
        map.set(name, new Float32Array(vec));
      }
    }
  } catch {
    // Missing or invalid file — fall back to keyword-only search
  }

  return map;
}

// --- Semantic Search ---

/** Search pre-computed embeddings by cosine similarity against a query vector. */
export function semanticSearch(
  queryEmbedding: Float32Array,
  embeddings: Map<string, Float32Array>,
  limit: number,
): { name: string; score: number }[] {
  const results: { name: string; score: number }[] = [];

  for (const [name, vec] of embeddings) {
    const score = cosineSimilarity(queryEmbedding, vec);
    results.push({ name, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// --- Bag-of-Embeddings Query Vector ---

interface CatalogLike {
  name: string;
  description: string;
}

/**
 * Build a proxy query vector using bag-of-embeddings:
 * tokenize query → keyword-match each token to best tool → average those tool embeddings.
 * Zero API calls at runtime.
 */
export function buildQueryEmbedding(
  query: string,
  catalog: CatalogLike[],
  embeddings: Map<string, Float32Array>,
): Float32Array | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || embeddings.size === 0) return null;

  // For each query token, find the best keyword-matching tool that has an embedding
  const matchedVectors: Float32Array[] = [];

  for (const token of tokens) {
    let bestName = "";
    let bestScore = 0;

    for (const entry of catalog) {
      if (!embeddings.has(entry.name)) continue;

      let score = 0;
      const nameLower = entry.name.toLowerCase();
      const descLower = entry.description.toLowerCase();

      if (nameLower === token) score = 10;
      else if (nameLower.includes(token)) score = 5;
      if (descLower.includes(token)) score += 2;

      if (score > bestScore) {
        bestScore = score;
        bestName = entry.name;
      }
    }

    if (bestName && bestScore > 0) {
      const vec = embeddings.get(bestName);
      if (vec) matchedVectors.push(vec);
    }
  }

  if (matchedVectors.length === 0) return null;

  // Average the matched tool embeddings
  const dim = matchedVectors[0].length;
  const avg = new Float32Array(dim);

  for (const vec of matchedVectors) {
    for (let i = 0; i < dim; i++) {
      avg[i] += vec[i];
    }
  }

  const count = matchedVectors.length;
  for (let i = 0; i < dim; i++) {
    avg[i] /= count;
  }

  return avg;
}

// --- Normalization ---

/** Normalize an array of scores to [0, 1] range. Returns zeros if all scores are equal. */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  const normalized = new Map<string, number>();
  if (scores.size === 0) return normalized;

  let min = Infinity;
  let max = -Infinity;

  for (const s of scores.values()) {
    if (s < min) min = s;
    if (s > max) max = s;
  }

  const range = max - min;

  for (const [name, score] of scores) {
    normalized.set(name, range === 0 ? (max > 0 ? 1 : 0) : (score - min) / range);
  }

  return normalized;
}
