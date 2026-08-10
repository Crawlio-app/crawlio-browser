/** Identifies one service-worker lifetime inside a Chrome profile. */
export interface WorkerGeneration {
  id: string;
  startedAt: number;
}

/** Parse an untrusted wire/storage value without admitting unbounded strings or invalid clocks. */
export function parseWorkerGeneration(value: unknown): WorkerGeneration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length < 1 || candidate.id.length > 128) return null;
  if (typeof candidate.startedAt !== "number" || !Number.isFinite(candidate.startedAt) || candidate.startedAt <= 0) return null;
  return { id: candidate.id, startedAt: candidate.startedAt };
}

/**
 * Whether `candidate` supersedes `incumbent`.
 *
 * `startedAt` supplies normal ordering. The id tie-break makes simultaneous test/frozen-clock
 * starts converge instead of each generation considering itself the owner.
 */
export function isNewerWorkerGeneration(
  candidate: WorkerGeneration | null,
  incumbent: WorkerGeneration | null,
): boolean {
  if (!candidate) return false;
  if (!incumbent) return true;
  if (candidate.startedAt !== incumbent.startedAt) return candidate.startedAt > incumbent.startedAt;
  return candidate.id > incumbent.id;
}
