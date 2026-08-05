import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCruxMetrics, assess, parseHistogram, parseMetric, formatDate } from "@/mcp-server/crux-client";
import type { CruxMetrics } from "@/shared/seo-types";
// --- Unit tests for pure functions ---

describe("assess", () => {
  it("returns 'good' when p75 is within good threshold", () => {
    expect(assess("largest_contentful_paint", 2000)).toBe("good");
    expect(assess("cumulative_layout_shift", 0.05)).toBe("good");
    expect(assess("interaction_to_next_paint", 100)).toBe("good");
    expect(assess("experimental_time_to_first_byte", 500)).toBe("good");
  });

  it("returns 'good' at boundary", () => {
    expect(assess("largest_contentful_paint", 2500)).toBe("good");
    expect(assess("cumulative_layout_shift", 0.1)).toBe("good");
  });

  it("returns 'needs-improvement' for mid-range values", () => {
    expect(assess("largest_contentful_paint", 3000)).toBe("needs-improvement");
    expect(assess("cumulative_layout_shift", 0.15)).toBe("needs-improvement");
    expect(assess("interaction_to_next_paint", 300)).toBe("needs-improvement");
    expect(assess("experimental_time_to_first_byte", 1000)).toBe("needs-improvement");
  });

  it("returns 'poor' when p75 exceeds poor threshold", () => {
    expect(assess("largest_contentful_paint", 5000)).toBe("poor");
    expect(assess("cumulative_layout_shift", 0.3)).toBe("poor");
    expect(assess("interaction_to_next_paint", 600)).toBe("poor");
    expect(assess("experimental_time_to_first_byte", 2000)).toBe("poor");
  });

  it("returns 'poor' at boundary", () => {
    // Poor is > threshold, not >=
    expect(assess("largest_contentful_paint", 4000)).toBe("needs-improvement");
    expect(assess("largest_contentful_paint", 4001)).toBe("poor");
  });

  it("returns 'needs-improvement' for unknown metric key", () => {
    expect(assess("unknown_metric", 100)).toBe("needs-improvement");
  });
});

describe("parseHistogram", () => {
  it("extracts density values from bins", () => {
    const bins = [
      { start: 0, end: 2500, density: 0.85 },
      { start: 2500, end: 4000, density: 0.10 },
      { start: 4000, density: 0.05 },
    ];
    expect(parseHistogram(bins)).toEqual([0.85, 0.10, 0.05]);
  });

  it("defaults to 0 for missing density", () => {
    const bins = [
      { start: 0, end: 100 },
      { start: 100, density: 0.5 },
    ];
    expect(parseHistogram(bins)).toEqual([0, 0.5]);
  });

  it("handles empty bins", () => {
    expect(parseHistogram([])).toEqual([]);
  });
});

describe("parseMetric", () => {
  it("parses a valid metric with percentiles and histogram", () => {
    const data = {
      percentiles: { p75: 1500 },
      histogram: [
        { start: 0, end: 2500, density: 0.90 },
        { start: 2500, end: 4000, density: 0.08 },
        { start: 4000, density: 0.02 },
      ],
    };
    const result = parseMetric("largest_contentful_paint", data);
    expect(result).toEqual({
      p75: 1500,
      assessment: "good",
      histogram: [0.90, 0.08, 0.02],
    });
  });

  it("returns undefined when percentiles missing", () => {
    expect(parseMetric("largest_contentful_paint", {})).toBeUndefined();
  });

  it("returns undefined when p75 is NaN", () => {
    const data = { percentiles: { p75: "not-a-number" } };
    expect(parseMetric("largest_contentful_paint", data)).toBeUndefined();
  });

  it("returns empty histogram when histogram missing", () => {
    const data = { percentiles: { p75: 3000 } };
    const result = parseMetric("largest_contentful_paint", data);
    expect(result?.histogram).toEqual([]);
  });
});

describe("formatDate", () => {
  it("formats date with zero-padded month and day", () => {
    expect(formatDate({ year: 2026, month: 3, day: 5 })).toBe("2026-03-05");
  });

  it("handles double-digit month and day", () => {
    expect(formatDate({ year: 2026, month: 12, day: 25 })).toBe("2026-12-25");
  });
});

// --- Integration tests for fetchCruxMetrics ---

