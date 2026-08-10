import { describe, it, expect } from "vitest";
import {
  normalizePhaseReport,
  appendPhaseReport,
  MAX_PHASE_HISTORY,
  MAX_PHASE_LABEL,
  type JobProgress,
} from "../../src/shared/job-progress.js";

const AT = 1_700_000_000_000;

describe("normalizePhaseReport", () => {
  it("should accept a label alone", () => {
    expect(normalizePhaseReport("crawling", undefined, AT)).toEqual({ phase: "crawling", at: AT });
  });

  it("should accept a label with a percentage", () => {
    expect(normalizePhaseReport("crawling", 40, AT)).toEqual({ phase: "crawling", percent: 40, at: AT });
  });

  it("should reject a report with no usable label", () => {
    // The reporter is untrusted code. A malformed call yields nothing rather than a phase named
    // "undefined" or "[object Object]" showing up in a poll response.
    for (const junk of [undefined, null, 42, {}, [], true, Symbol("x")]) {
      expect(normalizePhaseReport(junk, 10, AT)).toBeNull();
    }
    expect(normalizePhaseReport("", 10, AT)).toBeNull();
    expect(normalizePhaseReport("   ", 10, AT)).toBeNull();
  });

  it("should clamp a label long enough to be a payload", () => {
    const r = normalizePhaseReport("x".repeat(5000), undefined, AT);
    expect(r?.phase).toHaveLength(MAX_PHASE_LABEL);
  });

  it("should clamp percent into 0-100 rather than reject the report", () => {
    // Losing the label because the percentage was wrong would be the worse trade.
    expect(normalizePhaseReport("p", -50, AT)?.percent).toBe(0);
    expect(normalizePhaseReport("p", 1000, AT)?.percent).toBe(100);
    expect(normalizePhaseReport("p", 33.7, AT)?.percent).toBe(34);
  });

  it("should drop a non-finite or non-numeric percent, keeping the phase", () => {
    for (const junk of [NaN, Infinity, -Infinity, "50", null, {}]) {
      const r = normalizePhaseReport("p", junk, AT);
      expect(r?.phase).toBe("p");
      expect(r?.percent).toBeUndefined();
    }
  });

  it("should trim surrounding whitespace", () => {
    expect(normalizePhaseReport("  crawling  ", undefined, AT)?.phase).toBe("crawling");
  });
});

describe("appendPhaseReport", () => {
  const report = (phase: string, at = AT): ReturnType<typeof normalizePhaseReport> =>
    normalizePhaseReport(phase, undefined, at);

  it("should start a history from nothing", () => {
    const p = appendPhaseReport(undefined, report("one")!);
    expect(p.current.phase).toBe("one");
    expect(p.history).toHaveLength(1);
    expect(p.reports).toBe(1);
  });

  it("should track the latest as current", () => {
    let p: JobProgress | undefined;
    for (const n of ["one", "two", "three"]) p = appendPhaseReport(p, report(n)!);
    expect(p!.current.phase).toBe("three");
    expect(p!.history.map((h) => h.phase)).toEqual(["one", "two", "three"]);
  });

  it("should bound history against a reporter that never stops", () => {
    // The whole point: untrusted code calling reportPhase in a loop must cost constant memory.
    let p: JobProgress | undefined;
    for (let i = 0; i < 10_000; i++) p = appendPhaseReport(p, report(`phase-${i}`)!);
    expect(p!.history).toHaveLength(MAX_PHASE_HISTORY);
    expect(p!.current.phase).toBe("phase-9999");
    expect(p!.history[p!.history.length - 1].phase).toBe("phase-9999");
  });

  it("should count every report, including the ones history dropped", () => {
    let p: JobProgress | undefined;
    for (let i = 0; i < 100; i++) p = appendPhaseReport(p, report(`p${i}`)!);
    expect(p!.reports).toBe(100);
    expect(p!.history).toHaveLength(MAX_PHASE_HISTORY);
  });

  it("should keep history oldest-first so it reads as a timeline", () => {
    let p: JobProgress | undefined;
    for (let i = 0; i < MAX_PHASE_HISTORY + 5; i++) p = appendPhaseReport(p, report(`p${i}`, AT + i)!);
    const times = p!.history.map((h) => h.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("should not mutate the progress it was given", () => {
    const first = appendPhaseReport(undefined, report("one")!);
    const second = appendPhaseReport(first, report("two")!);
    expect(first.history).toHaveLength(1);
    expect(first.current.phase).toBe("one");
    expect(second.history).toHaveLength(2);
  });
});
