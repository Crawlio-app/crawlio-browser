import type { ResidentMonitorJob } from "./capture-store";

export const LEGACY_RESIDENT_OBSERVATION_ENABLED_KEY = "crawlio:residentObservationEnabled";

interface ResidentObservationMigrationDependencies {
  removeLegacyPreference: (key: string) => Promise<void>;
  listMonitors: () => Promise<ResidentMonitorJob[]>;
  saveMonitor: (monitor: ResidentMonitorJob) => Promise<void>;
  armMonitor: (monitor: ResidentMonitorJob) => void | Promise<void>;
  clearMonitorAlarm: (monitorId: string) => void | Promise<void>;
  now?: () => string;
}

/**
 * Retire the development-only popup master switch without preserving a hidden global pause.
 *
 * `paused` was only ever written by that switch; no MCP pause action existed. Explicitly started
 * monitors therefore return to their MCP-owned active lifecycle, while stopped/error jobs remain
 * stopped. Dependencies keep the migration directly testable without loading the MV3 worker.
 */
export async function migrateLegacyResidentObservationState(
  dependencies: ResidentObservationMigrationDependencies,
): Promise<ResidentMonitorJob[]> {
  await dependencies.removeLegacyPreference(LEGACY_RESIDENT_OBSERVATION_ENABLED_KEY);
  const monitors = await dependencies.listMonitors();
  const restored: ResidentMonitorJob[] = [];

  for (const monitor of monitors) {
    const next = monitor.status === "paused"
      ? { ...monitor, status: "active" as const, updatedAt: (dependencies.now ?? (() => new Date().toISOString()))() }
      : monitor;
    if (next.status === "active") await dependencies.armMonitor(next);
    else await dependencies.clearMonitorAlarm(next.monitorId);
    await dependencies.saveMonitor(next);
    restored.push(next);
  }

  return restored;
}
