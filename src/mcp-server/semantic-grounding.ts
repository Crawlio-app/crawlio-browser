import {
  createDefaultRouter,
  type GroundingActionCandidate,
  type GroundingContext,
  type GroundingResult,
} from "@crawlio/semantic-grounding";
import type { WebSocketBridge } from "./websocket-bridge.js";

type BridgeCommand = Parameters<WebSocketBridge["send"]>[0];
const SNAPSHOT_TIMEOUT_MS = 15000;

const router = createDefaultRouter({
  onnx: {
    allowModelFetch: process.env.CRAWLIO_SEMANTIC_ONNX_FETCH === "1",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSnapshotText(snapshot: unknown): string {
  if (typeof snapshot === "string") return snapshot;
  if (!isRecord(snapshot)) return "";
  for (const key of ["snapshot", "text", "aria", "content"]) {
    const value = snapshot[key];
    if (typeof value === "string") return value;
  }
  try {
    return JSON.stringify(snapshot);
  } catch {
    return "";
  }
}

export function parseSnapshotCandidates(snapshot: unknown): GroundingActionCandidate[] {
  const text = extractSnapshotText(snapshot);
  if (!text) return [];
  const candidates: GroundingActionCandidate[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const ref = line.match(/\[ref=([^\]\s]+)\]/)?.[1];
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const role = line.match(/^\s*-?\s*([a-zA-Z][a-zA-Z0-9_-]*)\b/)?.[1];
    const name = line.match(/"([^"]+)"/)?.[1] ?? line.replace(/\[ref=[^\]]+\]/g, "").trim();
    candidates.push({
      ref,
      role,
      name,
      text: line.trim(),
      evidenceRefs: [`snapshot:${ref}`],
    });
  }
  return candidates;
}

export async function semanticClassify(input: string, labels: string[]): Promise<GroundingResult> {
  return router.classify(input, labels);
}

export async function semanticFind(
  bridge: WebSocketBridge,
  query: string,
  context: GroundingContext = {},
): Promise<GroundingResult> {
  let nextContext: GroundingContext = { ...context };
  if (!nextContext.candidateActions?.length && !nextContext.pageSnapshot) {
    const snapshot = await bridge.send({ type: "browser_snapshot", interactive: true } as BridgeCommand, SNAPSHOT_TIMEOUT_MS);
    nextContext = {
      ...nextContext,
      pageSnapshot: isRecord(snapshot) ? snapshot : { snapshot },
      candidateActions: parseSnapshotCandidates(snapshot),
      evidenceRefs: ["browser_snapshot"],
    };
  } else if (!nextContext.candidateActions?.length && nextContext.pageSnapshot) {
    nextContext = {
      ...nextContext,
      candidateActions: parseSnapshotCandidates(nextContext.pageSnapshot),
    };
  }
  return router.ground(query, nextContext);
}
