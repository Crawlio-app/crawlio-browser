import { describe, it, expect } from "vitest";
import { detectDuplicates } from "../../src/mcp-server/tracking-parser";
import type { TrackingPixelEvent } from "../../src/shared/evidence-types";

function makeEvent(overrides: Partial<TrackingPixelEvent> = {}): TrackingPixelEvent {
  return {
    vendor: "facebook",
    pixelId: "123",
    eventName: "Purchase",
    eventType: "standard",
    parameters: {},
    url: "https://example.com/checkout",
    method: "GET",
    timestamp: Date.now(),
    requestUrl: "https://www.facebook.com/tr?ev=Purchase",
    ...overrides,
  };
}

describe("detectDuplicates", () => {
  it("returns empty array for no events", () => {
    expect(detectDuplicates([])).toEqual([]);
  });

  it("returns empty array for single events (no duplicates)", () => {
    const events = [
      makeEvent({ eventName: "Purchase" }),
      makeEvent({ eventName: "AddToCart" }),
      makeEvent({ eventName: "ViewContent" }),
    ];
    expect(detectDuplicates(events)).toEqual([]);
  });

  it("detects duplicate events with same vendor+pixelId+eventName+url", () => {
    const now = Date.now();
    const events = [
      makeEvent({ eventName: "Purchase", timestamp: now }),
      makeEvent({ eventName: "Purchase", timestamp: now + 100 }),
    ];
    const clusters = detectDuplicates(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].vendor).toBe("facebook");
    expect(clusters[0].pixelId).toBe("123");
    expect(clusters[0].eventName).toBe("Purchase");
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].timestamps).toHaveLength(2);
  });

  it("does not flag PageView as duplicate (SPA behavior)", () => {
    const events = [
      makeEvent({ eventName: "PageView" }),
      makeEvent({ eventName: "PageView" }),
      makeEvent({ eventName: "PageView" }),
    ];
    expect(detectDuplicates(events)).toEqual([]);
  });

  it("does not flag page_view as duplicate (GA4 SPA behavior)", () => {
    const events = [
      makeEvent({ vendor: "ga4", eventName: "page_view" }),
      makeEvent({ vendor: "ga4", eventName: "page_view" }),
    ];
    expect(detectDuplicates(events)).toEqual([]);
  });

  it("groups by vendor separately", () => {
    const events = [
      makeEvent({ vendor: "facebook", eventName: "Purchase" }),
      makeEvent({ vendor: "ga4", eventName: "Purchase" }),
    ];
    expect(detectDuplicates(events)).toEqual([]);
  });

  it("groups by pixelId separately", () => {
    const events = [
      makeEvent({ pixelId: "111", eventName: "Purchase" }),
      makeEvent({ pixelId: "222", eventName: "Purchase" }),
    ];
    expect(detectDuplicates(events)).toEqual([]);
  });

  it("groups by URL separately", () => {
    const events = [
      makeEvent({ url: "https://a.com", eventName: "Purchase" }),
      makeEvent({ url: "https://b.com", eventName: "Purchase" }),
    ];
    expect(detectDuplicates(events)).toEqual([]);
  });

  it("detects multiple duplicate clusters", () => {
    const events = [
      makeEvent({ eventName: "Purchase" }),
      makeEvent({ eventName: "Purchase" }),
      makeEvent({ eventName: "AddToCart" }),
      makeEvent({ eventName: "AddToCart" }),
      makeEvent({ eventName: "AddToCart" }),
    ];
    const clusters = detectDuplicates(events);
    expect(clusters).toHaveLength(2);
    const purchase = clusters.find(c => c.eventName === "Purchase")!;
    const atc = clusters.find(c => c.eventName === "AddToCart")!;
    expect(purchase.count).toBe(2);
    expect(atc.count).toBe(3);
  });

  it("detects triple+ fires correctly", () => {
    const events = [
      makeEvent({ eventName: "Lead" }),
      makeEvent({ eventName: "Lead" }),
      makeEvent({ eventName: "Lead" }),
      makeEvent({ eventName: "Lead" }),
    ];
    const clusters = detectDuplicates(events);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(4);
  });

  it("preserves timestamps in order", () => {
    const events = [
      makeEvent({ eventName: "Purchase", timestamp: 1000 }),
      makeEvent({ eventName: "Purchase", timestamp: 2000 }),
      makeEvent({ eventName: "Purchase", timestamp: 3000 }),
    ];
    const clusters = detectDuplicates(events);
    expect(clusters[0].timestamps).toEqual([1000, 2000, 3000]);
  });

  it("handles mixed vendors and events", () => {
    const events = [
      makeEvent({ vendor: "facebook", eventName: "Purchase", pixelId: "111" }),
      makeEvent({ vendor: "facebook", eventName: "Purchase", pixelId: "111" }),
      makeEvent({ vendor: "ga4", eventName: "purchase", pixelId: "GA-1" }),
      makeEvent({ vendor: "tiktok", eventName: "CompletePayment", pixelId: "TT-1" }),
      makeEvent({ vendor: "tiktok", eventName: "CompletePayment", pixelId: "TT-1" }),
    ];
    const clusters = detectDuplicates(events);
    expect(clusters).toHaveLength(2);
    expect(clusters.find(c => c.vendor === "facebook")).toBeDefined();
    expect(clusters.find(c => c.vendor === "tiktok")).toBeDefined();
    expect(clusters.find(c => c.vendor === "ga4")).toBeUndefined(); // only 1 fire
  });
});
