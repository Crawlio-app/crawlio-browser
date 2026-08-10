// IndexedDB two-tier storage — heavy data (captures, network, console) goes here.
// Lightweight metadata stays in chrome.storage.session.
// Uses `idb` wrapper (~3KB gzipped, zero transitive deps).

import { openDB } from "idb";
import type { NetworkEntry } from "../shared/types";

interface CrawlioDB {
  captures: {
    key: string;
    value: {
      url: string;
      title?: string;
      framework?: unknown;
      domSnapshot?: unknown;
      consoleLogs?: unknown[];
      networkRequests?: unknown[];
      cookies?: unknown[];
      capturedAt: string;
      dialogCount?: number;
    };
  };
  network: {
    key: string;
    value: NetworkEntry & { requestId: string; _startTime?: number; _seq?: number };
  };
  console: {
    key: number;
    value: { level: string; text: string; timestamp?: number; [key: string]: unknown };
  };
  residentTraining: {
    key: string;
    value: ResidentTrainingRecord;
  };
  monitorJobs: {
    key: string;
    value: ResidentMonitorJob;
  };
  monitorSnapshots: {
    key: string;
    value: ResidentMonitorSnapshot;
  };
}

const DB_NAME = "crawlio-data";
const DB_VERSION = 2;

/**
 * Resident observation is deliberately bounded without `unlimitedStorage`.
 *
 * Twenty-five MiB is enough for useful local history while staying small beside Chrome's normal
 * per-origin quota. Active training is never evicted; completed runs and monitor snapshots leave
 * oldest-first. The per-kind caps keep a stream of tiny records from becoming an unbounded index.
 */
export const RESIDENT_STORAGE_BUDGET_BYTES = 25 * 1024 * 1024;
export const RESIDENT_TRAINING_RUN_LIMIT = 20;
export const RESIDENT_MONITOR_JOB_LIMIT = 50;
export const RESIDENT_MONITOR_SNAPSHOT_LIMIT = 200;
export const RESIDENT_MONITOR_SNAPSHOTS_PER_JOB = 50;

export type ResidentTrainingStatus = "recording" | "stopped" | "interrupted" | "error";

export interface ResidentTrainingRecord {
  runId: string;
  targetUrl: string;
  outputDir: string;
  tabId: number;
  recordingId?: string;
  scriptIdentifier?: string;
  startedAt: string;
  updatedAt: string;
  stoppedAt?: string;
  status: ResidentTrainingStatus;
  captureStorageValues: boolean;
  stateLog: unknown[];
  bundle?: {
    recording: unknown;
    network: unknown[];
    bodies: Record<string, unknown>;
    state: Record<string, unknown>;
  };
  lastError?: string;
}

export type ResidentMonitorStatus = "active" | "paused" | "stopped" | "error";

export interface ResidentMonitorJob {
  monitorId: string;
  url: string;
  tabId: number;
  ownsTab: boolean;
  label?: string;
  intervalMinutes: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  status: ResidentMonitorStatus;
  captureCount: number;
  changeCount: number;
  lastSnapshot?: string;
  lastError?: string;
}

export interface ResidentMonitorSnapshot {
  id: string;
  monitorId: string;
  capturedAt: string;
  url: string;
  title?: string;
  snapshot: string;
  estimatedTokens?: number;
  changed: boolean;
  additions: number;
  removals: number;
  unchanged: number;
  diff: string;
}

function openCrawlioDb() {
  return openDB<CrawlioDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("captures")) {
        db.createObjectStore("captures", { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains("network")) {
        db.createObjectStore("network", { keyPath: "requestId" });
      }
      if (!db.objectStoreNames.contains("console")) {
        db.createObjectStore("console", { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("residentTraining")) {
        db.createObjectStore("residentTraining", { keyPath: "runId" });
      }
      if (!db.objectStoreNames.contains("monitorJobs")) {
        db.createObjectStore("monitorJobs", { keyPath: "monitorId" });
      }
      if (!db.objectStoreNames.contains("monitorSnapshots")) {
        db.createObjectStore("monitorSnapshots", { keyPath: "id" });
      }
    },
  });
}

let dbPromise: ReturnType<typeof openCrawlioDb> | null = null;

function getDb(): ReturnType<typeof openCrawlioDb> {
  dbPromise ??= openCrawlioDb();
  return dbPromise;
}

export async function putCapture(capture: CrawlioDB["captures"]["value"]): Promise<void> {
  const db = await getDb();
  await db.put("captures", capture);
}

export async function getCapture(url: string): Promise<CrawlioDB["captures"]["value"] | undefined> {
  const db = await getDb();
  return db.get("captures", url);
}

export async function putNetworkEntries(entries: CrawlioDB["network"]["value"][]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("network", "readwrite");
  for (const entry of entries) {
    await tx.store.put(entry);
  }
  await tx.done;
}

export async function getNetworkEntries(): Promise<CrawlioDB["network"]["value"][]> {
  const db = await getDb();
  return db.getAll("network");
}

