// Tracking pixel vendor catalog — URL pattern matching and parameter extraction
// Modeled after framework-sensor.ts FRAMEWORK_SIGNALS pattern
// Each vendor defines: URL patterns, pixel ID extraction, event name extraction,
// parameter extraction, and standard event taxonomy

import type { TrackingVendor } from "./evidence-types";

export interface TrackerVendorConfig {
  vendor: TrackingVendor;
  urlPatterns: RegExp[];
  extractPixelId: (url: URL) => string | null;
  extractEventName: (url: URL) => string | null;
  extractParameters: (url: URL) => Record<string, string>;
  standardEvents: string[];
}

// Facebook custom data regex: cd[key]=value
const FB_CUSTOM_DATA_RE = /cd\[([^\]]+)\]/;

export const TRACKER_VENDORS: Record<string, TrackerVendorConfig> = {
  facebook: {
    vendor: "facebook",
    urlPatterns: [
      /^https?:\/\/(www\.)?facebook\.com\/tr\b/,
      /^https?:\/\/connect\.facebook\.net\//,
    ],
    extractPixelId: (url: URL) =>
      url.searchParams.get("id") || url.searchParams.get("data_source_id") || null,
    extractEventName: (url: URL) =>
      url.searchParams.get("ev") || url.searchParams.get("event_name") || null,
    extractParameters: (url: URL) => {
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key === "id" || key === "ev" || key === "event_name" || key === "data_source_id") continue;
        const cdMatch = key.match(FB_CUSTOM_DATA_RE);
        if (cdMatch) {
          params[`cd.${cdMatch[1]}`] = value;
        } else {
          params[key] = value;
        }
      }
      return params;
    },
    standardEvents: [
      "AddPaymentInfo", "AddToCart", "AddToWishlist", "CompleteRegistration",
      "Contact", "CustomizeProduct", "Donate", "FindLocation",
      "InitiateCheckout", "Lead", "PageView", "Purchase",
      "Schedule", "Search", "StartTrial", "SubmitApplication",
      "Subscribe", "ViewContent",
    ],
  },

  ga4: {
    vendor: "ga4",
    urlPatterns: [
      /^https?:\/\/(www\.)?google-analytics\.com\/g\/collect/,
      /^https?:\/\/analytics\.google\.com\/g\/collect/,
    ],
    extractPixelId: (url: URL) =>
      url.searchParams.get("tid") || null,
    extractEventName: (url: URL) =>
      url.searchParams.get("en") || null,
    extractParameters: (url: URL) => {
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key === "tid" || key === "en") continue;
        params[key] = value;
      }
      return params;
    },
    standardEvents: [
      "page_view", "scroll", "click", "view_search_results",
      "file_download", "form_start", "form_submit", "video_start",
      "video_progress", "video_complete", "purchase", "add_to_cart",
      "begin_checkout", "add_payment_info", "add_shipping_info",
      "view_item", "view_item_list", "select_item", "select_promotion",
      "view_promotion", "login", "sign_up", "generate_lead",
    ],
  },

  tiktok: {
    vendor: "tiktok",
    urlPatterns: [
      /^https?:\/\/analytics\.tiktok\.com/,
      /^https?:\/\/an\.tiktok\.com/,
    ],
    extractPixelId: (url: URL) =>
      url.searchParams.get("sdkid") || url.searchParams.get("pixel_code") || null,
    extractEventName: (url: URL) =>
      url.searchParams.get("event") || url.searchParams.get("ev") || null,
    extractParameters: (url: URL) => {
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key === "sdkid" || key === "pixel_code" || key === "event" || key === "ev") continue;
        params[key] = value;
      }
      return params;
    },
    standardEvents: [
      "ViewContent", "ClickButton", "Search", "AddToWishlist",
      "AddToCart", "InitiateCheckout", "AddPaymentInfo", "CompletePayment",
      "PlaceAnOrder", "Contact", "Download", "SubmitForm",
      "CompleteRegistration", "Subscribe",
    ],
  },

  linkedin: {
    vendor: "linkedin",
    urlPatterns: [
      /^https?:\/\/px\.ads\.linkedin\.com/,
      /^https?:\/\/snap\.licdn\.com/,
    ],
    extractPixelId: (url: URL) =>
      url.searchParams.get("pid") || url.searchParams.get("conversionId") || null,
    extractEventName: (url: URL) =>
      url.searchParams.get("conversionId") ? "conversion" :
      url.searchParams.get("fmt") === "js" ? "pageview" : null,
    extractParameters: (url: URL) => {
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key === "pid" || key === "conversionId") continue;
        params[key] = value;
      }
      return params;
    },
    standardEvents: [
      "pageview", "conversion",
    ],
  },

  pinterest: {
    vendor: "pinterest",
    urlPatterns: [
      /^https?:\/\/ct\.pinterest\.com/,
    ],
    extractPixelId: (url: URL) =>
      url.searchParams.get("tid") || null,
    extractEventName: (url: URL) =>
      url.searchParams.get("event") || url.searchParams.get("ed[event_name]") || null,
    extractParameters: (url: URL) => {
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) {
        if (key === "tid" || key === "event") continue;
        params[key] = value;
      }
      return params;
    },
    standardEvents: [
      "pagevisit", "signup", "lead", "checkout", "addtocart",
      "watchvideo", "search", "viewcategory", "custom",
    ],
  },
};

// Heuristic patterns for unrecognized tracking-like URLs
export const TRACKING_HEURISTIC_PATTERNS = [
  /\/pixel/i,
  /\/tr[?/]/,
  /\/collect[?/]/,
  /\/events?[?/]/i,
  /\/beacon/i,
  /\/log[?/]/i,
];
