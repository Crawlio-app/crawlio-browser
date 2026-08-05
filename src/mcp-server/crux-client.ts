// CrUX API client — fetches Chrome User Experience Report field data.
// Pure module with no extension/bridge dependencies — fully testable.

import type { CruxMetrics, CruxMetricEntry } from "../shared/seo-types.js";

const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

// Google Core Web Vitals thresholds
const THRESHOLDS: Record<string, { good: number; poor: number }> = {
  largest_contentful_paint: { good: 2500, poor: 4000 },
  cumulative_layout_shift: { good: 0.1, poor: 0.25 },
  interaction_to_next_paint: { good: 200, poor: 500 },
  experimental_time_to_first_byte: { good: 800, poor: 1800 },
};

const METRIC_KEY_MAP: Record<string, keyof CruxMetrics["metrics"]> = {
  largest_contentful_paint: "lcp",
  cumulative_layout_shift: "cls",
  interaction_to_next_paint: "inp",
  experimental_time_to_first_byte: "ttfb",
};

function assess(metricKey: string, p75: number): "good" | "needs-improvement" | "poor" {
  const t = THRESHOLDS[metricKey];
  if (!t) return "needs-improvement";
  if (p75 <= t.good) return "good";
  if (p75 > t.poor) return "poor";
  return "needs-improvement";
}

function parseHistogram(bins: Array<{ start: number | string; end?: number | string; density?: number }>): number[] {
  return bins.map(b => b.density ?? 0);
}

function parseMetric(metricKey: string, data: Record<string, unknown>): CruxMetricEntry | undefined {
  const percentiles = data.percentiles as Record<string, unknown> | undefined;
  const histogram = data.histogram as Array<{ start: number | string; end?: number | string; density?: number }> | undefined;
  if (!percentiles) return undefined;
  const p75 = Number(percentiles.p75);
  if (Number.isNaN(p75)) return undefined;
  return {
    p75,
    assessment: assess(metricKey, p75),
    histogram: histogram ? parseHistogram(histogram) : [],
  };
}

interface CruxApiResponse {
  record?: {
    metrics?: Record<string, Record<string, unknown>>;
    key?: { url?: string; origin?: string; formFactor?: string };
    collectionPeriod?: { firstDate?: { year: number; month: number; day: number }; lastDate?: { year: number; month: number; day: number } };
  };
  error?: { code: number; message: string };
}

function formatDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export async function fetchCruxMetrics(
  url: string,
  apiKey?: string,
  formFactor?: "PHONE" | "DESKTOP" | "TABLET",
): Promise<CruxMetrics> {
  const key = apiKey || process.env.CRUX_API_KEY;
  if (!key) {
    return { available: false, url, reason: "No API key provided. Set CRUX_API_KEY env var or pass api_key parameter.", metrics: {} };
  }

  const endpoint = `${CRUX_ENDPOINT}?key=${encodeURIComponent(key)}`;

  // Try URL-level first, then fall back to origin-level
  for (const bodyKey of ["url", "origin"] as const) {
    const requestUrl = bodyKey === "url" ? url : new URL(url).origin;
    const body: Record<string, unknown> = { [bodyKey]: requestUrl };
    if (formFactor) body.formFactor = formFactor;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 404) continue; // No data for this URL/origin — try next
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        return { available: false, url, reason: `CrUX API error ${res.status}: ${errBody.slice(0, 200)}`, metrics: {} };
      }

      const json = await res.json() as CruxApiResponse;
      if (json.error) {
        if (json.error.code === 404) continue;
        return { available: false, url, reason: `CrUX API: ${json.error.message}`, metrics: {} };
      }

      const record = json.record;
      if (!record?.metrics) continue;

      const metrics: CruxMetrics["metrics"] = {};
      for (const [rawKey, data] of Object.entries(record.metrics)) {
        const shortKey = METRIC_KEY_MAP[rawKey];
        if (shortKey) {
          const parsed = parseMetric(rawKey, data);
          if (parsed) metrics[shortKey] = parsed;
        }
      }

      if (Object.keys(metrics).length === 0) continue;

      const result: CruxMetrics = {
        available: true,
        url,
        metrics,
      };

      if (bodyKey === "origin") result.origin = requestUrl;
      if (formFactor) result.formFactor = formFactor;

      if (record.collectionPeriod?.firstDate && record.collectionPeriod?.lastDate) {
        result.collectionPeriod = {
          firstDate: formatDate(record.collectionPeriod.firstDate),
          lastDate: formatDate(record.collectionPeriod.lastDate),
        };
      }

      return result;
    } catch (e) {
      return { available: false, url, reason: `CrUX API fetch failed: ${e}`, metrics: {} };
    }
  }

  return { available: false, url, reason: "Insufficient data — CrUX has no field data for this URL or origin.", metrics: {} };
}

// Exported for testing
export { THRESHOLDS, METRIC_KEY_MAP, assess, parseHistogram, parseMetric, formatDate };
