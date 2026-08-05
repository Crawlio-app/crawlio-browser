import type {
  GroundedCandidate,
  GroundingActionCandidate,
  GroundingContext,
  GroundingResult,
  RerankCandidate,
  SemanticGroundingProvider,
} from "../types.js";

const MODEL_VERSION = "heuristic-aria-name-fuzzy-1.0.0";

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenScore(query: string, candidate: string): number {
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  const exact = queryTokens.filter(token => candidateSet.has(token)).length / queryTokens.length;
  const fuzzy = queryTokens.filter(token => candidateTokens.some(candidateToken =>
    candidateToken.includes(token) || token.includes(candidateToken)
  )).length / queryTokens.length;
  const phrase = candidate.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
  return Math.min(1, Math.max(exact, fuzzy * 0.85, phrase));
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
  const explicit = context.candidateActions ?? [];
  const fromSnapshot = extractSnapshotCandidates(context);
  const seen = new Set<string>();
  const merged: GroundingActionCandidate[] = [];
  for (const candidate of [...explicit, ...fromSnapshot]) {
    if (seen.has(candidate.ref)) continue;
    seen.add(candidate.ref);
    merged.push(candidate);
  }
  return merged;
}

function collectEvidenceRefs(context: GroundingContext, candidates: Array<{ evidenceRefs?: string[] }>): string[] {
  return [...new Set([...(context.evidenceRefs ?? []), ...candidates.flatMap(candidate => candidate.evidenceRefs ?? [])])];
}

export function createHeuristicProvider(): SemanticGroundingProvider {
  return {
    id: "crawlio-heuristic",
    kind: "heuristic",
    modelVersion: MODEL_VERSION,
    capabilities: ["classify", "rerank", "ground"],
    isAvailable: () => true,
    async classify(input: string, labels: string[]): Promise<GroundingResult> {
      const ranked = labels
        .map(label => ({ label, score: tokenScore(input, label) }))
        .sort((a, b) => b.score - a.score);
      return {
        provider: "crawlio-heuristic",
        kind: "heuristic",
        modelVersion: MODEL_VERSION,
        confidence: ranked[0]?.score ?? 0,
        output: { ranked },
        evidenceRefs: [],
        routedBecause: "heuristic fallback used ARIA/name lexical scoring",
      };
    },
    async rerank(query: string, candidates: RerankCandidate[]): Promise<GroundingResult> {
      const ranked = candidates
        .map(candidate => ({ id: candidate.id, score: tokenScore(query, candidateText(candidate)) }))
        .sort((a, b) => b.score - a.score);
      return {
        provider: "crawlio-heuristic",
        kind: "heuristic",
        modelVersion: MODEL_VERSION,
        confidence: ranked[0]?.score ?? 0,
        output: { ranked },
        evidenceRefs: [...new Set(candidates.flatMap(candidate => candidate.evidenceRefs ?? []))],
        routedBecause: "heuristic fallback reranked candidates by accessible text overlap",
      };
    },
    async ground(query: string, context: GroundingContext): Promise<GroundingResult> {
      const candidates = collectCandidates(context);
      const scored: GroundedCandidate[] = candidates
        .map(candidate => {
          const score = tokenScore(query, candidateText(candidate));
          return {
            ref: candidate.ref,
            score,
            why: score > 0
              ? "matched query tokens against role/name/text/selector"
              : "candidate retained with no lexical match",
            evidenceRefs: candidate.evidenceRefs,
          };
        })
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
      return {
        provider: "crawlio-heuristic",
        kind: "heuristic",
        modelVersion: MODEL_VERSION,
        confidence: scored[0]?.score ?? 0,
        output: { candidates: scored },
        evidenceRefs: collectEvidenceRefs(context, scored),
        routedBecause: "heuristic fallback grounded over serialized candidate refs",
      };
    },
  };
}
