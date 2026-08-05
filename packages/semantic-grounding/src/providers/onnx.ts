import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  GroundedCandidate,
  GroundingActionCandidate,
  GroundingContext,
  GroundingResult,
  RankedLabel,
  RerankCandidate,
  SemanticGroundingProvider,
} from "../types.js";

const MAX_TOKENS = 256;
const SHORTLIST_SIZE = 32;

const EMBED_MODEL = {
  id: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  modelFile: "onnx/model_quantized.onnx",
  vocabFile: "vocab.txt",
};

const RERANK_MODEL = {
  id: "Xenova/ms-marco-MiniLM-L-6-v2",
  revision: "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
  modelFile: "onnx/model_quantized.onnx",
  vocabFile: "vocab.txt",
};

const MODEL_VERSION = [
  `${EMBED_MODEL.id}@${EMBED_MODEL.revision}`,
  `${RERANK_MODEL.id}@${RERANK_MODEL.revision}`,
  "onnxruntime-node",
].join("+");

interface TensorLike {
  data: ArrayLike<number | bigint>;
  dims: readonly number[];
}

interface OnnxSessionLike {
  inputNames?: string[];
  outputNames?: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}

interface OnnxRuntimeLike {
  InferenceSession: {
    create(path: string): Promise<OnnxSessionLike>;
  };
  Tensor: new (type: "int64", data: BigInt64Array, dims: readonly number[]) => unknown;
}

interface Tokenizer {
  vocab: Map<string, number>;
  padId: number;
  unkId: number;
  clsId: number;
  sepId: number;
}

