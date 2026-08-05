import { describe, it, expect } from "vitest";
import { validateTrackingEvents } from "../../src/mcp-server/tracking-validator";
import type { TrackingPixelEvent, TrackingParseResult } from "../../src/shared/evidence-types";
import { isValidCurrency, isNumericParam } from "../../src/mcp-server/tracking-schemas";

function makeEvent(overrides: Partial<TrackingPixelEvent>): TrackingPixelEvent {
  return {
    vendor: "facebook",
    pixelId: "123456",
    eventName: "PageView",
    eventType: "standard",
    parameters: {},
    url: "https://example.com",
    method: "GET",
    timestamp: Date.now(),
    requestUrl: "https://www.facebook.com/tr?id=123456&ev=PageView",
    ...overrides,
  };
}

function makeParseResult(events: TrackingPixelEvent[]): TrackingParseResult {
  return {
    totalPixelFires: events.length,
    vendors: [...new Set(events.map(e => e.vendor))],
    pixels: [],
    events,
    unrecognizedTrackingUrls: [],
  };
}

describe("validateTrackingEvents", () => {
  describe("empty/clean cases", () => {
    it("returns healthy with no issues for empty events", () => {
      const result = validateTrackingEvents(makeParseResult([]));
      expect(result.isHealthy).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.errorCount).toBe(0);
      expect(result.warningCount).toBe(0);
      expect(result.infoCount).toBe(0);
    });

    it("returns healthy for PageView with no params (no required/recommended)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
      ]));
      expect(result.isHealthy).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("returns healthy for Purchase with all required params", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "Purchase",
          parameters: { value: "29.99", currency: "USD", content_ids: "prod_1", content_type: "product" },
        }),
      ]));
      expect(result.isHealthy).toBe(true);
      expect(result.errorCount).toBe(0);
    });
  });

  describe("missing required params (error)", () => {
    it("flags Purchase without value", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "Purchase", parameters: { currency: "USD" } }),
      ]));
      expect(result.isHealthy).toBe(false);
      expect(result.errorCount).toBe(1);
      const err = result.issues.find(i => i.severity === "error");
      expect(err).toBeDefined();
      expect(err!.code).toBe("MISSING_REQUIRED_PARAM");
      expect(err!.parameter).toBe("value");
      expect(err!.eventName).toBe("Purchase");
    });

    it("flags Purchase without currency", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "Purchase", parameters: { value: "10.00" } }),
      ]));
      expect(result.isHealthy).toBe(false);
      const err = result.issues.find(i => i.parameter === "currency" && i.severity === "error");
      expect(err).toBeDefined();
    });

    it("flags Purchase without both value and currency", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "Purchase", parameters: {} }),
      ]));
      expect(result.errorCount).toBe(2);
    });

    it("accepts Facebook cd.value (custom data namespace)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "Purchase",
          parameters: { "cd.value": "29.99", "cd.currency": "USD" },
        }),
      ]));
      expect(result.errorCount).toBe(0);
    });

    it("flags GA4 purchase without transaction_id", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          vendor: "ga4",
          pixelId: "G-ABC123",
          eventName: "purchase",
          parameters: { value: "10", currency: "USD" },
        }),
      ]));
      expect(result.isHealthy).toBe(false);
      const err = result.issues.find(i => i.code === "MISSING_REQUIRED_PARAM" && i.parameter === "transaction_id");
      expect(err).toBeDefined();
    });

    it("returns healthy for GA4 purchase with all required params", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          vendor: "ga4",
          pixelId: "G-ABC123",
          eventName: "page_view",
        }),
        makeEvent({
          vendor: "ga4",
          pixelId: "G-ABC123",
          eventName: "purchase",
          parameters: { transaction_id: "txn_123", value: "50", currency: "USD" },
        }),
      ]));
      expect(result.errorCount).toBe(0);
    });

    it("warns GA4 remove_from_cart without recommended params", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          vendor: "ga4",
          pixelId: "G-ABC123",
          eventName: "remove_from_cart",
          parameters: {},
        }),
      ]));
      const warnings = result.issues.filter(i => i.code === "MISSING_RECOMMENDED_PARAM");
      expect(warnings.length).toBeGreaterThan(0);
      const currencyWarn = warnings.find(w => w.parameter === "currency");
      expect(currencyWarn).toBeDefined();
    });

    it("warns GA4 refund without recommended params", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          vendor: "ga4",
          pixelId: "G-ABC123",
          eventName: "refund",
          parameters: {},
        }),
      ]));
      const warnings = result.issues.filter(i => i.code === "MISSING_RECOMMENDED_PARAM");
      expect(warnings.length).toBeGreaterThan(0);
      const txnWarn = warnings.find(w => w.parameter === "transaction_id");
      expect(txnWarn).toBeDefined();
    });
  });

  describe("missing recommended params (warning)", () => {
    it("warns AddToCart without content_ids", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "AddToCart", parameters: { value: "10", currency: "USD" } }),
      ]));
      const warnings = result.issues.filter(i => i.severity === "warning" && i.code === "MISSING_RECOMMENDED_PARAM");
      expect(warnings.length).toBeGreaterThan(0);
      const contentIds = warnings.find(w => w.parameter === "content_ids");
      expect(contentIds).toBeDefined();
    });

    it("does not warn for params that are present", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "AddToCart",
          parameters: { value: "10", currency: "USD", content_ids: "prod_1", content_type: "product", contents: "[]" },
        }),
      ]));
      const missingRec = result.issues.filter(i => i.code === "MISSING_RECOMMENDED_PARAM");
      expect(missingRec).toEqual([]);
    });
  });

  describe("invalid param types (warning)", () => {
    it("warns when value is not numeric", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "Purchase",
          parameters: { value: "twenty", currency: "USD" },
        }),
      ]));
      const typeIssue = result.issues.find(i => i.code === "INVALID_PARAM_TYPE");
      expect(typeIssue).toBeDefined();
      expect(typeIssue!.parameter).toBe("value");
    });

    it("warns when currency is invalid", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "Purchase",
          parameters: { value: "10", currency: "FAKE" },
        }),
      ]));
      const currIssue = result.issues.find(i => i.code === "INVALID_CURRENCY");
      expect(currIssue).toBeDefined();
      expect(currIssue!.parameter).toBe("currency");
    });

    it("accepts valid numeric value", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "Purchase",
          parameters: { value: "29.99", currency: "EUR" },
        }),
      ]));
      const typeIssues = result.issues.filter(i => i.code === "INVALID_PARAM_TYPE" || i.code === "INVALID_CURRENCY");
      expect(typeIssues).toEqual([]);
    });
  });

  describe("duplicate events (warning)", () => {
    it("warns on duplicate PageView fires from same pixel+URL", () => {
      const ev = makeEvent({ eventName: "PageView" });
      const result = validateTrackingEvents(makeParseResult([ev, { ...ev }]));
      const dupes = result.issues.filter(i => i.code === "DUPLICATE_EVENT");
      expect(dupes.length).toBe(1);
      expect(dupes[0].severity).toBe("warning");
    });

    it("does not warn for same event on different URLs", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView", url: "https://a.com" }),
        makeEvent({ eventName: "PageView", url: "https://b.com" }),
      ]));
      const dupes = result.issues.filter(i => i.code === "DUPLICATE_EVENT");
      expect(dupes).toEqual([]);
    });

    it("does not warn for different events on same URL", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "ViewContent" }),
      ]));
      const dupes = result.issues.filter(i => i.code === "DUPLICATE_EVENT");
      expect(dupes).toEqual([]);
    });

    it("reports accurate count for 5 duplicate fires", () => {
      const ev = makeEvent({ eventName: "PageView" });
      const result = validateTrackingEvents(makeParseResult([ev, { ...ev }, { ...ev }, { ...ev }, { ...ev }]));
      const dupes = result.issues.filter(i => i.code === "DUPLICATE_EVENT");
      expect(dupes.length).toBe(1);
      expect(dupes[0].message).toContain("5 times");
    });

    it("uses vendor-specific call syntax in recommendation", () => {
      const tiktokEv = makeEvent({ vendor: "tiktok", pixelId: "tk1", eventName: "ViewContent", eventType: "standard" });
      const result = validateTrackingEvents(makeParseResult([tiktokEv, { ...tiktokEv }]));
      const dupes = result.issues.filter(i => i.code === "DUPLICATE_EVENT");
      expect(dupes.length).toBe(1);
      expect(dupes[0].recommendation).toContain("ttq.track()");
    });
  });

  describe("no PageView check (warning)", () => {
    it("warns when standard events fire without PageView (Facebook)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          eventName: "Purchase",
          parameters: { value: "10", currency: "USD" },
        }),
      ]));
      const noPageView = result.issues.find(i => i.code === "NO_PAGEVIEW");
      expect(noPageView).toBeDefined();
      expect(noPageView!.severity).toBe("warning");
    });

    it("does not warn when PageView is present (Facebook)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({
          eventName: "Purchase",
          parameters: { value: "10", currency: "USD" },
        }),
      ]));
      const noPageView = result.issues.find(i => i.code === "NO_PAGEVIEW");
      expect(noPageView).toBeUndefined();
    });

    it("warns for GA4 without page_view", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          vendor: "ga4",
          pixelId: "G-ABC",
          eventName: "purchase",
          parameters: { transaction_id: "t1", value: "5", currency: "USD" },
        }),
      ]));
      const noPageView = result.issues.find(i => i.code === "NO_PAGEVIEW");
      expect(noPageView).toBeDefined();
    });

    it("does not warn for only custom events without PageView", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "my_custom_event", eventType: "custom" }),
      ]));
      const noPageView = result.issues.find(i => i.code === "NO_PAGEVIEW");
      expect(noPageView).toBeUndefined();
    });

    it("skips no-PageView check for TikTok (no PageView equivalent)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({
          vendor: "tiktok",
          pixelId: "tik123",
          eventName: "ViewContent",
          eventType: "standard",
        }),
      ]));
      const noPageView = result.issues.find(i => i.code === "NO_PAGEVIEW");
      expect(noPageView).toBeUndefined();
    });
  });

  describe("unknown custom event typo detection (info)", () => {
    it("flags Purchas as possible typo for Purchase", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "Purchas", eventType: "custom" }),
      ]));
      const typo = result.issues.find(i => i.code === "POSSIBLE_TYPO");
      expect(typo).toBeDefined();
      expect(typo!.severity).toBe("info");
      expect(typo!.message).toContain("Purchase");
    });

    it("flags PageVeiw as possible typo for PageView", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageVeiw", eventType: "custom" }),
      ]));
      const typo = result.issues.find(i => i.code === "POSSIBLE_TYPO");
      expect(typo).toBeDefined();
    });

    it("does not flag completely different custom events", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "my_special_tracking_event", eventType: "custom" }),
      ]));
      const typo = result.issues.find(i => i.code === "POSSIBLE_TYPO");
      expect(typo).toBeUndefined();
    });

    it("does not flag standard events as typos", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "Purchase", eventType: "standard" }),
      ]));
      const typo = result.issues.find(i => i.code === "POSSIBLE_TYPO");
      expect(typo).toBeUndefined();
    });

    it("flags GA4 typo: purchse → purchase", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ vendor: "ga4", pixelId: "G-X", eventName: "purchse", eventType: "custom" }),
      ]));
      const typo = result.issues.find(i => i.code === "POSSIBLE_TYPO");
      expect(typo).toBeDefined();
      expect(typo!.message).toContain("purchase");
    });
  });

  describe("mixed scenarios", () => {
    it("handles mix of valid and invalid events with correct counts", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "Purchase", parameters: {} }), // 2 errors (value, currency)
        makeEvent({ eventName: "AddToCart", parameters: {} }), // warnings for recommended
        makeEvent({ eventName: "Purchas", eventType: "custom" }), // info typo
      ]));
      expect(result.errorCount).toBe(2);
      expect(result.warningCount).toBeGreaterThan(0);
      expect(result.infoCount).toBe(1);
      expect(result.isHealthy).toBe(false);
    });

    it("includes all events in result regardless of issues", () => {
      const events = [
        makeEvent({ eventName: "PageView" }),
        makeEvent({ eventName: "Purchase", parameters: { value: "10", currency: "USD" } }),
      ];
      const result = validateTrackingEvents(makeParseResult(events));
      expect(result.events).toHaveLength(2);
    });

    it("handles vendors without schemas gracefully (tiktok)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ vendor: "tiktok", pixelId: "tk1", eventName: "ViewContent", eventType: "standard" }),
      ]));
      // No schema-based issues for tiktok (no TIKTOK_EVENT_SCHEMAS yet)
      const schemaIssues = result.issues.filter(i =>
        i.code === "MISSING_REQUIRED_PARAM" || i.code === "MISSING_RECOMMENDED_PARAM",
      );
      expect(schemaIssues).toEqual([]);
    });

    it("handles vendors without schemas gracefully (linkedin)", () => {
      const result = validateTrackingEvents(makeParseResult([
        makeEvent({ vendor: "linkedin", pixelId: "ln1", eventName: "conversion", eventType: "standard" }),
      ]));
      const schemaIssues = result.issues.filter(i => i.code === "MISSING_REQUIRED_PARAM");
      expect(schemaIssues).toEqual([]);
    });
  });
});

describe("tracking-schemas helpers", () => {
  describe("isValidCurrency", () => {
    it("accepts USD", () => expect(isValidCurrency("USD")).toBe(true));
    it("accepts eur (case-insensitive)", () => expect(isValidCurrency("eur")).toBe(true));
    it("rejects FAKE", () => expect(isValidCurrency("FAKE")).toBe(false));
    it("rejects empty string", () => expect(isValidCurrency("")).toBe(false));
  });

  describe("isNumericParam", () => {
    it("accepts integers", () => expect(isNumericParam("42")).toBe(true));
    it("accepts decimals", () => expect(isNumericParam("29.99")).toBe(true));
    it("accepts negative", () => expect(isNumericParam("-5")).toBe(true));
    it("rejects text", () => expect(isNumericParam("twenty")).toBe(false));
    it("rejects empty", () => expect(isNumericParam("")).toBe(false));
    it("rejects whitespace-only", () => expect(isNumericParam("  ")).toBe(false));
  });
});
