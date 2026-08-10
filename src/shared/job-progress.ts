/**
 * Progress reported by a long-running background job.
 *
 * `execute({background: true})` returns a jobId and `get_job_result` answers running or done —
 * which is the whole story for a five-second script and useless for a nine-phase pipeline over a
 * site. A caller polling a job that will take four minutes cannot tell "crawling page 40 of 200"
 * from "wedged", so it either gives up early or waits out the timeout.
 *
 * The sandbox reports phases; the host keeps the latest plus a bounded history. Bounded because
 * the reporter is untrusted code: a loop calling reportPhase() a million times must cost a
 * constant amount of memory, not a growing one.
 */
export interface PhaseReport {
  /** Free-text phase label, clamped. */
  phase: string;
  /** Optional 0-100 completion within the whole job. */
  percent?: number;
  /** Epoch ms when the host received it. */
  at: number;
}

export interface JobProgress {
  /** Most recent report — what a poller usually wants. */
  current: PhaseReport;
  /** Recent reports, oldest first, capped at MAX_PHASE_HISTORY. */
  history: PhaseReport[];
  /** Total reports received, including any dropped from history. */
  reports: number;
}

/** A phase label longer than this is a payload, not a label. */
export const MAX_PHASE_LABEL = 120;

/** How many reports to retain. Enough to see a pipeline's shape, small enough to be free. */
export const MAX_PHASE_HISTORY = 20;

/**
 * Coerce an untrusted report into a PhaseReport, or null if it carries nothing usable.
 *
 * Returns null rather than throwing: a malformed progress call should not kill a job that is
 * otherwise working. Losing a progress line is a far better outcome than losing the run.
 */
export function normalizePhaseReport(phase: unknown, percent: unknown, at: number): PhaseReport | null {
  if (typeof phase !== "string") return null;
  const label = phase.trim().slice(0, MAX_PHASE_LABEL);
  if (label.length === 0) return null;

  const report: PhaseReport = { phase: label, at };
  if (typeof percent === "number" && Number.isFinite(percent)) {
    report.percent = Math.min(100, Math.max(0, Math.round(percent)));
  }
  return report;
}

/** Fold a new report into the running progress, keeping history bounded. */
export function appendPhaseReport(previous: JobProgress | undefined, report: PhaseReport): JobProgress {
  const history = [...(previous?.history ?? []), report].slice(-MAX_PHASE_HISTORY);
  return { current: report, history, reports: (previous?.reports ?? 0) + 1 };
}