export async function putConsoleLogs(logs: CrawlioDB["console"]["value"][]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("console", "readwrite");
  for (const log of logs) {
    await tx.store.add(log);
  }
  await tx.done;
}

export async function getConsoleLogs(): Promise<CrawlioDB["console"]["value"][]> {
  const db = await getDb();
  return db.getAll("console");
}

/**
 * Start a new live capture with no records from the previous capture session.
 *
 * These stores are also the service-worker restart journal for an in-flight capture. Clearing
 * them at the same moment as the in-memory buffers makes a later rehydrate unambiguous: every
 * record belongs to the currently persisted `networkCapturing` session.
 */
export async function clearLiveCaptureStreams(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["network", "console"], "readwrite");
  await Promise.all([
    tx.objectStore("network").clear(),
    tx.objectStore("console").clear(),
    tx.done,
  ]);
}

export async function clearAll(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["captures", "network", "console"], "readwrite");
  await Promise.all([
    tx.objectStore("captures").clear(),
    tx.objectStore("network").clear(),
    tx.objectStore("console").clear(),
    tx.done,
  ]);
}

export async function clearForUrl(url: string): Promise<void> {
  const db = await getDb();
  await db.delete("captures", url);
}

// --- Extension-resident training and monitoring -----------------------------

export async function putResidentTraining(record: ResidentTrainingRecord): Promise<void> {
  const db = await getDb();
  await db.put("residentTraining", record);
  await pruneResidentStorage();
}

export async function getResidentTraining(runId: string): Promise<ResidentTrainingRecord | undefined> {
  const db = await getDb();
  return db.get("residentTraining", runId);
}

