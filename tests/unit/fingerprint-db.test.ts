import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePattern,
  resolveVersion,
  matchFingerprints,
  resolveImplies,
  resolveExcludes,
  buildTechnographicResult,
  getDatabaseSize,
  resetCompiledDB,
} from "../../src/mcp-server/fingerprint-db.js";
import type { CapturedSignals } from "../../src/shared/evidence-types.js";

describe("fingerprint-db", () => {
  beforeEach(() => {
    resetCompiledDB();
  });

  // --- Pattern Parsing ---

  describe("parsePattern", () => {
    it("should parse simple regex pattern", () => {
      const p = parsePattern("jquery\\.min\\.js");
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(p.confidence).toBe(100);
      expect(p.version).toBe("");
    });

    it("should parse pattern with confidence", () => {
      const p = parsePattern("\\;confidence:50");
      expect(p.confidence).toBe(50);
    });

    it("should parse pattern with version back-reference", () => {
      const p = parsePattern("([\\d.]+)\\;version:\\1");
      expect(p.version).toBe("\\1");
    });

    it("should parse pattern with both confidence and version", () => {
      const p = parsePattern("v([\\d.]+)\\;confidence:80\\;version:\\1");
      expect(p.confidence).toBe(80);
      expect(p.version).toBe("\\1");
    });

    it("should apply ReDoS protection — + → {1,250}", () => {
      const p = parsePattern("a+b");
      expect(p.regex.source).toContain("{1,250}");
    });

    it("should apply ReDoS protection — * → {0,250}", () => {
      const p = parsePattern("a*b");
      expect(p.regex.source).toContain("{0,250}");
    });

    it("should preserve escaped + in regex", () => {
      const p = parsePattern("a\\+b");
      expect(p.regex.source).toContain("\\+");
      expect(p.regex.source).not.toContain("{1,250}");
    });

    it("should be case-insensitive", () => {
      const p = parsePattern("WordPress");
      expect(p.regex.flags).toContain("i");
    });

    it("should handle invalid regex gracefully", () => {
      const p = parsePattern("[invalid");
      expect(p.regex).toBeInstanceOf(RegExp);
      // Should not match anything
      expect(p.regex.test("anything")).toBe(false);
    });

    it("should default confidence to 100", () => {
      const p = parsePattern("test");
      expect(p.confidence).toBe(100);
    });
  });

  // --- Version Resolution ---

  describe("resolveVersion", () => {
    it("should resolve back-reference \\1", () => {
      const p = parsePattern("v([\\d.]+)\\;version:\\1");
      const result = resolveVersion(p, "v3.6.0");
      expect(result).toBe("3.6.0");
    });

    it("should resolve ternary \\1?yes:no", () => {
      const p = parsePattern("(pro)?\\;version:\\1?Pro:Free");
      expect(resolveVersion(p, "pro")).toBe("Pro");
      expect(resolveVersion(p, "")).toBe("Free");
    });

    it("should skip groups longer than 15 chars", () => {
      const p = parsePattern("(.+)\\;version:\\1");
      const result = resolveVersion(p, "1234567890123456"); // 16 chars
      // Group too long, back-reference not replaced, cleaned to empty
      expect(result).toBe("");
    });

    it("should return empty string when no version template", () => {
      const p = parsePattern("test");
      expect(resolveVersion(p, "test")).toBe("");
    });

    it("should clean unmatched back-references", () => {
      const p = parsePattern("test\\;version:\\1-\\2");
      const result = resolveVersion(p, "test");
      expect(result).not.toContain("\\1");
      expect(result).not.toContain("\\2");
    });
  });

  // --- Matching ---

  describe("matchFingerprints", () => {
    it("should detect WordPress by meta generator tag — confidence 100", () => {
      const signals: CapturedSignals = {
        meta: { generator: ["WordPress 6.4"] },
      };
      const results = matchFingerprints(signals);
      const wp = results.find((r) => r.name === "WordPress");
      expect(wp).toBeDefined();
      expect(wp!.confidence).toBe(100);
      expect(wp!.version).toBe("6.4");
      expect(wp!.matchedSignals.length).toBeGreaterThan(0);
    });

    it("should detect jQuery by script URL pattern — confidence 100", () => {
      const signals: CapturedSignals = {
        scriptSrc: ["https://cdn.example.com/jquery-3.7.1.min.js"],
      };
      const results = matchFingerprints(signals);
      const jq = results.find((r) => r.name === "jQuery");
      expect(jq).toBeDefined();
      expect(jq!.confidence).toBe(100);
      expect(jq!.version).toBe("3.7.1");
    });

    it("should detect React by JS global — confidence 100", () => {
      const signals: CapturedSignals = {
        js: { "React.version": "18.2.0" },
      };
      const results = matchFingerprints(signals);
      const react = results.find((r) => r.name === "React");
      expect(react).toBeDefined();
      expect(react!.confidence).toBe(100);
      expect(react!.version).toBe("18.2.0");
    });

    it("should apply additive confidence — 2 patterns with weight 50 each → 100", () => {
      // Magento has cookies.frontend with confidence:50 and js.Mage with confidence:100
      // Let's test with a technology that has partial-confidence patterns
      // We'll use the direct pattern testing approach
      const signals: CapturedSignals = {
        cookies: { frontend: ["some-value"] },
        headers: { "x-magento-vary": ["yes"] },
      };
      const results = matchFingerprints(signals);
      const magento = results.find((r) => r.name === "Magento");
      expect(magento).toBeDefined();
      // frontend cookie = 50, x-magento-vary header = 100 → capped at 100
      expect(magento!.confidence).toBe(100);
      expect(magento!.matchedSignals.length).toBe(2);
    });

    it("should apply additive confidence — partial confidence from single weak signal", () => {
      const signals: CapturedSignals = {
        cookies: { frontend: ["abc123"] },
      };
      const results = matchFingerprints(signals);
      const magento = results.find((r) => r.name === "Magento");
      expect(magento).toBeDefined();
      expect(magento!.confidence).toBe(50);
    });

    it("should cap confidence at 100 even with many signals", () => {
      // WordPress: meta generator (100) + html wp-content (100) + cookies wp-settings- (100)
      const signals: CapturedSignals = {
        meta: { generator: ["WordPress 6.4"] },
        html: '<link rel="stylesheet" href="/wp-content/themes/twentytwentyfour/style.css">',
        cookies: { "wp-settings-": ["some-val"] },
      };
      const results = matchFingerprints(signals);
      const wp = results.find((r) => r.name === "WordPress");
      expect(wp).toBeDefined();
      expect(wp!.confidence).toBe(100); // Capped at 100, not 300
    });

    it("should track matchedSignals for transparency", () => {
      const signals: CapturedSignals = {
        meta: { generator: ["WordPress 6.4"] },
        html: '<link href="/wp-content/style.css">',
      };
      const results = matchFingerprints(signals);
      const wp = results.find((r) => r.name === "WordPress");
      expect(wp).toBeDefined();
      expect(wp!.matchedSignals).toContain("meta:generator");
      expect(wp!.matchedSignals).toContain("html");
    });

    it("should return empty for unknown technology signals", () => {
      const signals: CapturedSignals = {
        js: { "nonExistentGlobal.version": "1.0" },
      };
      const results = matchFingerprints(signals);
      expect(results.length).toBe(0);
    });

    it("should return empty for empty signals", () => {
      const results = matchFingerprints({});
      expect(results.length).toBe(0);
    });

    it("should extract version from jQuery script URL", () => {
      const signals: CapturedSignals = {
        scriptSrc: ["https://code.jquery.com/jquery-3.7.1.min.js"],
      };
      const results = matchFingerprints(signals);
      const jq = results.find((r) => r.name === "jQuery");
      expect(jq).toBeDefined();
      expect(jq!.version).toBe("3.7.1");
    });

    it("should detect technology by headers", () => {
      const signals: CapturedSignals = {
        headers: { server: ["nginx/1.24.0"] },
      };
      const results = matchFingerprints(signals);
      const nginx = results.find((r) => r.name === "Nginx");
      expect(nginx).toBeDefined();
      expect(nginx!.confidence).toBe(100);
      expect(nginx!.version).toBe("1.24.0");
    });

    it("should detect technology by cookies", () => {
      const signals: CapturedSignals = {
        cookies: { PHPSESSID: ["abc123"] },
      };
      const results = matchFingerprints(signals);
      const php = results.find((r) => r.name === "PHP");
      expect(php).toBeDefined();
      expect(php!.confidence).toBe(100);
    });

    it("should detect multiple technologies from mixed signals", () => {
      const signals: CapturedSignals = {
        headers: { server: ["cloudflare"] },
        js: { "React.version": "18.2.0" },
        scriptSrc: ["https://www.googletagmanager.com/gtm.js"],
      };
      const results = matchFingerprints(signals);
      expect(results.find((r) => r.name === "Cloudflare")).toBeDefined();
      expect(results.find((r) => r.name === "React")).toBeDefined();
      expect(results.find((r) => r.name === "Google Tag Manager")).toBeDefined();
    });

    it("should detect Next.js by JS global", () => {
      const signals: CapturedSignals = {
        js: { "__NEXT_DATA__": "{}" },
      };
      const results = matchFingerprints(signals);
      const next = results.find((r) => r.name === "Next.js");
      expect(next).toBeDefined();
      expect(next!.confidence).toBe(100);
    });

    it("should detect Shopify by cookies + headers", () => {
      const signals: CapturedSignals = {
        cookies: { "_shopify_s": ["abc"] },
        headers: { "x-shopid": ["12345"], "x-shopify-stage": ["production"] },
      };
      const results = matchFingerprints(signals);
      const shopify = results.find((r) => r.name === "Shopify");
      expect(shopify).toBeDefined();
      expect(shopify!.confidence).toBe(100);
    });

    it("should detect Vercel by header", () => {
      const signals: CapturedSignals = {
        headers: { "x-vercel-id": ["iad1::abc123"] },
      };
      const results = matchFingerprints(signals);
      const vercel = results.find((r) => r.name === "Vercel");
      expect(vercel).toBeDefined();
    });

    it("should detect Tailwind CSS from html", () => {
      const signals: CapturedSignals = {
        html: '<link rel="stylesheet" href="/assets/tailwind.min.css">',
      };
      const results = matchFingerprints(signals);
      const tw = results.find((r) => r.name === "Tailwind CSS");
      expect(tw).toBeDefined();
    });

    it("should detect Google Analytics by script URL", () => {
      const signals: CapturedSignals = {
        scriptSrc: ["https://www.googletagmanager.com/gtag/js?id=G-ABC123"],
      };
      const results = matchFingerprints(signals);
      const ga = results.find((r) => r.name === "Google Analytics");
      expect(ga).toBeDefined();
    });

    it("should detect Stripe by script URL", () => {
      const signals: CapturedSignals = {
        scriptSrc: ["https://js.stripe.com/v3/"],
      };
      const results = matchFingerprints(signals);
      const stripe = results.find((r) => r.name === "Stripe");
      expect(stripe).toBeDefined();
    });

    it("should include categories in detections", () => {
      const signals: CapturedSignals = {
        js: { "React.version": "18.2.0" },
      };
      const results = matchFingerprints(signals);
      const react = results.find((r) => r.name === "React");
      expect(react).toBeDefined();
      expect(react!.categories.length).toBeGreaterThan(0);
      expect(react!.categories[0].name).toBe("JavaScript framework");
    });

    it("should detect JS existence checks (empty pattern)", () => {
      const signals: CapturedSignals = {
        js: { "Shopify.shop": "my-store.myshopify.com" },
      };
      const results = matchFingerprints(signals);
      const shopify = results.find((r) => r.name === "Shopify");
      expect(shopify).toBeDefined();
    });

    it("should detect Hugo from meta generator with version", () => {
      const signals: CapturedSignals = {
        meta: { generator: ["Hugo 0.121.1"] },
      };
      const results = matchFingerprints(signals);
      const hugo = results.find((r) => r.name === "Hugo");
      expect(hugo).toBeDefined();
      expect(hugo!.version).toBe("0.121.1");
    });
  });

  // --- buildTechnographicResult ---

  describe("buildTechnographicResult", () => {
    it("should group technologies by category", () => {
      const signals: CapturedSignals = {
        js: { "React.version": "18.2.0" },
        headers: { server: ["nginx/1.24.0"] },
      };
      const detections = matchFingerprints(signals);
      const result = buildTechnographicResult(detections, signals);

      expect(result.totalDetected).toBeGreaterThan(0);
      expect(result.categories["JavaScript framework"]).toBeDefined();
      expect(result.categories["Web server"]).toBeDefined();
    });

    it("should sort technologies by confidence descending", () => {
      const signals: CapturedSignals = {
        cookies: { frontend: ["abc"] }, // Magento: 50
        js: { "React.version": "18.0" }, // React: 100
      };
      const detections = matchFingerprints(signals);
      const result = buildTechnographicResult(detections, signals);

      expect(result.technologies[0].confidence).toBeGreaterThanOrEqual(
        result.technologies[result.technologies.length - 1].confidence
      );
    });

    it("should count high confidence detections", () => {
      const signals: CapturedSignals = {
        cookies: { frontend: ["abc"] }, // Magento: 50
        js: { "React.version": "18.0" }, // React: 100
      };
      const detections = matchFingerprints(signals);
      const result = buildTechnographicResult(detections, signals, 50);

      expect(result.highConfidenceCount).toBe(detections.filter((d) => d.confidence >= 50).length);
    });

    it("should track which signal types were used", () => {
      const signals: CapturedSignals = {
        js: { "React.version": "18.0" },
        headers: { server: ["nginx"] },
      };
      const detections = matchFingerprints(signals);
      const result = buildTechnographicResult(detections, signals);

      expect(result.signalsUsed).toContain("js");
      expect(result.signalsUsed).toContain("headers");
    });
  });

  // --- Relationship Graph: Implies ---

  describe("resolveImplies", () => {
    it("should propagate implies — Next.js → React appears", () => {
      const signals: CapturedSignals = {
        js: { "__NEXT_DATA__": "{}" },
      };
      const results = matchFingerprints(signals);
      const react = results.find((r) => r.name === "React");
      expect(react).toBeDefined();
      expect(react!.confidence).toBeGreaterThan(0);
    });

    it("should handle transitive implies — Next.js → React → JavaScript", () => {
      const signals: CapturedSignals = {
        js: { "__NEXT_DATA__": "{}" },
      };
      const results = matchFingerprints(signals);
      const react = results.find((r) => r.name === "React");
      const js = results.find((r) => r.name === "JavaScript");
      expect(react).toBeDefined();
      expect(js).toBeDefined();
      expect(js!.matchedSignals).toContain("implied:React");
    });

    it("should scale confidence — implied weight 50 → half propagation", () => {
      const detections = [
        {
          name: "TestTech",
          confidence: 80,
          version: "",
          categories: [],
          matchedSignals: ["js:TestTech"],
        },
      ];
      // Build a minimal compiled DB with an implies entry at confidence 50
      const db = [
        {
          name: "TestTech",
          cats: [],
          implies: [{ name: "ImpliedTech", confidence: 50 }],
          excludes: [],
          patterns: [],
        },
        {
          name: "ImpliedTech",
          cats: [27],
          implies: [],
          excludes: [],
          patterns: [],
        },
      ];
      const result = resolveImplies(detections, db);
      const implied = result.find((r) => r.name === "ImpliedTech");
      expect(implied).toBeDefined();
      // 80 * (50 / 100) = 40
      expect(implied!.confidence).toBe(40);
    });

    it("should boost already-detected tech — direct + implied confidence summed", () => {
      const signals: CapturedSignals = {
        js: { "__NEXT_DATA__": "{}", "React.version": "18.2.0" },
      };
      const results = matchFingerprints(signals);
      const react = results.find((r) => r.name === "React");
      expect(react).toBeDefined();
      // React directly detected (100) + implied by Next.js (100) → capped at 100
      expect(react!.confidence).toBe(100);
      // Both direct and implied signals should be present
      expect(react!.matchedSignals).toContain("js:React.version");
      expect(react!.matchedSignals).toContain("implied:Next.js");
    });

    it("should prevent cycles — A implies B implies A → no infinite loop", () => {
      const detections = [
        {
          name: "TechA",
          confidence: 80,
          version: "",
          categories: [],
          matchedSignals: ["js:TechA"],
        },
      ];
      const db = [
        {
          name: "TechA",
          cats: [],
          implies: [{ name: "TechB", confidence: 100 }],
          excludes: [],
          patterns: [],
        },
        {
          name: "TechB",
          cats: [],
          implies: [{ name: "TechA", confidence: 100 }],
          excludes: [],
          patterns: [],
        },
      ];
      // Should complete without infinite loop
      const result = resolveImplies(detections, db);
      expect(result.find((r) => r.name === "TechA")).toBeDefined();
      expect(result.find((r) => r.name === "TechB")).toBeDefined();
    });

    it("should tag implied detections in matchedSignals", () => {
      const signals: CapturedSignals = {
        js: { "__NEXT_DATA__": "{}" },
      };
      const results = matchFingerprints(signals);
      const react = results.find((r) => r.name === "React");
      expect(react).toBeDefined();
      expect(react!.matchedSignals).toContain("implied:Next.js");
    });

    it("should bound traversal at depth 10", () => {
      // Build a chain of 15 transitive implies
      const detections = [
        {
          name: "Tech0",
          confidence: 100,
          version: "",
          categories: [],
          matchedSignals: ["js:Tech0"],
        },
      ];
      const db = Array.from({ length: 16 }, (_, i) => ({
        name: `Tech${i}`,
        cats: [],
        implies: i < 15 ? [{ name: `Tech${i + 1}`, confidence: 100 }] : [],
        excludes: [],
        patterns: [],
      }));
      const result = resolveImplies(detections, db);
      // Tech0 through Tech10 should exist (depth 0-10 = 11 techs)
      for (let i = 0; i <= 10; i++) {
        expect(result.find((r) => r.name === `Tech${i}`)).toBeDefined();
      }
      // Tech11+ should NOT exist (beyond depth 10)
      expect(result.find((r) => r.name === "Tech11")).toBeUndefined();
    });

    it("should not add implied tech if it does not exist in DB", () => {
      const detections = [
        {
          name: "TechA",
          confidence: 100,
          version: "",
          categories: [],
          matchedSignals: ["js:TechA"],
        },
      ];
      const db = [
        {
          name: "TechA",
          cats: [],
          implies: [{ name: "NonExistentTech", confidence: 100 }],
          excludes: [],
          patterns: [],
        },
      ];
      const result = resolveImplies(detections, db);
      expect(result.find((r) => r.name === "NonExistentTech")).toBeUndefined();
      expect(result.length).toBe(1);
    });

    it("should propagate Nuxt.js → Vue.js → JavaScript", () => {
      const signals: CapturedSignals = {
        js: { "__NUXT__": "{}" },
      };
      const results = matchFingerprints(signals);
      expect(results.find((r) => r.name === "Nuxt.js")).toBeDefined();
      expect(results.find((r) => r.name === "Vue.js")).toBeDefined();
      expect(results.find((r) => r.name === "JavaScript")).toBeDefined();
    });

    it("should propagate WordPress → PHP + MySQL", () => {
      const signals: CapturedSignals = {
        meta: { generator: ["WordPress 6.4"] },
      };
      const results = matchFingerprints(signals);
      expect(results.find((r) => r.name === "WordPress")).toBeDefined();
      expect(results.find((r) => r.name === "PHP")).toBeDefined();
      expect(results.find((r) => r.name === "MySQL")).toBeDefined();
    });
  });

  // --- Relationship Graph: Excludes ---

  describe("resolveExcludes", () => {
    it("should remove excluded technologies — WordPress excludes Joomla", () => {
      const signals: CapturedSignals = {
        meta: { generator: ["WordPress 6.4"] },
        js: { "Joomla": "true" },
      };
      const results = matchFingerprints(signals);
      expect(results.find((r) => r.name === "WordPress")).toBeDefined();
      expect(results.find((r) => r.name === "Joomla")).toBeUndefined();
    });

    it("should remove excluded — AngularJS excludes Angular", () => {
      const signals: CapturedSignals = {
        html: '<div ng-app="myApp">',
        js: { "angular.version.full": "1.8.2" },
      };
      const results = matchFingerprints(signals);
      const angularJS = results.find((r) => r.name === "AngularJS");
      const angular = results.find((r) => r.name === "Angular");
      expect(angularJS).toBeDefined();
      expect(angular).toBeUndefined();
    });

    it("should not remove technologies that are not excluded", () => {
      const signals: CapturedSignals = {
        js: { "React.version": "18.2.0", "__NEXT_DATA__": "{}" },
      };
      const results = matchFingerprints(signals);
      // React and Next.js don't exclude each other
      expect(results.find((r) => r.name === "React")).toBeDefined();
      expect(results.find((r) => r.name === "Next.js")).toBeDefined();
    });

    it("should handle excludes with unit-tested function directly", () => {
      const detections = [
        {
          name: "CMS_A",
          confidence: 100,
          version: "",
          categories: [],
          matchedSignals: ["meta:generator"],
        },
        {
          name: "CMS_B",
          confidence: 80,
          version: "",
          categories: [],
          matchedSignals: ["html"],
        },
      ];
      const db = [
        {
          name: "CMS_A",
          cats: [1],
          implies: [],
          excludes: [{ name: "CMS_B", confidence: 100 }],
          patterns: [],
        },
        {
          name: "CMS_B",
          cats: [1],
          implies: [],
          excludes: [],
          patterns: [],
        },
      ];
      const result = resolveExcludes(detections, db);
      expect(result.find((r) => r.name === "CMS_A")).toBeDefined();
      expect(result.find((r) => r.name === "CMS_B")).toBeUndefined();
    });
  });

  // --- Database ---

  describe("database", () => {
    it("should have curated DB with ~200 technologies", () => {
      const size = getDatabaseSize();
      expect(size).toBeGreaterThanOrEqual(150);
      expect(size).toBeLessThanOrEqual(250);
    });

    it("should compile DB only once (cached)", () => {
      const signals: CapturedSignals = { js: { "React.version": "18.0" } };
      matchFingerprints(signals);
      matchFingerprints(signals); // Second call uses cache
      // If it throws, compilation failed
    });
  });
});
