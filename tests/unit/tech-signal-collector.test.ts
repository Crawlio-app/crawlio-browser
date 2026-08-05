import { describe, it, expect } from "vitest";
import {
  collectSignals,
  buildJSGlobalsCheckExpr,
  JS_GLOBAL_CHECKS,
  META_TAG_EXTRACTION_EXPR,
} from "../../src/extension/sensors/tech-signal-collector.js";
import type { SignalCollectorInput } from "../../src/extension/sensors/tech-signal-collector.js";
import type { NetworkEntry, CookieEntry } from "../../src/shared/types.js";

describe("tech-signal-collector", () => {
  describe("collectSignals", () => {
    it("should return empty signals for empty input", () => {
      const result = collectSignals({});
      expect(result).toEqual({});
    });

    // --- Headers ---

    it("should collect response headers lowercase-keyed", () => {
      const result = collectSignals({
        responseHeaders: {
          "X-Powered-By": "Express",
          "Content-Type": "text/html",
          "server": "nginx",
        },
      });
      expect(result.headers).toEqual({
        "x-powered-by": ["Express"],
        "content-type": ["text/html"],
        "server": ["nginx"],
      });
    });

    it("should skip headers when responseHeaders is empty", () => {
      const result = collectSignals({ responseHeaders: {} });
      expect(result.headers).toBeUndefined();
    });

    // --- Script URLs ---

    it("should extract script URLs from network entries by resourceType", () => {
      const entries: NetworkEntry[] = [
        { url: "https://cdn.example.com/jquery.min.js", method: "GET", status: 200, mimeType: "application/javascript", size: 100, transferSize: 100, durationMs: 50, resourceType: "Script" },
        { url: "https://example.com/page.html", method: "GET", status: 200, mimeType: "text/html", size: 500, transferSize: 500, durationMs: 100, resourceType: "Document" },
        { url: "https://cdn.example.com/react.js", method: "GET", status: 200, mimeType: "text/javascript", size: 200, transferSize: 200, durationMs: 30, resourceType: "Script" },
      ];
      const result = collectSignals({ networkEntries: entries });
      expect(result.scriptSrc).toEqual([
        "https://cdn.example.com/jquery.min.js",
        "https://cdn.example.com/react.js",
      ]);
    });

    it("should detect scripts by mimeType when resourceType is missing", () => {
      const entries: NetworkEntry[] = [
        { url: "https://cdn.example.com/app.js", method: "GET", status: 200, mimeType: "application/javascript", size: 100, transferSize: 100, durationMs: 50, resourceType: "Other" },
      ];
      const result = collectSignals({ networkEntries: entries });
      expect(result.scriptSrc).toEqual(["https://cdn.example.com/app.js"]);
    });

    it("should detect scripts by .js URL extension", () => {
      const entries: NetworkEntry[] = [
        { url: "https://cdn.example.com/vendor.js?v=1.2", method: "GET", status: 200, mimeType: "application/octet-stream", size: 100, transferSize: 100, durationMs: 50, resourceType: "Other" },
      ];
      const result = collectSignals({ networkEntries: entries });
      expect(result.scriptSrc).toEqual(["https://cdn.example.com/vendor.js?v=1.2"]);
    });

    it("should skip scriptSrc when no scripts found", () => {
      const entries: NetworkEntry[] = [
        { url: "https://example.com/style.css", method: "GET", status: 200, mimeType: "text/css", size: 100, transferSize: 100, durationMs: 50, resourceType: "Stylesheet" },
      ];
      const result = collectSignals({ networkEntries: entries });
      expect(result.scriptSrc).toBeUndefined();
    });

    // --- Cookies (CookieEntry[]) ---

    it("should collect cookies from CookieEntry array", () => {
      const cookies: CookieEntry[] = [
        { name: "_ga", value: "GA1.2.123456", domain: ".example.com", path: "/", expires: 0, httpOnly: false, secure: false, sameSite: "Lax", size: 20 },
        { name: "PHPSESSID", value: "abc123", domain: "example.com", path: "/", expires: 0, httpOnly: true, secure: true, sameSite: "Strict", size: 10 },
      ];
      const result = collectSignals({ cookies });
      expect(result.cookies).toEqual({
        "_ga": ["GA1.2.123456"],
        "phpsessid": ["abc123"],
      });
    });

    it("should skip cookies when array is empty", () => {
      const result = collectSignals({ cookies: [] });
      expect(result.cookies).toBeUndefined();
    });

    // --- Cookies (string) ---

    it("should parse cookie string fallback", () => {
      const result = collectSignals({
        cookieString: "_ga=GA1.2.123456; PHPSESSID=abc123; _fbp=fb.1.123",
      });
      expect(result.cookies).toEqual({
        "_ga": ["GA1.2.123456"],
        "phpsessid": ["abc123"],
        "_fbp": ["fb.1.123"],
      });
    });

    it("should prefer CookieEntry[] over cookie string", () => {
      const cookies: CookieEntry[] = [
        { name: "_ga", value: "from-entry", domain: ".example.com", path: "/", expires: 0, httpOnly: false, secure: false, sameSite: "Lax", size: 10 },
      ];
      const result = collectSignals({
        cookies,
        cookieString: "_ga=from-string",
      });
      expect(result.cookies?.["_ga"]).toEqual(["from-entry"]);
    });

    // --- Meta tags ---

    it("should collect meta tags lowercase-keyed", () => {
      const result = collectSignals({
        metaTags: {
          "generator": "WordPress 6.4",
          "viewport": "width=device-width",
          "Description": "My site",
        },
      });
      expect(result.meta).toEqual({
        "generator": ["WordPress 6.4"],
        "viewport": ["width=device-width"],
        "description": ["My site"],
      });
    });

    it("should skip meta when empty", () => {
      const result = collectSignals({ metaTags: {} });
      expect(result.meta).toBeUndefined();
    });

    // --- JS globals ---

    it("should collect present JS globals", () => {
      const result = collectSignals({
        jsGlobals: {
          "jQuery.fn.jquery": "3.7.1",
          "React.version": "18.2.0",
          "angular.version.full": null,
          "Vue.version": null,
        },
      });
      expect(result.js).toEqual({
        "jQuery.fn.jquery": "3.7.1",
        "React.version": "18.2.0",
      });
    });

    it("should skip js when all globals are null", () => {
      const result = collectSignals({
        jsGlobals: {
          "React.version": null,
          "Vue.version": null,
        },
      });
      expect(result.js).toBeUndefined();
    });

    // --- URL ---

    it("should include page URL", () => {
      const result = collectSignals({ url: "https://example.com/about" });
      expect(result.url).toBe("https://example.com/about");
    });

    // --- HTML ---

    it("should include HTML snippet", () => {
      const html = '<div class="wp-content">test</div>';
      const result = collectSignals({ html });
      expect(result.html).toBe(html);
    });

    // --- Combined ---

    it("should collect all signal types from a realistic input", () => {
      const input: SignalCollectorInput = {
        responseHeaders: {
          "X-Powered-By": "Express",
          "Server": "nginx",
        },
        networkEntries: [
          { url: "https://cdn.example.com/jquery-3.7.1.min.js", method: "GET", status: 200, mimeType: "application/javascript", size: 90000, transferSize: 30000, durationMs: 50, resourceType: "Script" },
          { url: "https://example.com/", method: "GET", status: 200, mimeType: "text/html", size: 5000, transferSize: 5000, durationMs: 200, resourceType: "Document" },
        ],
        cookies: [
          { name: "_ga", value: "GA1.2.123", domain: ".example.com", path: "/", expires: 0, httpOnly: false, secure: false, sameSite: "Lax", size: 15 },
        ],
        metaTags: {
          "generator": "WordPress 6.4",
        },
        jsGlobals: {
          "jQuery.fn.jquery": "3.7.1",
          "wp.customize": "[object Object]",
          "React.version": null,
        },
        url: "https://example.com/",
        html: '<link rel="stylesheet" href="/wp-content/themes/style.css">',
      };

      const result = collectSignals(input);

      expect(result.headers).toEqual({
        "x-powered-by": ["Express"],
        "server": ["nginx"],
      });
      expect(result.scriptSrc).toEqual(["https://cdn.example.com/jquery-3.7.1.min.js"]);
      expect(result.cookies).toEqual({ "_ga": ["GA1.2.123"] });
      expect(result.meta).toEqual({ "generator": ["WordPress 6.4"] });
      expect(result.js).toEqual({
        "jQuery.fn.jquery": "3.7.1",
        "wp.customize": "[object Object]",
      });
      expect(result.url).toBe("https://example.com/");
      expect(result.html).toContain("wp-content");
    });
  });

  // --- JS globals expression builder ---

  describe("buildJSGlobalsCheckExpr", () => {
    it("should produce a self-executing function", () => {
      const expr = buildJSGlobalsCheckExpr(["jQuery.fn.jquery"]);
      expect(expr).toContain("(function()");
      expect(expr).toContain("return r;");
    });

    it("should include try/catch per path", () => {
      const expr = buildJSGlobalsCheckExpr(["React.version", "Vue.version"]);
      expect(expr).toContain("try { var v = React.version;");
      expect(expr).toContain("try { var v = Vue.version;");
    });

    it("should use default JS_GLOBAL_CHECKS when no paths given", () => {
      const expr = buildJSGlobalsCheckExpr();
      for (const check of JS_GLOBAL_CHECKS.slice(0, 5)) {
        expect(expr).toContain(check);
      }
    });

    it("should handle paths with single quotes", () => {
      const expr = buildJSGlobalsCheckExpr(["window['test']"]);
      expect(expr).toContain("window[\\'test\\']");
    });
  });

  // --- Meta tag extraction expression ---

  describe("META_TAG_EXTRACTION_EXPR", () => {
    it("should be a self-executing function", () => {
      expect(META_TAG_EXTRACTION_EXPR).toContain("(function()");
      expect(META_TAG_EXTRACTION_EXPR).toContain("querySelectorAll");
    });

    it("should query both name and property attributes", () => {
      expect(META_TAG_EXTRACTION_EXPR).toContain("meta[name]");
      expect(META_TAG_EXTRACTION_EXPR).toContain("meta[property]");
    });
  });

  // --- Integration: collectSignals → matchFingerprints ---

  describe("integration with fingerprint-db", () => {
    it("should produce signals compatible with matchFingerprints", async () => {
      const { matchFingerprints, resetCompiledDB } = await import("../../src/mcp-server/fingerprint-db.js");
      resetCompiledDB();

      const signals = collectSignals({
        metaTags: { "generator": "WordPress 6.4" },
        jsGlobals: { "jQuery.fn.jquery": "3.7.1" },
        networkEntries: [
          { url: "https://cdn.example.com/jquery.min.js", method: "GET", status: 200, mimeType: "application/javascript", size: 90000, transferSize: 30000, durationMs: 50, resourceType: "Script" },
        ],
      });

      const detections = matchFingerprints(signals);
      expect(detections.length).toBeGreaterThan(0);

      // WordPress should be detected via meta generator
      const wp = detections.find((d) => d.name === "WordPress");
      expect(wp).toBeDefined();
      expect(wp!.confidence).toBeGreaterThan(0);

      // jQuery should be detected via js global
      const jq = detections.find((d) => d.name === "jQuery");
      expect(jq).toBeDefined();
      expect(jq!.confidence).toBeGreaterThan(0);
    });
  });
});
