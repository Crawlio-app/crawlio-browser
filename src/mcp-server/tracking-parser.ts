// Pure tracking pixel parser — no side effects, no bridge dependency
// Parses NetworkEntry[] into structured TrackingPixelEvent objects
// Supports: Facebook, GA4, TikTok, LinkedIn, Pinterest

import type { NetworkEntry } from "../shared/types.js";
import type {
  TrackingVendor,
  TrackingPixelEvent,
  TrackingPixelSummary,
  TrackingParseResult,
  DuplicateCluster,
} from "../shared/evidence-types.js";
import {
  TRACKER_VENDORS,
  TRACKING_HEURISTIC_PATTERNS,
  type TrackerVendorConfig,
} from "../shared/tracking-vendors.js";

function matchVendor(urlStr: string): TrackerVendorConfig | null {
  for (const config of Object.values(TRACKER_VENDORS)) {
    for (const pattern of config.urlPatterns) {
      if (pattern.test(urlStr)) return config;
    }
  }
  return null;
}

function safeParseUrl(urlStr: string): URL | null {
  try {
    return new URL(urlStr);
  } catch {
    return null;
  }
}

function isTrackingLikeUrl(urlStr: string): boolean {
  return TRACKING_HEURISTIC_PATTERNS.some(p => p.test(urlStr));
}

export function parseTrackingPixels(networkEntries: NetworkEntry[]): TrackingParseResult {
  const events: TrackingPixelEvent[] = [];
  const unrecognizedTrackingUrls: string[] = [];
  const seenUnrecognized = new Set<string>();

  for (const entry of networkEntries) {
    if (!entry.url) continue;

    const vendor = matchVendor(entry.url);
    if (!vendor) {
      // Check heuristic patterns for unrecognized tracking URLs
      if (isTrackingLikeUrl(entry.url) && !seenUnrecognized.has(entry.url)) {
        seenUnrecognized.add(entry.url);
        unrecognizedTrackingUrls.push(entry.url);
      }
      continue;
    }

    const parsed = safeParseUrl(entry.url);
    if (!parsed) continue;

    const pixelId = vendor.extractPixelId(parsed) || "unknown";
    const eventName = vendor.extractEventName(parsed) || "unknown";
    const parameters = vendor.extractParameters(parsed);
    const eventType = vendor.standardEvents.includes(eventName) ? "standard" : "custom";

    events.push({
      vendor: vendor.vendor,
      pixelId,
      eventName,
      eventType,
      parameters,
      url: entry.url,
      method: entry.method,
      timestamp: Date.now(),
      status: entry.status > 0 ? entry.status : undefined,
      requestUrl: entry.url,
    });
  }

  // Group by vendor + pixelId
  const pixelMap = new Map<string, TrackingPixelSummary>();
  for (const event of events) {
    const key = `${event.vendor}:${event.pixelId}`;
    let summary = pixelMap.get(key);
    if (!summary) {
      summary = {
        vendor: event.vendor,
        pixelId: event.pixelId,
        eventCount: 0,
        events: [],
        uniqueEventNames: [],
      };
      pixelMap.set(key, summary);
    }
    summary.events.push(event);
    summary.eventCount++;
    if (!summary.uniqueEventNames.includes(event.eventName)) {
      summary.uniqueEventNames.push(event.eventName);
    }
  }

  const pixels = Array.from(pixelMap.values());

  // Collect unique vendors
  const vendorSet = new Set<TrackingVendor>();
  for (const event of events) {
    vendorSet.add(event.vendor);
  }

  return {
    totalPixelFires: events.length,
    vendors: Array.from(vendorSet),
    pixels,
    events,
    unrecognizedTrackingUrls,
  };
}

// PageView fires legitimately multiple times on SPAs — exclude from duplicate flagging
const SPA_LEGITIMATE_EVENTS = new Set(["PageView", "page_view"]);

export function detectDuplicates(events: TrackingPixelEvent[]): DuplicateCluster[] {
  const groups = new Map<string, { vendor: TrackingVendor; pixelId: string; eventName: string; url: string; timestamps: number[] }>();

  for (const event of events) {
    if (SPA_LEGITIMATE_EVENTS.has(event.eventName)) continue;

    const key = `${event.vendor}:${event.pixelId}:${event.eventName}:${event.url}`;
    const existing = groups.get(key);
    if (existing) {
      existing.timestamps.push(event.timestamp);
    } else {
      groups.set(key, {
        vendor: event.vendor,
        pixelId: event.pixelId,
        eventName: event.eventName,
        url: event.url,
        timestamps: [event.timestamp],
      });
    }
  }

  const clusters: DuplicateCluster[] = [];
  for (const group of groups.values()) {
    if (group.timestamps.length >= 2) {
      clusters.push({
        vendor: group.vendor,
        pixelId: group.pixelId,
        eventName: group.eventName,
        url: group.url,
        count: group.timestamps.length,
        timestamps: group.timestamps,
      });
    }
  }

  return clusters;
}
