import type { EvidenceEnvelope, EvidenceMetadata, Provenance, Confidence, EvidenceGap, EvidenceType, EvidenceTypeMap } from "./schema.js";

function generateEvidenceId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `ev_${ts}_${rand}`;
}

export interface WrapOptions<K extends EvidenceType> {
  type: K;
  url: string;
  payload: EvidenceTypeMap[K];
  provenance: Omit<Provenance, "timestamp">;
  confidence: Confidence;
  gaps?: EvidenceGap[];
  parentId?: string;
  runId?: string;
}

export function wrapEvidence<K extends EvidenceType>(
  opts: WrapOptions<K>
): EvidenceEnvelope<EvidenceTypeMap[K]> {
  const now = new Date().toISOString();
  const explicitGaps = opts.gaps ?? [];
  const nullGaps = detectNullGaps(opts.payload);
  const existingDimensions = new Set(explicitGaps.map(g => g.dimension));
  const filteredNullGaps = nullGaps.filter(g => !existingDimensions.has(g.dimension));
  const allGaps = [...explicitGaps, ...filteredNullGaps];
  const metadata: EvidenceMetadata = {
    writtenVia: "wrapEvidence",
    version: "1.0",
    ...(opts.runId ? { runId: opts.runId } : {}),
  };
  return {
    evidenceId: generateEvidenceId(),
    type: opts.type,
    url: opts.url,
    provenance: { ...opts.provenance, timestamp: now },
    confidence: opts.confidence,
    gaps: allGaps,
    quality: deriveQuality(allGaps, opts.confidence),
    payload: opts.payload,
    createdAt: now,
    parentId: opts.parentId,
    metadata,
  };
}

export function detectNullGaps(payload: unknown): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  if (payload == null || typeof payload !== "object") return gaps;

  const walk = (obj: Record<string, unknown>, path: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (value === null) {
        gaps.push({
          dimension: fullPath,
          reason: `${key} was null in captured data`,
          impact: "data-absent",
          reducesConfidence: false,
        });
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const el = value[i];
          const elPath = `${fullPath}[${i}]`;
          if (el === null) {
            gaps.push({
              dimension: elPath,
              reason: `${key}[${i}] was null in captured data`,
              impact: "data-absent",
              reducesConfidence: false,
            });
          } else if (typeof el === "object" && el !== null) {
            walk(el as Record<string, unknown>, elPath);
          }
        }
      } else if (typeof value === "object" && value !== null) {
        walk(value as Record<string, unknown>, fullPath);
      }
    }
  };

  walk(payload as Record<string, unknown>, "");
  return gaps;
}

export function deriveQuality(
  gaps: EvidenceGap[],
  confidence: Confidence
): EvidenceEnvelope<unknown>["quality"] {
  if (gaps.length === 0) return "complete";
  if (confidence.level === "speculative") return "unavailable";
  if (gaps.some(g => g.impact === "method-failed")) return "degraded";
  const confidenceReducingGaps = gaps.filter(g => g.reducesConfidence);
  if (confidenceReducingGaps.length > 3) return "degraded";
  if (gaps.length > 0) return "partial";
  return "complete";
}
