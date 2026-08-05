import { describe, it, expect } from "vitest";
import { inspectDataLayer } from "../../src/extension/injected/datalayer-inspector";

// The inspector runs in page context via Runtime.evaluate.
// We simulate window globals to test the extraction logic.

function runInspector(globals: Record<string, unknown> = {}): ReturnType<typeof inspectDataLayer> {
  const originalWindow = globalThis.window;
  // Stub window with the provided globals
  const fakeWindow: Record<string, unknown> = { ...globals };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, writable: true, configurable: true });
  // Also stub document.cookie for hasCookie (not used here but safety)
  if (!fakeWindow.document) {
    fakeWindow.document = { cookie: "" };
  }
  try {
    return inspectDataLayer();
  } finally {
    Object.defineProperty(globalThis, "window", { value: originalWindow, writable: true, configurable: true });
  }
}

describe("DataLayer Inspector", () => {
  describe("empty page (no trackers)", () => {
    it("returns all null when no trackers present", () => {
      const result = runInspector({});
      expect(result.facebook).toBeNull();
      expect(result.ga4).toBeNull();
      expect(result.gtm).toBeNull();
      expect(result.tiktok).toBeNull();
    });
  });

  describe("Facebook Pixel", () => {
    it("detects fbq function with loaded state", () => {
      const fbq = Object.assign(function() {}, {
        loaded: true,
        version: "2.9.145",
        queue: [],
        pixelsByID: { "123456789": {} },
      });
      const result = runInspector({ fbq });
      expect(result.facebook).toEqual({
        loaded: true,
        version: "2.9.145",
        pixelIds: ["123456789"],
        queueLength: 0,
      });
    });

    it("extracts pixel IDs from queue init calls", () => {
      const fbq = Object.assign(function() {}, {
        loaded: false,
        version: null,
        queue: [
          ["init", "111111111"],
          ["track", "PageView"],
          ["init", "222222222"],
          ["init", "111111111"], // duplicate — should be deduped
        ],
      });
      const result = runInspector({ fbq });
      expect(result.facebook!.pixelIds).toEqual(["111111111", "222222222"]);
      expect(result.facebook!.queueLength).toBe(4);
    });

    it("detects _fbq backup reference", () => {
      const _fbq = Object.assign(function() {}, {
        loaded: true,
        queue: [],
      });
      const result = runInspector({ _fbq });
      expect(result.facebook).not.toBeNull();
      expect(result.facebook!.loaded).toBe(true);
    });

    it("merges pixelsByID with queue init calls", () => {
      const fbq = Object.assign(function() {}, {
        loaded: true,
        queue: [["init", "AAA"]],
        pixelsByID: { "BBB": {} },
      });
      const result = runInspector({ fbq });
      expect(result.facebook!.pixelIds).toContain("AAA");
      expect(result.facebook!.pixelIds).toContain("BBB");
    });
  });

  describe("GA4 / dataLayer", () => {
    it("detects dataLayer array with events", () => {
      const dataLayer = [
        { event: "gtm.js" },
        { event: "page_view" },
        { someProp: "value" }, // no event — skipped
        { event: "purchase" },
      ];
      const result = runInspector({ dataLayer });
      expect(result.ga4).toEqual({
        dataLayerLength: 4,
        events: ["gtm.js", "page_view", "purchase"],
        gtag: false,
        gaLegacy: false,
      });
    });

    it("limits to last 50 events", () => {
      const dataLayer = Array.from({ length: 100 }, (_, i) => ({ event: `event_${i}` }));
      const result = runInspector({ dataLayer });
      expect(result.ga4!.events.length).toBe(50);
      expect(result.ga4!.events[0]).toBe("event_50");
      expect(result.ga4!.events[49]).toBe("event_99");
      expect(result.ga4!.dataLayerLength).toBe(100);
    });

    it("detects gtag function", () => {
      const result = runInspector({
        dataLayer: [],
        gtag: function() {},
      });
      expect(result.ga4!.gtag).toBe(true);
    });

    it("detects legacy GA", () => {
      const result = runInspector({
        dataLayer: [],
        ga: function() {},
      });
      expect(result.ga4!.gaLegacy).toBe(true);
    });

    it("detects GA_INITIALIZED flag", () => {
      const result = runInspector({
        dataLayer: [],
        GA_INITIALIZED: true,
      });
      expect(result.ga4!.gaLegacy).toBe(true);
    });

    it("returns null when dataLayer absent", () => {
      const result = runInspector({});
      expect(result.ga4).toBeNull();
    });
  });

  describe("GTM containers", () => {
    it("detects GTM- prefixed containers", () => {
      const result = runInspector({
        google_tag_manager: {
          "GTM-ABC123": {},
          "GTM-DEF456": {},
          "dataLayer": {}, // not a container — excluded
        },
      });
      expect(result.gtm).toEqual({
        containers: ["GTM-ABC123", "GTM-DEF456"],
      });
    });

    it("detects G- prefixed measurement IDs", () => {
      const result = runInspector({
        google_tag_manager: {
          "G-XXXXXXXX": {},
        },
      });
      expect(result.gtm!.containers).toEqual(["G-XXXXXXXX"]);
    });

    it("returns null when no GTM-/G- keys found", () => {
      const result = runInspector({
        google_tag_manager: {
          "dataLayer": {},
        },
      });
      expect(result.gtm).toBeNull();
    });

    it("returns null when google_tag_manager absent", () => {
      const result = runInspector({});
      expect(result.gtm).toBeNull();
    });
  });

  describe("TikTok Pixel", () => {
    it("detects ttq object", () => {
      const result = runInspector({
        ttq: { queue: [1, 2, 3] },
      });
      expect(result.tiktok).toEqual({
        loaded: true,
        queueLength: 3,
      });
    });

    it("handles ttq without queue", () => {
      const result = runInspector({
        ttq: {},
      });
      expect(result.tiktok).toEqual({
        loaded: true,
        queueLength: 0,
      });
    });

    it("returns null when ttq absent", () => {
      const result = runInspector({});
      expect(result.tiktok).toBeNull();
    });
  });

  describe("multiple trackers", () => {
    it("detects all trackers simultaneously", () => {
      const fbq = Object.assign(function() {}, { loaded: true, queue: [], pixelsByID: { "999": {} } });
      const result = runInspector({
        fbq,
        dataLayer: [{ event: "page_view" }],
        google_tag_manager: { "GTM-TEST": {} },
        gtag: function() {},
        ttq: { queue: [] },
      });
      expect(result.facebook).not.toBeNull();
      expect(result.ga4).not.toBeNull();
      expect(result.gtm).not.toBeNull();
      expect(result.tiktok).not.toBeNull();
    });
  });
});
