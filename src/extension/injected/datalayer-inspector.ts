// DataLayer inspector — injected into page via cdpExecuteFunction (Runtime.evaluate)
// MUST be self-contained: no imports, no closures, no external references
// Probes tracker runtime state: Facebook fbq, GA4 dataLayer, GTM containers, TikTok ttq

 
export function inspectDataLayer(): any {
  const w = window as any;

  const result: {
    facebook: { loaded: boolean; version: string | null; pixelIds: string[]; queueLength: number } | null;
    ga4: { dataLayerLength: number; events: string[]; gtag: boolean; gaLegacy: boolean } | null;
    gtm: { containers: string[] } | null;
    tiktok: { loaded: boolean; queueLength: number } | null;
  } = {
    facebook: null,
    ga4: null,
    gtm: null,
    tiktok: null,
  };

  // --- Facebook Pixel ---
  if (typeof w.fbq === "function" || typeof w._fbq === "function") {
    const fbq = w.fbq || w._fbq;
    const pixelIds: string[] = [];

    // Extract pixel IDs from fbq.queue init calls: fbq('init', '<pixelId>')
    if (Array.isArray(fbq.queue)) {
      for (const call of fbq.queue) {
        if (Array.isArray(call) && call[0] === "init" && typeof call[1] === "string") {
          if (!pixelIds.includes(call[1])) {
            pixelIds.push(call[1]);
          }
        }
      }
    }

    // Also check fbq.pixelsByID (populated after pixel loads)
    if (fbq.pixelsByID && typeof fbq.pixelsByID === "object") {
      for (const id of Object.keys(fbq.pixelsByID)) {
        if (!pixelIds.includes(id)) {
          pixelIds.push(id);
        }
      }
    }

    result.facebook = {
      loaded: !!fbq.loaded,
      version: typeof fbq.version === "string" ? fbq.version : null,
      pixelIds,
      queueLength: Array.isArray(fbq.queue) ? fbq.queue.length : 0,
    };
  }

  // --- GA4 / dataLayer ---
  if (Array.isArray(w.dataLayer)) {
    const events: string[] = [];
    const len = w.dataLayer.length;
    // Collect last 50 event names from dataLayer pushes
    for (let i = Math.max(0, len - 50); i < len; i++) {
      const entry = w.dataLayer[i];
      if (entry && typeof entry.event === "string") {
        events.push(entry.event);
      }
    }

    result.ga4 = {
      dataLayerLength: len,
      events,
      gtag: typeof w.gtag === "function",
      gaLegacy: typeof w.ga === "function" || !!w.GA_INITIALIZED,
    };
  }

  // --- GTM containers ---
  if (w.google_tag_manager && typeof w.google_tag_manager === "object") {
    const containers: string[] = [];
    for (const key of Object.keys(w.google_tag_manager)) {
      if (key.startsWith("GTM-") || key.startsWith("G-")) {
        containers.push(key);
      }
    }
    if (containers.length > 0) {
      result.gtm = { containers };
    }
  }

  // --- TikTok Pixel ---
  if (typeof w.ttq !== "undefined" && w.ttq !== null) {
    result.tiktok = {
      loaded: true,
      queueLength: Array.isArray(w.ttq.queue) ? w.ttq.queue.length : 0,
    };
  }

  return result;
}
