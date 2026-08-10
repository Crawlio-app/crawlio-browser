import { describe, expect, it, vi } from "vitest";
import type { ResidentMonitorJob } from "../../src/extension/capture-store.js";
import {
  LEGACY_RESIDENT_OBSERVATION_ENABLED_KEY,
  migrateLegacyResidentObservationState,
} from "../../src/extension/resident-observation-migration.js";

function monitor(monitorId: string, status: ResidentMonitorJob["status"]): ResidentMonitorJob {
  return {
    monitorId,
    url: "https://example.com/",
    tabId: 101,
    ownsTab: true,
    intervalMinutes: 5,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    status,
    captureCount: 0,
    changeCount: 0,
  };
}

describe("legacy resident-observation migration", () => {
  it("removes the retired preference and restores only master-switch-paused monitors", async () => {
    const localStorage = new Map<string, unknown>([[LEGACY_RESIDENT_OBSERVATION_ENABLED_KEY, false]]);
    const paused = monitor("mon_paused", "paused");
    const stopped = monitor("mon_stopped", "stopped");
    const saved: ResidentMonitorJob[] = [];
    const armed: string[] = [];
    const cleared: string[] = [];

    const result = await migrateLegacyResidentObservationState({
      removeLegacyPreference: async (key) => { localStorage.delete(key); },
      listMonitors: async () => [paused, stopped],
      saveMonitor: async (job) => { saved.push(job); },
      armMonitor: (job) => { armed.push(job.monitorId); },
      clearMonitorAlarm: (monitorId) => { cleared.push(monitorId); },
      now: () => "2026-08-09T00:00:00.000Z",
    });

    expect(localStorage.has(LEGACY_RESIDENT_OBSERVATION_ENABLED_KEY)).toBe(false);
    expect(result).toEqual([
      { ...paused, status: "active", updatedAt: "2026-08-09T00:00:00.000Z" },
      stopped,
    ]);
    expect(saved).toEqual(result);
    expect(armed).toEqual(["mon_paused"]);
    expect(cleared).toEqual(["mon_stopped"]);
  });

  it("is idempotent after the legacy preference and paused state are gone", async () => {
    const active = monitor("mon_active", "active");
    const removeLegacyPreference = vi.fn(async () => {});
    const saveMonitor = vi.fn(async () => {});
    const armMonitor = vi.fn();

    const result = await migrateLegacyResidentObservationState({
      removeLegacyPreference,
      listMonitors: async () => [active],
      saveMonitor,
      armMonitor,
      clearMonitorAlarm: vi.fn(),
    });

    expect(result).toEqual([active]);
    expect(removeLegacyPreference).toHaveBeenCalledWith(LEGACY_RESIDENT_OBSERVATION_ENABLED_KEY);
    expect(armMonitor).toHaveBeenCalledWith(active);
    expect(saveMonitor).toHaveBeenCalledWith(active);
  });
});
