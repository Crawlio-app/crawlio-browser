import { describe, expect, it } from "vitest";
import {
  planResidentEvictions,
  RESIDENT_MONITOR_SNAPSHOTS_PER_JOB,
  type ResidentMonitorJob,
  type ResidentMonitorSnapshot,
  type ResidentTrainingRecord,
} from "@/extension/capture-store";

const at = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();

function training(index: number, status: ResidentTrainingRecord["status"]): ResidentTrainingRecord {
  return {
    runId: `run-${index}`,
    targetUrl: "https://example.com/",
    outputDir: `/tmp/run-${index}`,
    tabId: index + 1,
    startedAt: at(index),
    updatedAt: at(index),
    status,
    captureStorageValues: false,
    stateLog: [],
  };
}

function job(index: number, status: ResidentMonitorJob["status"]): ResidentMonitorJob {
  return {
    monitorId: `job-${index}`,
    url: "https://example.com/",
    tabId: index + 1,
    ownsTab: true,
    intervalMinutes: 5,
    createdAt: at(index),
    updatedAt: at(index),
    status,
    captureCount: 0,
    changeCount: 0,
  };
}

function snapshot(jobIndex: number, index: number): ResidentMonitorSnapshot {
  return {
    id: `job-${jobIndex}:snapshot-${index}`,
    monitorId: `job-${jobIndex}`,
    capturedAt: at(index),
    url: "https://example.com/",
    snapshot: `snapshot ${index}`,
    changed: false,
    additions: 0,
    removals: 0,
    unchanged: 1,
    diff: "",
  };
}

describe("resident observation retention", () => {
  it("evicts oldest completed runs/jobs at count caps and never active work", () => {
    const trainingRuns = [training(-1, "recording"), ...Array.from({ length: 22 }, (_, index) => training(index, "stopped"))];
    const jobs = [job(-1, "active"), ...Array.from({ length: 51 }, (_, index) => job(index, "stopped"))];
    const snapshots = jobs.flatMap((item, index) => [snapshot(Number(item.monitorId.slice(4)), index)]);

    const plan = planResidentEvictions(trainingRuns, jobs, snapshots, Number.MAX_SAFE_INTEGER);

    expect(plan.trainingRunIds.has("run--1")).toBe(false);
    expect(plan.trainingRunIds).toEqual(new Set(["run-0", "run-1", "run-2"]));
    expect(plan.monitorJobIds.has("job--1")).toBe(false);
    expect(plan.monitorJobIds).toEqual(new Set(["job-0", "job-1"]));
    expect(plan.snapshotIds.has("job-0:snapshot-1")).toBe(true);
    expect(plan.snapshotIds.has("job-1:snapshot-2")).toBe(true);
  });

  it("keeps only the newest per-monitor snapshot window", () => {
    const monitor = job(0, "active");
    const snapshots = Array.from(
      { length: RESIDENT_MONITOR_SNAPSHOTS_PER_JOB + 5 },
      (_, index) => snapshot(0, index),
    );
    const plan = planResidentEvictions([], [monitor], snapshots, Number.MAX_SAFE_INTEGER);

    expect(plan.snapshotIds).toEqual(new Set([
      "job-0:snapshot-0",
      "job-0:snapshot-1",
      "job-0:snapshot-2",
      "job-0:snapshot-3",
      "job-0:snapshot-4",
    ]));
  });

  it("may remain over the byte budget rather than silently evict an active run", () => {
    const active = training(0, "recording");
    active.stateLog = [{ payload: "x".repeat(5_000) }];
    const completed = training(1, "stopped");
    completed.stateLog = [{ payload: "y".repeat(5_000) }];

    const plan = planResidentEvictions([active, completed], [], [], 1);

    expect(plan.trainingRunIds.has("run-1")).toBe(true);
    expect(plan.trainingRunIds.has("run-0")).toBe(false);
    expect(plan.bytes).toBeGreaterThan(1);
  });
});