interface EncodedInput {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

interface OnnxAsset {
  id: string;
  revision: string;
  modelFile: string;
  vocabFile: string;
}

export interface OnnxProviderOptions {
  cacheDir?: string;
  allowModelFetch?: boolean;
  forceAvailable?: boolean;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function assetPath(cacheDir: string, model: OnnxAsset, file: string): string {
  return join(cacheDir, `${safeName(model.id)}-${model.revision}`, file);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchAsset(cacheDir: string, model: OnnxAsset, file: string): Promise<string> {
  const path = assetPath(cacheDir, model, file);
  if (await exists(path)) return path;
  const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ONNX asset fetch failed for ${model.id}/${file}: HTTP ${response.status}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array(await response.arrayBuffer()));
  return path;
}

async function ensureAsset(cacheDir: string, model: OnnxAsset, file: string, allowFetch: boolean): Promise<string | null> {
  const path = assetPath(cacheDir, model, file);
  if (await exists(path)) return path;
  return allowFetch ? fetchAsset(cacheDir, model, file) : null;
}

async function optionalOnnxRuntime(): Promise<OnnxRuntimeLike | null> {
  try {
    const specifier = "onnxruntime-node";
    return await import(specifier) as unknown as OnnxRuntimeLike;
  } catch {
    return null;
  }
}

function basicTokenize(input: string): string[] {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordpiece(token: string, vocab: Map<string, number>): string[] {
  if (vocab.has(token)) return [token];
  const pieces: string[] = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let current: string | null = null;
    while (start < end) {
      const sub = `${start > 0 ? "##" : ""}${token.slice(start, end)}`;
      if (vocab.has(sub)) {
        current = sub;
        break;
      }
      end--;
    }
    if (!current) return ["[UNK]"];
    pieces.push(current);
    start = end;
  }
  return pieces;
}

function encodeText(tokenizer: Tokenizer, text: string, pair?: string): EncodedInput {
  const first = basicTokenize(text).flatMap(token => wordpiece(token, tokenizer.vocab));
  const second = pair ? basicTokenize(pair).flatMap(token => wordpiece(token, tokenizer.vocab)) : [];
  const maxContent = MAX_TOKENS - (pair ? 3 : 2);
  let a = first;
  let b = second;
  while (a.length + b.length > maxContent) {
    if (b.length > a.length) b = b.slice(0, -1);
    else a = a.slice(0, -1);
  }

  const tokens = ["[CLS]", ...a, "[SEP]", ...(pair ? [...b, "[SEP]"] : [])];
  const tokenTypes = [
    ...Array(a.length + 2).fill(0),
    ...(pair ? Array(b.length + 1).fill(1) : []),
  ];
  const inputIds = tokens.map(token => tokenizer.vocab.get(token) ?? tokenizer.unkId);
  const attentionMask = Array(inputIds.length).fill(1);
  while (inputIds.length < MAX_TOKENS) {
    inputIds.push(tokenizer.padId);
    attentionMask.push(0);
    tokenTypes.push(0);
  }
  return { inputIds, attentionMask, tokenTypeIds: tokenTypes };
}

function tensor(runtime: OnnxRuntimeLike, data: number[]): unknown {
  return new runtime.Tensor("int64", BigInt64Array.from(data.map(value => BigInt(value))), [1, data.length]);
}

function feedsFor(session: OnnxSessionLike, runtime: OnnxRuntimeLike, encoded: EncodedInput): Record<string, unknown> {
  const expected = session.inputNames?.length ? session.inputNames : ["input_ids", "attention_mask", "token_type_ids"];
  const feeds: Record<string, unknown> = {};
  for (const name of expected) {
    if (name === "input_ids") feeds[name] = tensor(runtime, encoded.inputIds);
    else if (name === "attention_mask") feeds[name] = tensor(runtime, encoded.attentionMask);
    else if (name === "token_type_ids") feeds[name] = tensor(runtime, encoded.tokenTypeIds);
  }
  return feeds;
}

function toNumbers(data: ArrayLike<number | bigint>): number[] {
  return Array.from({ length: data.length }, (_value, index) => Number(data[index]));
}

function pickOutput(outputs: Record<string, TensorLike>, preferredNames: string[]): TensorLike {
  for (const name of preferredNames) {
    if (outputs[name]) return outputs[name];
  }
  const tensors = Object.values(outputs);
  const candidate = tensors.find(item => item.dims.length >= 2) ?? tensors[0];
  if (!candidate) throw new Error("ONNX session returned no tensor outputs");
  return candidate;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

function meanPool(output: TensorLike, attentionMask: number[]): number[] {
  const data = toNumbers(output.data);
  if (output.dims.length === 2) {
    const hidden = output.dims[1] ?? data.length;
    return normalize(data.slice(0, hidden));
  }
  if (output.dims.length < 3) return normalize(data);
  const seq = output.dims[1] ?? attentionMask.length;
  const hidden = output.dims[2] ?? Math.floor(data.length / Math.max(1, seq));
  const pooled = Array.from({ length: hidden }, () => 0);
  let count = 0;
  for (let token = 0; token < seq; token++) {
    if (!attentionMask[token]) continue;
    count++;
    for (let i = 0; i < hidden; i++) {
      pooled[i] += data[token * hidden + i] ?? 0;
    }
  }
  const divisor = Math.max(1, count);
  return normalize(pooled.map(value => value / divisor));
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(0, Math.min(1, (dot + 1) / 2));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function crossEncoderScore(output: TensorLike): number {
  const values = toNumbers(output.data);
  if (values.length >= 2) {
    const max = Math.max(...values);
    const exps = values.map(value => Math.exp(value - max));
    const total = exps.reduce((sum, value) => sum + value, 0) || 1;
    return exps[Math.min(1, exps.length - 1)]! / total;
  }
  return sigmoid(values[0] ?? 0);
}

function candidateText(candidate: GroundingActionCandidate | RerankCandidate): string {
  if ("text" in candidate && typeof candidate.text === "string") return candidate.text;
  const action = candidate as GroundingActionCandidate;
  return [action.role, action.name, action.text, action.selector, action.ref]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function extractSnapshotCandidates(context: GroundingContext): GroundingActionCandidate[] {
  const snapshot = context.pageSnapshot;
  if (!snapshot || typeof snapshot !== "object") return [];
  const rawElements = snapshot.elements ?? snapshot.nodes ?? snapshot.interactiveElements;
  if (!Array.isArray(rawElements)) return [];
  return rawElements.flatMap((value, index): GroundingActionCandidate[] => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const ref = typeof record.ref === "string" ? record.ref : typeof record.id === "string" ? record.id : `snapshot-${index}`;
    return [{
      ref,
      role: typeof record.role === "string" ? record.role : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      text: typeof record.text === "string" ? record.text : undefined,
      selector: typeof record.selector === "string" ? record.selector : undefined,
      evidenceRefs: Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter((item): item is string => typeof item === "string") : undefined,
    }];
  });
}

function collectCandidates(context: GroundingContext): GroundingActionCandidate[] {
  const seen = new Set<string>();
  const merged: GroundingActionCandidate[] = [];
  for (const candidate of [...(context.candidateActions ?? []), ...extractSnapshotCandidates(context)]) {
    if (seen.has(candidate.ref)) continue;
    seen.add(candidate.ref);
    merged.push(candidate);
  }
  return merged;
}

function collectEvidenceRefs(context: GroundingContext, candidates: Array<{ evidenceRefs?: string[] }>): string[] {
  return [...new Set([...(context.evidenceRefs ?? []), ...candidates.flatMap(candidate => candidate.evidenceRefs ?? [])])];
}

export function createOnnxProvider(options: OnnxProviderOptions = {}): SemanticGroundingProvider {
  const cacheDir = options.cacheDir ?? join(homedir(), ".cache", "crawlio", "semantic-grounding");
  let runtimePromise: Promise<OnnxRuntimeLike> | null = null;
  const sessions = new Map<string, Promise<OnnxSessionLike>>();
  const tokenizers = new Map<string, Promise<Tokenizer>>();

  async function runtime(): Promise<OnnxRuntimeLike> {
    runtimePromise ??= optionalOnnxRuntime().then(ort => {
      if (!ort?.InferenceSession || !ort.Tensor) throw new Error("onnxruntime-node is not installed");
      return ort;
    });
    return runtimePromise;
  }

  async function loadTokenizer(model: OnnxAsset): Promise<Tokenizer> {
    const key = `${model.id}@${model.revision}`;
    const existing = tokenizers.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const vocabPath = await ensureAsset(cacheDir, model, model.vocabFile, options.allowModelFetch === true);
      if (!vocabPath) throw new Error(`ONNX tokenizer vocab is not cached for ${model.id}; set CRAWLIO_SEMANTIC_ONNX_FETCH=1 to fetch pinned assets`);
      const vocab = new Map<string, number>();
      const lines = (await readFile(vocabPath, "utf8")).split(/\r?\n/);
      lines.forEach((token, index) => {
        if (token) vocab.set(token, index);
      });
      return {
        vocab,
        padId: vocab.get("[PAD]") ?? 0,
        unkId: vocab.get("[UNK]") ?? 100,
        clsId: vocab.get("[CLS]") ?? 101,
        sepId: vocab.get("[SEP]") ?? 102,
      };
    })();
    tokenizers.set(key, promise);
    return promise;
  }

  async function loadSession(model: OnnxAsset): Promise<OnnxSessionLike> {
    const key = `${model.id}@${model.revision}`;
    const existing = sessions.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const ort = await runtime();
      const modelPath = await ensureAsset(cacheDir, model, model.modelFile, options.allowModelFetch === true);
      if (!modelPath) throw new Error(`ONNX model is not cached for ${model.id}; set CRAWLIO_SEMANTIC_ONNX_FETCH=1 to fetch pinned assets`);
      return ort.InferenceSession.create(modelPath);
    })();
    sessions.set(key, promise);
    return promise;
  }

