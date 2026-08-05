import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * background.ts is a browser IIFE bundle and cannot be imported under vitest, so these are
 * structural assertions over its source. They exist because the feature shipped once in a
 * state where it could never run: the alarm was armed only inside ensureDebugger, past its
 * fast-path return, and connect_tab reaches the debugger without ever calling
 * ensureDebugger. Nothing failed — the idle check simply never executed.
 */
const SOURCE = readFileSync(resolve(__dirname, "../../src/extension/background.ts"), "utf8");

function bodyOf(fnName: string): string {
  const start = SOURCE.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`${fnName} not found`);
  const end = SOURCE.indexOf("\n}", start);
  return SOURCE.slice(start, end);
}

describe("idle release wiring", () => {
  it("should arm the alarm from attachDebugger, the path every attach crosses", () => {
    // connect_tab → startNetworkCapture → attachDebugger, never ensureDebugger.
    expect(bodyOf("attachDebugger")).toContain("startIdleReleaseAlarm");
  });

  it("should not arm the alarm only from ensureDebugger", () => {
    // ensureDebugger returns early for an already-attached tab, so arming there alone
    // leaves the check unreachable once a connection is established.
    const ensure = bodyOf("ensureDebugger");
    expect(ensure).not.toContain("startIdleReleaseAlarm");
  });

  it("should expose commands to read and write the setting", () => {
    // Without a writer the feature is unreachable: the config key has no other producer.
    expect(SOURCE).toContain('case "set_idle_release"');
    expect(SOURCE).toContain('case "get_idle_release"');
    expect(SOURCE).toContain("IDLE_RELEASE_CONFIG_KEY");
  });

  it("should persist state immediately when releasing", () => {
    // The periodic snapshot still claims a live attachment; a service-worker restart in
    // that window would restore it and bring the debugger banner back unprompted.
    expect(bodyOf("idleReleaseDebuggers")).toContain("persistState");
  });

  it("should clear CDP target bookkeeping on release", () => {
    const body = bodyOf("idleReleaseDebuggers");
    expect(body).toContain("targetSessions.clear()");
    expect(body).toContain("browserContexts.clear()");
  });

  it("should null the injected-script ids so a resume re-injects them", () => {
    // Left set, the re-attach path believes stealth and the framework hooks survived the
    // detach and skips re-injection — the session comes back silently unstealthed.
    const body = bodyOf("idleReleaseDebuggers");
    expect(body).toContain("stealthScriptId = null");
    expect(body).toContain("frameworkHookScriptId = null");
  });

  it("should keep the connected-tab key so the next command can re-attach", () => {
    expect(bodyOf("idleReleaseDebuggers")).not.toContain("crawlio:connectedTab");
  });

  it("should restart capture before clearing a tab's resume record", () => {
    // Clearing first makes a transient failure permanent: the tab is attached by then, so
    // every later ensureDebugger takes its fast path and nothing retries.
    const body = bodyOf("resumeAfterIdleRelease");
    const restart = body.indexOf("startNetworkCapture");
    const clear = body.indexOf("chrome.storage.session.remove");
    expect(restart).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(restart);
  });

  it("should only reclaim foreground capture for a tab that held it", () => {
    expect(bodyOf("resumeAfterIdleRelease")).toContain("makePrimary: entry.wasPrimary");
  });

  it("should make a failed resume retryable rather than permanent", () => {
    // ensureDebugger's fast path returns for an attached tab that already has domain
    // state, so after a failed resume nothing would ever run it again — the session would
    // stay unstealthed while the caller believed otherwise. Dropping the record forces the
    // next command onto the slow path.
    expect(bodyOf("resumeAfterIdleRelease")).toContain("tabDomainState.delete(tabId)");
  });

  it("should not treat a skipped capture start as a successful resume", () => {
    // startNetworkCapture returns false when capture is already owned elsewhere, which
    // means this tab's injected scripts were never reinstalled.
    expect(bodyOf("resumeAfterIdleRelease")).toContain("if (!started)");
  });

  it("should report a failed resume outside dev builds", () => {
    // A __DEV__-only warning means production silently loses stealth.
    const body = bodyOf("resumeAfterIdleRelease");
    expect(body).toMatch(/\n\s*console\.warn\("\[Crawlio\] Idle resume failed/);
  });
});
