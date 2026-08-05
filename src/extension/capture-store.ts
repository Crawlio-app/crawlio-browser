// IndexedDB two-tier storage — heavy data (captures, network, console) goes here.
// Lightweight metadata stays in chrome.storage.session.
// Uses `idb` wrapper (~3KB gzipped, zero transitive deps).

import { openDB } from "idb";

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
    value: { requestId: string; [key: string]: unknown };
  };
  console: {
    key: number;
    value: { level: string; text: string; timestamp?: number; [key: string]: unknown };
  };
}

const DB_NAME = "crawlio-data";
const DB_VERSION = 1;

const dbPromise = openDB<CrawlioDB>(DB_NAME, DB_VERSION, {
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
  },
});

export async function putCapture(capture: CrawlioDB["captures"]["value"]): Promise<void> {
  const db = await dbPromise;
  await db.put("captures", capture);
}

export async function getCapture(url: string): Promise<CrawlioDB["captures"]["value"] | undefined> {
  const db = await dbPromise;
  return db.get("captures", url);
}

export async function putNetworkEntries(entries: CrawlioDB["network"]["value"][]): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction("network", "readwrite");
  for (const entry of entries) {
    await tx.store.put(entry);
  }
  await tx.done;
}

export async function getNetworkEntries(): Promise<CrawlioDB["network"]["value"][]> {
  const db = await dbPromise;
  return db.getAll("network");
}

export async function putConsoleLogs(logs: CrawlioDB["console"]["value"][]): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction("console", "readwrite");
  for (const log of logs) {
    await tx.store.add(log);
  }
  await tx.done;
}

export async function getConsoleLogs(): Promise<CrawlioDB["console"]["value"][]> {
  const db = await dbPromise;
  return db.getAll("console");
}

export async function clearAll(): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction(["captures", "network", "console"], "readwrite");
  await Promise.all([
    tx.objectStore("captures").clear(),
    tx.objectStore("network").clear(),
    tx.objectStore("console").clear(),
    tx.done,
  ]);
}

export async function clearForUrl(url: string): Promise<void> {
  const db = await dbPromise;
  await db.delete("captures", url);
}