  async function embedVectors(texts: string[]): Promise<number[][]> {
    const ort = await runtime();
    const tokenizer = await loadTokenizer(EMBED_MODEL);
    const session = await loadSession(EMBED_MODEL);
    const vectors: number[][] = [];
    for (const text of texts) {
      const encoded = encodeText(tokenizer, text);
      const outputs = await session.run(feedsFor(session, ort, encoded));
      const output = pickOutput(outputs, ["last_hidden_state", "token_embeddings", "sentence_embedding", "output"]);
      vectors.push(meanPool(output, encoded.attentionMask));
    }
    return vectors;
  }

  async function rerankScores(query: string, candidates: RerankCandidate[]): Promise<Array<{ id: string; score: number }>> {
    const ort = await runtime();
    const tokenizer = await loadTokenizer(RERANK_MODEL);
    const session = await loadSession(RERANK_MODEL);
    const scores: Array<{ id: string; score: number }> = [];
    for (const candidate of candidates) {
      const encoded = encodeText(tokenizer, query, candidate.text);
      const outputs = await session.run(feedsFor(session, ort, encoded));
      const output = pickOutput(outputs, ["logits", "output", "last_hidden_state"]);
      scores.push({ id: candidate.id, score: crossEncoderScore(output) });
    }
    return scores.sort((a, b) => b.score - a.score);
  }

