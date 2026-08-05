// Collect CDP-captured signals into the CapturedSignals format for fingerprint matching.
// Pure transformation — no CDP calls, no side effects.

import type { CapturedSignals } from "../../shared/evidence-types.js";
import type { NetworkEntry, CookieEntry } from "../../shared/types.js";

/** Raw inputs from CDP-captured data */
export interface SignalCollectorInput {
  /** Main document response headers (from Network.responseReceived where type=Document) */
  responseHeaders?: Record<string, string>;
  /** Network entries captured during page load */
  networkEntries?: NetworkEntry[];
  /** Cookies from the page (via CDP Network.getAllCookies or Runtime.evaluate) */
  cookies?: CookieEntry[];
  /** Raw cookie string from document.cookie */
  cookieString?: string;
  /** Meta tag name→content pairs (from Runtime.evaluate querySelectorAll) */
  metaTags?: Record<string, string>;
  /** JS global property checks — key: property path, value: resolved value or null if absent */
  jsGlobals?: Record<string, string | null>;
  /** Current page URL */
  url?: string;
  /** Page HTML snippet (e.g. first 50KB of document.documentElement.outerHTML) */
  html?: string;
}

/**
 * Collect and normalize CDP-captured data into CapturedSignals for fingerprint matching.
 *
 * Signal mapping:
 * - headers: main document response headers, grouped by lowercase header name
 * - scriptSrc: URLs of script resources from network entries
 * - cookies: cookie name → [value] pairs
 * - meta: meta tag name → [content] pairs (case-insensitive key lookup)
 * - js: property path → value (only present/truthy globals)
 * - url: current page URL
 * - html: page HTML snippet
 */
export function collectSignals(input: SignalCollectorInput): CapturedSignals {
  const signals: CapturedSignals = {};

  // --- Headers ---
  if (input.responseHeaders) {
    const headers: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(input.responseHeaders)) {
      const key = name.toLowerCase();
      if (!headers[key]) headers[key] = [];
      headers[key].push(value);
    }
    if (Object.keys(headers).length > 0) {
      signals.headers = headers;
    }
  }

  // --- Script URLs from network entries ---
  if (input.networkEntries && input.networkEntries.length > 0) {
    const scriptUrls: string[] = [];
    for (const entry of input.networkEntries) {
      if (
        entry.resourceType === "Script" ||
        entry.mimeType === "application/javascript" ||
        entry.mimeType === "text/javascript" ||
        (entry.url && /\.js(?:\?|$)/i.test(entry.url))
      ) {
        scriptUrls.push(entry.url);
      }
    }
    if (scriptUrls.length > 0) {
      signals.scriptSrc = scriptUrls;
    }

  }

  // --- Cookies ---
  if (input.cookies && input.cookies.length > 0) {
    const cookies: Record<string, string[]> = {};
    for (const cookie of input.cookies) {
      const key = cookie.name.toLowerCase();
      if (!cookies[key]) cookies[key] = [];
      cookies[key].push(cookie.value);
    }
    if (Object.keys(cookies).length > 0) {
      signals.cookies = cookies;
    }
  } else if (input.cookieString) {
    const cookies: Record<string, string[]> = {};
    const pairs = input.cookieString.split(";");
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        const name = pair.substring(0, eqIdx).trim().toLowerCase();
        const value = pair.substring(eqIdx + 1).trim();
        if (!cookies[name]) cookies[name] = [];
        cookies[name].push(value);
      }
    }
    if (Object.keys(cookies).length > 0) {
      signals.cookies = cookies;
    }
  }

  // --- Meta tags ---
  if (input.metaTags) {
    const meta: Record<string, string[]> = {};
    for (const [name, content] of Object.entries(input.metaTags)) {
      const key = name.toLowerCase();
      if (!meta[key]) meta[key] = [];
      meta[key].push(content);
    }
    if (Object.keys(meta).length > 0) {
      signals.meta = meta;
    }
  }

  // --- JS globals ---
  if (input.jsGlobals) {
    const js: Record<string, string> = {};
    for (const [path, value] of Object.entries(input.jsGlobals)) {
      // Only include globals that are present (non-null)
      if (value !== null) {
        js[path] = value;
      }
    }
    if (Object.keys(js).length > 0) {
      signals.js = js;
    }
  }

  // --- URL ---
  if (input.url) {
    signals.url = input.url;
  }

  // --- HTML ---
  if (input.html) {
    signals.html = input.html;
  }

  return signals;
}

/**
 * Extract meta tags from a page via a JS expression suitable for Runtime.evaluate.
 * Returns the expression string — caller executes via CDP.
 */
export const META_TAG_EXTRACTION_EXPR = `
(function() {
  var result = {};
  var metas = document.querySelectorAll('meta[name], meta[property]');
  for (var i = 0; i < metas.length; i++) {
    var name = metas[i].getAttribute('name') || metas[i].getAttribute('property') || '';
    var content = metas[i].getAttribute('content') || '';
    if (name) result[name] = content;
  }
  return result;
})()
`.trim();

/**
 * JS global property paths to check for technology detection.
 * Each path is evaluated via Runtime.evaluate: `typeof <path> !== 'undefined' ? String(<path>) : null`
 * Curated from fingerprint-db.ts JS entries.
 */
export const JS_GLOBAL_CHECKS: string[] = [
  "jQuery.fn.jquery",
  "React.version",
  "angular.version.full",
  "Vue.version",
  "__NEXT_DATA__",
  "__NUXT__",
  "Backbone.VERSION",
  "Ember.VERSION",
  "Modernizr._version",
  "_.VERSION",       // Lodash / Underscore
  "moment.version",
  "axios.VERSION",
  "d3.version",
  "Chart.version",
  "gsap.version",
  "Swiper.version",
  "bootstrap.Alert.VERSION",
  "Sentry.SDK_VERSION",
  "wp.customize",    // WordPress admin
  "Shopify.shop",
  "ga.getAll",       // Google Analytics
  "gtag",            // GA4
  "fbq",             // Facebook Pixel
  "dataLayer",       // Google Tag Manager
  "Stripe",
  "PayPal",
  "Drupal.settings",
  "Joomla",
  "Mage",            // Magento
  "woocommerce_params",
  "prestashop",
  "Cloudflare",
  "ko.version",      // Knockout
  "Polymer.version",
  "htmx.version",
  "Turbo.session",
  "Alpine.version",
  "lit",
  "__REACT_DEVTOOLS_GLOBAL_HOOK__",
  "Swal.version",    // SweetAlert2
  "io",              // Socket.io
  "firebase.SDK_VERSION",
  "amplitude",
  "mixpanel",
  "Intercom",
  "drift",
  "heap",
  "hotjar",
];

/**
 * Build the JS expression that checks all global paths in one Runtime.evaluate call.
 * Returns a serializable object: { "path": "value" | null }
 */
export function buildJSGlobalsCheckExpr(paths?: string[]): string {
  const checks = paths ?? JS_GLOBAL_CHECKS;
  const entries = checks
    .map((path) => {
      // Use try/catch per path to avoid one failure killing the whole check
      const escaped = path.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      return `try { var v = ${path}; r['${escaped}'] = typeof v !== 'undefined' && v !== null ? String(v) : null; } catch(e) { r['${escaped}'] = null; }`;
    })
    .join("\n");
  return `(function() { var r = {};\n${entries}\nreturn r; })()`;
}
