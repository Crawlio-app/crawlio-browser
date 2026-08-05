import { describe, it, expect, beforeEach } from "vitest";
import { EnrichmentAccumulator, estimateSize, SESSION_QUOTA_BYTES } from "@/extension/enrichment-store";
describe("EnrichmentAccumulator", () => {
  let store: EnrichmentAccumulator;

  beforeEach(() => {
    store = new EnrichmentAccumulator();
  });

  it("upserts and retrieves by URL", () => {
    store.upsert("https://example.com", { title: "Example" });
    const entry = store.get("https://example.com");
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Example");
  });

  it("normalizes URL keys (fragment stripping)", () => {
    store.upsert("https://example.com/page#section", { title: "Page" });
    const entry = store.get("https://example.com/page");
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Page");
  });

  it("merges data on upsert to same URL", () => {
    store.upsert("https://example.com", { title: "V1" });
    store.upsert("https://example.com", { title: "V2", framework: { name: "React" } });
    const entry = store.get("https://example.com");
    expect(entry!.title).toBe("V2");
    expect(entry!.framework).toEqual({ name: "React" });
  });

  it("returns undefined for unknown URLs", () => {
    expect(store.get("https://unknown.com")).toBeUndefined();
  });

  it("counts entries correctly", () => {
    store.upsert("https://a.com", { title: "A" });
    store.upsert("https://b.com", { title: "B" });
    expect(store.count()).toBe(2);
  });

  it("clears all entries", () => {
    store.upsert("https://a.com", { title: "A" });
    store.clear();
    expect(store.count()).toBe(0);
    expect(store.get("https://a.com")).toBeUndefined();
  });

  it("flushes all entries and empties store", () => {
    store.upsert("https://a.com", { title: "A" });
    store.upsert("https://b.com", { title: "B" });
    const flushed = store.flush();
    expect(flushed).toHaveLength(2);
    expect(store.count()).toBe(0);
  });

  it("reports quota status", () => {
    store.upsert("https://example.com", { title: "Test" });
    const status = store.getQuotaStatus();
    expect(status.quotaBytes).toBe(SESSION_QUOTA_BYTES);
    expect(status.entryCount).toBe(1);
    expect(status.estimatedBytes).toBeGreaterThan(0);
    expect(status.usageRatio).toBeGreaterThan(0);
  });

  it("checks quota for additional bytes", () => {
    expect(store.checkQuota(100)).toBe(true);
    expect(store.checkQuota(SESSION_QUOTA_BYTES)).toBe(false);
  });
});

describe("estimateSize", () => {
  it("estimates string size (JSON length * 2 for UTF-16)", () => {
    expect(estimateSize("hello")).toBe(JSON.stringify("hello").length * 2);
  });

  it("estimates object size", () => {
    const obj = { a: 1, b: "test" };
    expect(estimateSize(obj)).toBe(JSON.stringify(obj).length * 2);
  });

  it("returns 0 for circular references", () => {
    const obj: any = {};
    obj.self = obj;
    expect(estimateSize(obj)).toBe(0);
  });
});
