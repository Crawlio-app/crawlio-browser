import { describe, it, expect } from "vitest";
import { parseTrackingPixels } from "../../src/mcp-server/tracking-parser";
import type { NetworkEntry } from "../../src/shared/types";

function makeEntry(overrides: Partial<NetworkEntry>): NetworkEntry {
  return {
    url: "",
    method: "GET",
    status: 200,
    mimeType: "image/gif",
    size: 43,
    transferSize: 43,
    durationMs: 50,
    resourceType: "Image",
    ...overrides,
  };
}

describe("parseTrackingPixels", () => {
  it("returns empty result for empty entries", () => {
    const result = parseTrackingPixels([]);
    expect(result.totalPixelFires).toBe(0);
    expect(result.vendors).toEqual([]);
    expect(result.pixels).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.unrecognizedTrackingUrls).toEqual([]);
  });

  it("returns empty result for non-tracking entries", () => {
    const result = parseTrackingPixels([
      makeEntry({ url: "https://example.com/style.css" }),
      makeEntry({ url: "https://cdn.example.com/script.js" }),
    ]);
    expect(result.totalPixelFires).toBe(0);
  });

  describe("Facebook Pixel", () => {
    it("parses PageView pixel fire", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=123456&ev=PageView&dl=https%3A%2F%2Fexample.com" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.vendors).toEqual(["facebook"]);
      expect(result.events[0].vendor).toBe("facebook");
      expect(result.events[0].pixelId).toBe("123456");
      expect(result.events[0].eventName).toBe("PageView");
      expect(result.events[0].eventType).toBe("standard");
    });

    it("parses Purchase with custom data parameters", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=789&ev=Purchase&cd[value]=49.99&cd[currency]=USD" }),
      ]);
      expect(result.events[0].eventName).toBe("Purchase");
      expect(result.events[0].eventType).toBe("standard");
      expect(result.events[0].parameters["cd.value"]).toBe("49.99");
      expect(result.events[0].parameters["cd.currency"]).toBe("USD");
    });

    it("classifies custom events correctly", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=111&ev=MyCustomEvent" }),
      ]);
      expect(result.events[0].eventType).toBe("custom");
      expect(result.events[0].eventName).toBe("MyCustomEvent");
    });

    it("parses non-www variant", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://facebook.com/tr?id=222&ev=ViewContent" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].pixelId).toBe("222");
    });

    it("parses connect.facebook.net pixel script loads", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://connect.facebook.net/en_US/fbevents.js" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].vendor).toBe("facebook");
      expect(result.events[0].pixelId).toBe("unknown");
    });

    it("extracts data_source_id as pixel ID", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?data_source_id=333&ev=PageView" }),
      ]);
      expect(result.events[0].pixelId).toBe("333");
    });

    it("extracts event_name parameter", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=444&event_name=Lead" }),
      ]);
      expect(result.events[0].eventName).toBe("Lead");
    });

    it("does not match facebook.com/translate or other /tr-prefixed paths", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/translate?lang=en" }),
        makeEntry({ url: "https://www.facebook.com/travel" }),
      ]);
      expect(result.totalPixelFires).toBe(0);
    });
  });

  describe("GA4", () => {
    it("parses google-analytics.com collect request", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.google-analytics.com/g/collect?v=2&tid=G-ABCDEF&en=page_view&dl=https%3A%2F%2Fexample.com" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].vendor).toBe("ga4");
      expect(result.events[0].pixelId).toBe("G-ABCDEF");
      expect(result.events[0].eventName).toBe("page_view");
      expect(result.events[0].eventType).toBe("standard");
    });

    it("parses analytics.google.com collect request", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://analytics.google.com/g/collect?v=2&tid=G-XYZ123&en=purchase" }),
      ]);
      expect(result.events[0].vendor).toBe("ga4");
      expect(result.events[0].pixelId).toBe("G-XYZ123");
      expect(result.events[0].eventName).toBe("purchase");
    });

    it("classifies custom GA4 events", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.google-analytics.com/g/collect?tid=G-TEST&en=my_custom_event" }),
      ]);
      expect(result.events[0].eventType).toBe("custom");
    });

    it("does not use _et (engagement time) as event name", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.google-analytics.com/g/collect?tid=G-TEST&_et=5000" }),
      ]);
      expect(result.events[0].eventName).toBe("unknown");
    });
  });

  describe("TikTok", () => {
    it("parses TikTok pixel event", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CTEST123&event=ViewContent" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].vendor).toBe("tiktok");
      expect(result.events[0].pixelId).toBe("CTEST123");
      expect(result.events[0].eventName).toBe("ViewContent");
      expect(result.events[0].eventType).toBe("standard");
    });

    it("parses an.tiktok.com URL", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://an.tiktok.com/pixel/track?pixel_code=ABC&ev=AddToCart" }),
      ]);
      expect(result.events[0].vendor).toBe("tiktok");
      expect(result.events[0].pixelId).toBe("ABC");
    });
  });

  describe("LinkedIn", () => {
    it("parses LinkedIn Insight tag", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://px.ads.linkedin.com/collect?pid=12345&fmt=js" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].vendor).toBe("linkedin");
      expect(result.events[0].pixelId).toBe("12345");
      expect(result.events[0].eventName).toBe("pageview");
    });

    it("parses snap.licdn.com URL", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://snap.licdn.com/li.lms-analytics/insight.min.js?pid=67890" }),
      ]);
      expect(result.events[0].vendor).toBe("linkedin");
      expect(result.events[0].pixelId).toBe("67890");
    });

    it("parses LinkedIn conversion", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://px.ads.linkedin.com/collect?pid=111&conversionId=conv123" }),
      ]);
      expect(result.events[0].eventName).toBe("conversion");
    });
  });

  describe("Pinterest", () => {
    it("parses Pinterest tag", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://ct.pinterest.com/v3/?event=pagevisit&tid=2613&ed[event_name]=pagevisit" }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].vendor).toBe("pinterest");
      expect(result.events[0].pixelId).toBe("2613");
      expect(result.events[0].eventName).toBe("pagevisit");
      expect(result.events[0].eventType).toBe("standard");
    });
  });

  describe("Mixed vendors", () => {
    it("groups multiple vendors correctly", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=fb1&ev=PageView" }),
        makeEntry({ url: "https://www.facebook.com/tr?id=fb1&ev=Purchase" }),
        makeEntry({ url: "https://www.google-analytics.com/g/collect?tid=G-GA1&en=page_view" }),
        makeEntry({ url: "https://ct.pinterest.com/v3/?tid=pin1&event=pagevisit" }),
      ]);
      expect(result.totalPixelFires).toBe(4);
      expect(result.vendors).toContain("facebook");
      expect(result.vendors).toContain("ga4");
      expect(result.vendors).toContain("pinterest");
      expect(result.pixels).toHaveLength(3); // fb1, G-GA1, pin1
    });

    it("groups same pixel ID events together", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=fb1&ev=PageView" }),
        makeEntry({ url: "https://www.facebook.com/tr?id=fb1&ev=ViewContent" }),
        makeEntry({ url: "https://www.facebook.com/tr?id=fb1&ev=AddToCart" }),
      ]);
      expect(result.pixels).toHaveLength(1);
      expect(result.pixels[0].eventCount).toBe(3);
      expect(result.pixels[0].uniqueEventNames).toEqual(["PageView", "ViewContent", "AddToCart"]);
    });

    it("separates different pixel IDs for same vendor", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=fb1&ev=PageView" }),
        makeEntry({ url: "https://www.facebook.com/tr?id=fb2&ev=PageView" }),
      ]);
      expect(result.pixels).toHaveLength(2);
    });
  });

  describe("Unrecognized tracking URLs", () => {
    it("detects heuristic tracking-like URLs", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://example.com/pixel?uid=abc" }),
        makeEntry({ url: "https://tracker.example.com/collect?data=123" }),
        makeEntry({ url: "https://example.com/events?type=click" }),
      ]);
      expect(result.unrecognizedTrackingUrls.length).toBeGreaterThan(0);
    });

    it("deduplicates unrecognized URLs", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://example.com/pixel?uid=abc" }),
        makeEntry({ url: "https://example.com/pixel?uid=abc" }),
      ]);
      expect(result.unrecognizedTrackingUrls).toHaveLength(1);
    });
  });

  describe("Edge cases", () => {
    it("handles malformed URLs gracefully", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "not-a-url" }),
        makeEntry({ url: "" }),
      ]);
      expect(result.totalPixelFires).toBe(0);
    });

    it("handles entries with failed status", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=123&ev=PageView", status: -1 }),
      ]);
      expect(result.totalPixelFires).toBe(1);
      expect(result.events[0].status).toBeUndefined();
    });

    it("preserves status for successful requests", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=123&ev=PageView", status: 200 }),
      ]);
      expect(result.events[0].status).toBe(200);
    });

    it("handles POST method", () => {
      const result = parseTrackingPixels([
        makeEntry({ url: "https://www.facebook.com/tr?id=123&ev=Purchase", method: "POST" }),
      ]);
      expect(result.events[0].method).toBe("POST");
    });
  });
});
