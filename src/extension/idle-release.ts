// Decides when an idle debugger attachment may be released.
//
// Chrome shows a "being debugged" banner for as long as the debugger is attached. When no
// tool has touched the page for a while, detaching removes the banner; the next command
// re-attaches lazily. Everything that would BREAK across a detach is a hold condition.
//
// Deliberately excluded: `networkCapturing`. Both connect paths start capture, so it is true
// for the whole session — holding on it would mean never releasing. Pausing that default
// capture is precisely what an idle release does.

/** Below this, releases would fire between ordinary tool calls and the banner would flap. */
export const MIN_IDLE_RELEASE_MS = 60_000;

/** Conservative default: long enough to sit through agent think-time. */
export const DEFAULT_IDLE_RELEASE_MS = 300_000;

export interface IdleReleaseState {
  now: number;
  /** Last successful CDP command; null when nothing has run yet. */
  lastCommandTime: number | null;
  idleMs: number;
  attachedTabCount: number;
  activeAgentSessions: number;
  recording: boolean;
  /** A dialog or file chooser is waiting on an answer. */
  pendingDialog: boolean;
  /** Fetch-domain rules are session-scoped — detaching would strand them. */
  interceptRuleCount: number;
  coverageActive: boolean;
  /** A frame other than the main one is pinned as the eval target. */
  framePinned: boolean;
  /**
   * CDP commands currently awaiting a response. The idle clock only advances when a command
   * COMPLETES, so a single long one looks identical to silence — without this, a command
   * running past the idle window would have its debugger detached mid-flight.
   */
  commandsInFlight?: number;
}

export type IdleReleaseDecision =
  | { action: "release"; reason: "idle" }
  | { action: "hold"; reason: IdleHoldReason };

export type IdleHoldReason =
  | "disabled"
  | "nothing-attached"
  | "recording"
  | "agent-session-active"
  | "pending-dialog"
  | "interception-active"
  | "coverage-active"
  | "frame-pinned"
  | "no-activity-yet"
  | "not-idle-yet"
  | "command-in-flight";

export function planIdleRelease(s: IdleReleaseState): IdleReleaseDecision {
  const hold = (reason: IdleHoldReason): IdleReleaseDecision => ({ action: "hold", reason });

  if (!(s.idleMs >= MIN_IDLE_RELEASE_MS)) return hold("disabled");
  if (s.attachedTabCount <= 0) return hold("nothing-attached");
  if (s.recording) return hold("recording");
  if (s.activeAgentSessions > 0) return hold("agent-session-active");
  if (s.pendingDialog) return hold("pending-dialog");
  if (s.interceptRuleCount > 0) return hold("interception-active");
  if (s.coverageActive) return hold("coverage-active");
  if (s.framePinned) return hold("frame-pinned");
  if ((s.commandsInFlight ?? 0) > 0) return hold("command-in-flight");
  if (s.lastCommandTime === null) return hold("no-activity-yet");
  if (s.now - s.lastCommandTime < s.idleMs) return hold("not-idle-yet");

  return { action: "release", reason: "idle" };
}

/**
 * Normalize a configured idle window. Absent, zero, or negative disables the feature;
 * anything below the floor is raised to it rather than silently enabling banner flapping.
 */
export function resolveIdleReleaseMs(configured: unknown): number {
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) return 0;
  return Math.max(MIN_IDLE_RELEASE_MS, Math.floor(configured));
}
