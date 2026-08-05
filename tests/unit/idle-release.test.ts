import { describe, it, expect } from "vitest";
import {
  planIdleRelease, resolveIdleReleaseMs,
  MIN_IDLE_RELEASE_MS, DEFAULT_IDLE_RELEASE_MS,
  type IdleReleaseState,
} from "../../src/extension/idle-release";

const NOW = 1_000_000_000;

// An attachment that has been quiet for twice the idle window with nothing in flight.
function releasable(over: Partial<IdleReleaseState> = {}): IdleReleaseState {
  return {
    now: NOW,
    lastCommandTime: NOW - DEFAULT_IDLE_RELEASE_MS * 2,
    idleMs: DEFAULT_IDLE_RELEASE_MS,
    attachedTabCount: 1,
    activeAgentSessions: 0,
    recording: false,
    pendingDialog: false,
    interceptRuleCount: 0,
    coverageActive: false,
    framePinned: false,
    ...over,
  };
}

describe("planIdleRelease", () => {
  it("should release a quiet attachment with nothing in flight", () => {
    expect(planIdleRelease(releasable())).toEqual({ action: "release", reason: "idle" });
  });

  it("should hold until the idle window has fully elapsed", () => {
    const justShort = releasable({ lastCommandTime: NOW - (DEFAULT_IDLE_RELEASE_MS - 1) });
    expect(planIdleRelease(justShort)).toEqual({ action: "hold", reason: "not-idle-yet" });

    const exactly = releasable({ lastCommandTime: NOW - DEFAULT_IDLE_RELEASE_MS });
    expect(planIdleRelease(exactly).action).toBe("release");
  });

  it("should be disabled when idleMs is zero or below the floor", () => {
    expect(planIdleRelease(releasable({ idleMs: 0 })).reason).toBe("disabled");
    expect(planIdleRelease(releasable({ idleMs: MIN_IDLE_RELEASE_MS - 1 })).reason).toBe("disabled");
    expect(planIdleRelease(releasable({ idleMs: MIN_IDLE_RELEASE_MS })).action).toBe("release");
  });

  it("should hold when nothing is attached", () => {
    expect(planIdleRelease(releasable({ attachedTabCount: 0 })).reason).toBe("nothing-attached");
  });

  it("should never detach out from under a recording", () => {
    expect(planIdleRelease(releasable({ recording: true })).reason).toBe("recording");
  });

  it("should never detach out from under a live agent session", () => {
    expect(planIdleRelease(releasable({ activeAgentSessions: 1 })).reason).toBe("agent-session-active");
  });

  it("should hold while a dialog or file chooser is waiting", () => {
    expect(planIdleRelease(releasable({ pendingDialog: true })).reason).toBe("pending-dialog");
  });

  it("should hold while Fetch interception rules are installed", () => {
    // Fetch.enable is session-scoped: detaching strands the rules while the map still
    // claims they are active.
    expect(planIdleRelease(releasable({ interceptRuleCount: 1 })).reason).toBe("interception-active");
  });

  it("should hold while coverage is being collected or a frame is pinned", () => {
    expect(planIdleRelease(releasable({ coverageActive: true })).reason).toBe("coverage-active");
    expect(planIdleRelease(releasable({ framePinned: true })).reason).toBe("frame-pinned");
  });

  it("should hold while a CDP command is still in flight", () => {
    // The idle clock only advances when a command completes, so a command running longer
    // than the window is indistinguishable from silence — and would have its debugger
    // detached mid-flight.
    expect(planIdleRelease(releasable({ commandsInFlight: 1 })).reason).toBe("command-in-flight");
    expect(planIdleRelease(releasable({ commandsInFlight: 0 })).action).toBe("release");
    expect(planIdleRelease(releasable({ commandsInFlight: undefined })).action).toBe("release");
  });

  it("should hold when no command has ever run", () => {
    expect(planIdleRelease(releasable({ lastCommandTime: null })).reason).toBe("no-activity-yet");
  });

  it("should not release merely because network capture is on", () => {
    // networkCapturing is true for the whole session, so it is not an input at all —
    // a default capture must not be able to block idle release forever.
    expect(planIdleRelease(releasable()).action).toBe("release");
  });
});

describe("resolveIdleReleaseMs", () => {
  it("should treat absent, zero, and negative as disabled", () => {
    for (const value of [undefined, null, 0, -1, NaN, "300000", {}]) {
      expect(resolveIdleReleaseMs(value)).toBe(0);
    }
  });

  it("should raise a too-small window to the floor instead of flapping the banner", () => {
    expect(resolveIdleReleaseMs(20_000)).toBe(MIN_IDLE_RELEASE_MS);
    expect(resolveIdleReleaseMs(1)).toBe(MIN_IDLE_RELEASE_MS);
  });

  it("should pass through a sane window", () => {
    expect(resolveIdleReleaseMs(DEFAULT_IDLE_RELEASE_MS)).toBe(DEFAULT_IDLE_RELEASE_MS);
    expect(resolveIdleReleaseMs(120_000.7)).toBe(120_000);
  });
});