export async function listResidentTraining(): Promise<ResidentTrainingRecord[]> {
  const db = await getDb();
  const records = await db.getAll("residentTraining");
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Delete one retained training record. Canonical bundle files live in the MCP process and are untouched. */
export async function deleteResidentTraining(runId: string): Promise<void> {
  const db = await getDb();
  await db.delete("residentTraining", runId);
}

export async function putMonitorJob(job: ResidentMonitorJob): Promise<void> {
  const db = await getDb();
  await db.put("monitorJobs", job);
}

export async function getMonitorJob(monitorId: string): Promise<ResidentMonitorJob | undefined> {
  const db = await getDb();
  return db.get("monitorJobs", monitorId);
}

export async function listMonitorJobs(): Promise<ResidentMonitorJob[]> {
  const db = await getDb();
  const jobs = await db.getAll("monitorJobs");
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteMonitorJob(monitorId: string): Promise<void> {
  const db = await getDb();
  const snapshots = (await db.getAll("monitorSnapshots")).filter((s) => s.monitorId === monitorId);
  const tx = db.transaction(["monitorJobs", "monitorSnapshots"], "readwrite");
  await Promise.all([
    tx.objectStore("monitorJobs").delete(monitorId),
    ...snapshots.map((s) => tx.objectStore("monitorSnapshots").delete(s.id)),
    tx.done,
  ]);
}

export async function putMonitorSnapshot(snapshot: ResidentMonitorSnapshot): Promise<void> {
  const db = await getDb();
  await db.put("monitorSnapshots", snapshot);
  await pruneResidentStorage();
}

export async function listMonitorSnapshots(monitorId?: string): Promise<ResidentMonitorSnapshot[]> {
  const db = await getDb();
  const snapshots = await db.getAll("monitorSnapshots");
  return snapshots
    .filter((snapshot) => !monitorId || snapshot.monitorId === monitorId)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

function storedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return RESIDENT_STORAGE_BUDGET_BYTES;
  }
}

export interface ResidentStorageStats {
  bytes: number;
  trainingRuns: number;
  monitorJobs: number;
  monitorSnapshots: number;
  evictedTrainingRuns: number;
  evictedMonitorJobs: number;
  evictedMonitorSnapshots: number;
}

export interface ResidentEvictionPlan {
  trainingRunIds: Set<string>;
  monitorJobIds: Set<string>;
  snapshotIds: Set<string>;
  bytes: number;
}

/** Pure retention planner; exported so count/budget invariants can be tested without IndexedDB. */
export function planResidentEvictions(
  training: ResidentTrainingRecord[],
  jobs: ResidentMonitorJob[],
  snapshots: ResidentMonitorSnapshot[],
  budgetBytes = RESIDENT_STORAGE_BUDGET_BYTES,
): ResidentEvictionPlan {
  const deletableTraining = training
    .filter((run) => run.status !== "recording")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const deletableJobs = jobs
    .filter((job) => job.status !== "active" && job.status !== "paused")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const oldestSnapshots = [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const trainingRunIds = new Set<string>();
  const monitorJobIds = new Set<string>();
  const snapshotIds = new Set<string>();

  while (training.length - trainingRunIds.size > RESIDENT_TRAINING_RUN_LIMIT && deletableTraining.length) {
    trainingRunIds.add(deletableTraining.shift()!.runId);
  }

  while (jobs.length - monitorJobIds.size > RESIDENT_MONITOR_JOB_LIMIT && deletableJobs.length) {
    const job = deletableJobs.shift()!;
    monitorJobIds.add(job.monitorId);
    for (const snapshot of snapshots) {
      if (snapshot.monitorId === job.monitorId) snapshotIds.add(snapshot.id);
    }
  }

  while (snapshots.length - snapshotIds.size > RESIDENT_MONITOR_SNAPSHOT_LIMIT && oldestSnapshots.length) {
    snapshotIds.add(oldestSnapshots.shift()!.id);
  }

  for (const job of jobs) {
    if (monitorJobIds.has(job.monitorId)) continue;
    const perJob = snapshots
      .filter((snapshot) => snapshot.monitorId === job.monitorId && !snapshotIds.has(snapshot.id))
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    while (perJob.length > RESIDENT_MONITOR_SNAPSHOTS_PER_JOB) {
      snapshotIds.add(perJob.shift()!.id);
    }
  }

  let bytes = training
    .filter((run) => !trainingRunIds.has(run.runId))
    .reduce((sum, run) => sum + storedBytes(run), 0)
    + snapshots
      .filter((snapshot) => !snapshotIds.has(snapshot.id))
      .reduce((sum, snapshot) => sum + storedBytes(snapshot), 0)
    + jobs
      .filter((job) => !monitorJobIds.has(job.monitorId))
      .reduce((sum, job) => sum + storedBytes(job), 0);

  const byteCandidates: Array<{
    kind: "training" | "job" | "snapshot";
    id: string;
    bytes: number;
    timestamp: string;
  }> = [
    ...deletableTraining
      .filter((run) => !trainingRunIds.has(run.runId))
      .map((run) => ({ kind: "training" as const, id: run.runId, bytes: storedBytes(run), timestamp: run.updatedAt })),
    ...deletableJobs
      .filter((job) => !monitorJobIds.has(job.monitorId))
      .map((job) => ({ kind: "job" as const, id: job.monitorId, bytes: storedBytes(job), timestamp: job.updatedAt })),
    ...oldestSnapshots
      .filter((snapshot) => !snapshotIds.has(snapshot.id))
      .map((snapshot) => ({ kind: "snapshot" as const, id: snapshot.id, bytes: storedBytes(snapshot), timestamp: snapshot.capturedAt })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  while (bytes > budgetBytes && byteCandidates.length) {
    const candidate = byteCandidates.shift()!;
    if (candidate.kind === "training") {
      if (trainingRunIds.has(candidate.id)) continue;
      trainingRunIds.add(candidate.id);
      bytes -= candidate.bytes;
    } else if (candidate.kind === "snapshot") {
      if (snapshotIds.has(candidate.id)) continue;
      snapshotIds.add(candidate.id);
      bytes -= candidate.bytes;
    } else {
      if (monitorJobIds.has(candidate.id)) continue;
      monitorJobIds.add(candidate.id);
      bytes -= candidate.bytes;
      for (const snapshot of snapshots) {
        if (snapshot.monitorId !== candidate.id || snapshotIds.has(snapshot.id)) continue;
        snapshotIds.add(snapshot.id);
        bytes -= storedBytes(snapshot);
      }
    }
  }

  return { trainingRunIds, monitorJobIds, snapshotIds, bytes: Math.max(0, bytes) };
}

/** Enforce count and byte budgets, evicting only completed data, oldest first. */
export async function pruneResidentStorage(
  budgetBytes = RESIDENT_STORAGE_BUDGET_BYTES,
): Promise<ResidentStorageStats> {
  const db = await getDb();
  const training = await db.getAll("residentTraining");
  const snapshots = await db.getAll("monitorSnapshots");
  const jobs = await db.getAll("monitorJobs");
  const plan = planResidentEvictions(training, jobs, snapshots, budgetBytes);
  const trainingDelete = plan.trainingRunIds;
  const jobDelete = plan.monitorJobIds;
  const snapshotDelete = plan.snapshotIds;

  if (trainingDelete.size || jobDelete.size || snapshotDelete.size) {
    const tx = db.transaction(["residentTraining", "monitorJobs", "monitorSnapshots"], "readwrite");
    await Promise.all([
      ...[...trainingDelete].map((id) => tx.objectStore("residentTraining").delete(id)),
      ...[...jobDelete].map((id) => tx.objectStore("monitorJobs").delete(id)),
      ...[...snapshotDelete].map((id) => tx.objectStore("monitorSnapshots").delete(id)),
      tx.done,
    ]);
  }

  return {
    bytes: plan.bytes,
    trainingRuns: training.length - trainingDelete.size,
    monitorJobs: jobs.length - jobDelete.size,
    monitorSnapshots: snapshots.length - snapshotDelete.size,
    evictedTrainingRuns: trainingDelete.size,
    evictedMonitorJobs: jobDelete.size,
    evictedMonitorSnapshots: snapshotDelete.size,
  };
}