  async function available(): Promise<boolean> {
    if (options.forceAvailable) return true;
    const ort = await optionalOnnxRuntime();
    if (!ort?.InferenceSession || !ort.Tensor) return false;
    if (options.allowModelFetch) return true;
    return Boolean(
      await exists(assetPath(cacheDir, EMBED_MODEL, EMBED_MODEL.modelFile)) &&
      await exists(assetPath(cacheDir, EMBED_MODEL, EMBED_MODEL.vocabFile)) &&
      await exists(assetPath(cacheDir, RERANK_MODEL, RERANK_MODEL.modelFile)) &&
      await exists(assetPath(cacheDir, RERANK_MODEL, RERANK_MODEL.vocabFile))
    );
  }

  return {
    id: "crawlio-onnx",
    kind: "onnx",
    modelVersion: MODEL_VERSION,
    capabilities: ["embed", "classify", "rerank", "ground"],
    isAvailable: available,
    async embed(texts: string[]): Promise<GroundingResult> {
      const vectors = await embedVectors(texts);
      return {
        provider: "crawlio-onnx",
        kind: "onnx",
        modelVersion: MODEL_VERSION,
        confidence: texts.length > 0 ? 0.8 : 0,
        output: { vectors, dim: vectors[0]?.length ?? 0 },
        evidenceRefs: [],
        routedBecause: "portable ONNX provider ran all-MiniLM-L6-v2 embeddings locally",
      };
    },
    async classify(input: string, labels: string[]): Promise<GroundingResult> {
      const [inputVector, ...labelVectors] = await embedVectors([input, ...labels]);
      const ranked: RankedLabel[] = labels
        .map((label, index) => ({ label, score: cosine(inputVector ?? [], labelVectors[index] ?? []) }))
        .sort((a, b) => b.score - a.score);
      return {
        provider: "crawlio-onnx",
        kind: "onnx",
        modelVersion: MODEL_VERSION,
        confidence: ranked[0]?.score ?? 0,
        output: { ranked },
        evidenceRefs: [],
        routedBecause: "portable ONNX provider classified with all-MiniLM-L6-v2 embedding similarity",
      };
    },
    async rerank(query: string, candidates: RerankCandidate[]): Promise<GroundingResult> {
      const ranked = await rerankScores(query, candidates);
      return {
        provider: "crawlio-onnx",
        kind: "onnx",
        modelVersion: MODEL_VERSION,
        confidence: ranked[0]?.score ?? 0,
        output: { ranked },
        evidenceRefs: [...new Set(candidates.flatMap(candidate => candidate.evidenceRefs ?? []))],
        routedBecause: "portable ONNX provider reranked with ms-marco-MiniLM-L-6-v2 cross-encoder",
      };
    },
    async ground(query: string, context: GroundingContext): Promise<GroundingResult> {
      const candidates = collectCandidates(context);
      if (candidates.length === 0) {
        return {
          provider: "crawlio-onnx",
          kind: "onnx",
          modelVersion: MODEL_VERSION,
          confidence: 0,
          output: { candidates: [] },
          evidenceRefs: context.evidenceRefs ?? [],
          routedBecause: "portable ONNX provider found no serialized candidate refs to ground",
        };
      }

      const texts = candidates.map(candidateText);
      const [queryVector, ...candidateVectors] = await embedVectors([query, ...texts]);
      const shortlist = candidates
        .map((candidate, index) => ({
          candidate,
          score: cosine(queryVector ?? [], candidateVectors[index] ?? []),
          text: texts[index] ?? "",
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, SHORTLIST_SIZE);
      const reranked = await rerankScores(query, shortlist.map(item => ({
        id: item.candidate.ref,
        text: item.text,
        evidenceRefs: item.candidate.evidenceRefs,
      })));
      const byRef = new Map(shortlist.map(item => [item.candidate.ref, item]));
      const grounded: GroundedCandidate[] = reranked.map(item => ({
        ref: item.id,
        score: item.score,
        why: "retrieved by all-MiniLM-L6-v2 embedding similarity and reranked by ms-marco cross-encoder",
        evidenceRefs: byRef.get(item.id)?.candidate.evidenceRefs,
      }));
      return {
        provider: "crawlio-onnx",
        kind: "onnx",
        modelVersion: MODEL_VERSION,
        confidence: grounded[0]?.score ?? 0,
        output: { candidates: grounded },
        evidenceRefs: collectEvidenceRefs(context, grounded),
        routedBecause: "portable ONNX provider grounded with local retrieve-to-rerank over serialized candidate refs",
      };
    },
  };
}