describe("fetchCruxMetrics", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.CRUX_API_KEY;

  beforeEach(() => {
    delete process.env.CRUX_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv) process.env.CRUX_API_KEY = originalEnv;
    else delete process.env.CRUX_API_KEY;
  });

  it("returns unavailable when no API key provided", async () => {
    const result = await fetchCruxMetrics("https://example.com");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("No API key");
  });

  it("uses CRUX_API_KEY env var when no key passed", async () => {
    process.env.CRUX_API_KEY = "test-key-123";
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(JSON.stringify({ error: { code: 404, message: "Not found" } }), { status: 404 });
    }) as typeof fetch;

    await fetchCruxMetrics("https://example.com");
    expect(capturedUrl).toContain("key=test-key-123");
  });

  it("parses successful CrUX response with all metrics", async () => {
    const mockResponse = {
      record: {
        key: { url: "https://example.com/" },
        metrics: {
          largest_contentful_paint: {
            percentiles: { p75: 1800 },
            histogram: [{ start: 0, end: 2500, density: 0.88 }, { start: 2500, end: 4000, density: 0.09 }, { start: 4000, density: 0.03 }],
          },
          cumulative_layout_shift: {
            percentiles: { p75: 0.05 },
            histogram: [{ start: "0.00", end: "0.10", density: 0.92 }, { start: "0.10", end: "0.25", density: 0.06 }, { start: "0.25", density: 0.02 }],
          },
          interaction_to_next_paint: {
            percentiles: { p75: 150 },
            histogram: [{ start: 0, end: 200, density: 0.82 }, { start: 200, end: 500, density: 0.15 }, { start: 500, density: 0.03 }],
          },
          experimental_time_to_first_byte: {
            percentiles: { p75: 600 },
            histogram: [{ start: 0, end: 800, density: 0.90 }, { start: 800, end: 1800, density: 0.08 }, { start: 1800, density: 0.02 }],
          },
        },
        collectionPeriod: {
          firstDate: { year: 2026, month: 2, day: 12 },
          lastDate: { year: 2026, month: 3, day: 12 },
        },
      },
    };

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200 })) as typeof fetch;

    const result = await fetchCruxMetrics("https://example.com", "test-key");
    expect(result.available).toBe(true);
    expect(result.metrics.lcp?.p75).toBe(1800);
    expect(result.metrics.lcp?.assessment).toBe("good");
    expect(result.metrics.cls?.p75).toBe(0.05);
    expect(result.metrics.cls?.assessment).toBe("good");
    expect(result.metrics.inp?.p75).toBe(150);
    expect(result.metrics.inp?.assessment).toBe("good");
    expect(result.metrics.ttfb?.p75).toBe(600);
    expect(result.metrics.ttfb?.assessment).toBe("good");
    expect(result.collectionPeriod?.firstDate).toBe("2026-02-12");
    expect(result.collectionPeriod?.lastDate).toBe("2026-03-12");
  });

  it("falls back to origin when URL returns 404", async () => {
    let callCount = 0;
    const originResponse = {
      record: {
        key: { origin: "https://example.com" },
        metrics: {
          largest_contentful_paint: {
            percentiles: { p75: 3000 },
            histogram: [{ start: 0, end: 2500, density: 0.65 }, { start: 2500, end: 4000, density: 0.25 }, { start: 4000, density: 0.10 }],
          },
        },
      },
    };

    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return new Response("", { status: 404 });
      return new Response(JSON.stringify(originResponse), { status: 200 });
    }) as typeof fetch;

    const result = await fetchCruxMetrics("https://example.com/some/page", "test-key");
    expect(result.available).toBe(true);
    expect(result.origin).toBe("https://example.com");
    expect(result.metrics.lcp?.p75).toBe(3000);
    expect(result.metrics.lcp?.assessment).toBe("needs-improvement");
    expect(callCount).toBe(2);
  });

  it("returns unavailable when both URL and origin have no data", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as typeof fetch;

    const result = await fetchCruxMetrics("https://example.com", "test-key");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("Insufficient data");
  });

  it("handles API error responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Forbidden", { status: 403 })) as typeof fetch;

    const result = await fetchCruxMetrics("https://example.com", "bad-key");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("403");
  });

  it("handles network fetch failures", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("Network unreachable"); }) as typeof fetch;

    const result = await fetchCruxMetrics("https://example.com", "test-key");
    expect(result.available).toBe(false);
    expect(result.reason).toContain("fetch failed");
  });

  it("passes form_factor parameter", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedBody = opts?.body as string || "";
      return new Response("", { status: 404 });
    }) as typeof fetch;

    await fetchCruxMetrics("https://example.com", "test-key", "PHONE");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.formFactor).toBe("PHONE");
  });

  it("includes formFactor in result when specified", async () => {
    const mockResponse = {
      record: {
        metrics: {
          largest_contentful_paint: {
            percentiles: { p75: 2000 },
            histogram: [{ start: 0, end: 2500, density: 0.80 }],
          },
        },
      },
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(mockResponse), { status: 200 })) as typeof fetch;

    const result = await fetchCruxMetrics("https://example.com", "test-key", "DESKTOP");
    expect(result.formFactor).toBe("DESKTOP");
  });
});

// --- Type structure tests ---

describe("CruxMetrics type structure", () => {
  it("satisfies CruxMetrics interface for available data", () => {
    const m: CruxMetrics = {
      available: true,
      url: "https://example.com",
      origin: "https://example.com",
      formFactor: "DESKTOP",
      metrics: {
        lcp: { p75: 2000, assessment: "good", histogram: [0.85, 0.10, 0.05] },
        cls: { p75: 0.08, assessment: "good", histogram: [0.90, 0.07, 0.03] },
        inp: { p75: 180, assessment: "good", histogram: [0.80, 0.15, 0.05] },
        ttfb: { p75: 700, assessment: "good", histogram: [0.88, 0.09, 0.03] },
      },
      collectionPeriod: { firstDate: "2026-02-12", lastDate: "2026-03-12" },
    };
    expect(m.available).toBe(true);
    expect(m.metrics.lcp?.p75).toBe(2000);
  });

  it("satisfies CruxMetrics interface for unavailable data", () => {
    const m: CruxMetrics = {
      available: false,
      url: "https://obscure-site.example",
      reason: "Insufficient data",
      metrics: {},
    };
    expect(m.available).toBe(false);
    expect(m.reason).toBeTruthy();
  });
});
