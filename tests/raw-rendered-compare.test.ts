import { describe, it, expect } from "vitest";
import type {
  SeoElements,
  RawRenderedDiff,
  RawRenderedComparison,
} from "@/shared/seo-types";

// --- Type structure tests ---

describe("SeoElements type structure", () => {
  it("accepts full SEO element set", () => {
    const seo: SeoElements = {
      title: "Example Page",
      metaDescription: "A test page for SEO analysis",
      canonical: "https://example.com/",
      headings: [
        { level: 1, text: "Main Title" },
        { level: 2, text: "Section 1" },
      ],
      linkCount: 42,
      structuredData: [{ "@type": "WebPage", name: "Example" }],
      contentLength: 12000,
      textLength: 5000,
    };
    expect(seo.title).toBe("Example Page");
    expect(seo.headings).toHaveLength(2);
  });

  it("accepts null values for missing elements", () => {
    const seo: SeoElements = {
      title: null,
      metaDescription: null,
      canonical: null,
      headings: [],
      linkCount: 0,
      structuredData: [],
      contentLength: 0,
      textLength: 0,
    };
    expect(seo.title).toBeNull();
    expect(seo.linkCount).toBe(0);
  });
});

describe("RawRenderedDiff type structure", () => {
  it("represents a high-impact title difference", () => {
    const diff: RawRenderedDiff = {
      element: "title",
      raw: null,
      rendered: "Dynamic Page Title",
      impact: "high",
      description: "Title set entirely by JavaScript",
    };
    expect(diff.impact).toBe("high");
  });

  it("represents a medium-impact heading change", () => {
    const diff: RawRenderedDiff = {
      element: "headings",
      raw: 2,
      rendered: 8,
      impact: "medium",
      description: "Heading count changed: 2 raw → 8 rendered",
    };
    expect(diff.impact).toBe("medium");
  });

  it("represents a low-impact content size change", () => {
    const diff: RawRenderedDiff = {
      element: "contentSize",
      raw: 5000,
      rendered: 15000,
      impact: "low",
      description: "HTML size changed by 200%: 5000 → 15000 bytes",
    };
    expect(diff.impact).toBe("low");
  });
});

describe("RawRenderedComparison type structure", () => {
  it("represents a static page with no JS dependencies", () => {
    const seo: SeoElements = {
      title: "Static Page",
      metaDescription: "Same in raw and rendered",
      canonical: "https://example.com/",
      headings: [{ level: 1, text: "Hello" }],
      linkCount: 5,
      structuredData: [],
      contentLength: 3000,
      textLength: 1200,
    };
    const comparison: RawRenderedComparison = {
      url: "https://example.com/",
      raw: { html: "<html>...</html>", seoElements: seo, size: 3000 },
      rendered: { html: "<html>...</html>", seoElements: seo, size: 3000 },
      differences: [],
      jsDependent: false,
      riskLevel: "low",
    };
    expect(comparison.jsDependent).toBe(false);
    expect(comparison.riskLevel).toBe("low");
    expect(comparison.differences).toHaveLength(0);
  });

  it("represents a SPA with high JS dependency", () => {
    const rawSeo: SeoElements = {
      title: null,
      metaDescription: null,
      canonical: null,
      headings: [],
      linkCount: 0,
      structuredData: [],
      contentLength: 500,
      textLength: 20,
    };
    const renderedSeo: SeoElements = {
      title: "My SPA Page",
      metaDescription: "Loaded by JavaScript",
      canonical: "https://example.com/page",
      headings: [
        { level: 1, text: "Welcome" },
        { level: 2, text: "Features" },
        { level: 2, text: "About" },
      ],
      linkCount: 25,
      structuredData: [{ "@type": "WebPage" }],
      contentLength: 15000,
      textLength: 5000,
    };
    const comparison: RawRenderedComparison = {
      url: "https://example.com/page",
      raw: { html: '<div id="root"></div>', seoElements: rawSeo, size: 500 },
      rendered: { html: "<html>...</html>", seoElements: renderedSeo, size: 15000 },
      differences: [
        { element: "title", raw: null, rendered: "My SPA Page", impact: "high", description: "Title set entirely by JavaScript" },
        { element: "metaDescription", raw: null, rendered: "Loaded by JavaScript", impact: "high", description: "Meta description set entirely by JavaScript" },
        { element: "canonical", raw: null, rendered: "https://example.com/page", impact: "high", description: "Canonical URL set entirely by JavaScript" },
        { element: "headings", raw: 0, rendered: 3, impact: "medium", description: "Heading count changed: 0 raw → 3 rendered" },
        { element: "links", raw: 0, rendered: 25, impact: "medium", description: "Link count changed: 0 raw → 25 rendered" },
        { element: "structuredData", raw: 0, rendered: 1, impact: "high", description: "Structured data injected entirely by JavaScript" },
        { element: "contentSize", raw: 500, rendered: 15000, impact: "low", description: "HTML size changed by 2900%: 500 → 15000 bytes" },
      ],
      jsDependent: true,
      riskLevel: "high",
    };
    expect(comparison.jsDependent).toBe(true);
    expect(comparison.riskLevel).toBe("high");
    expect(comparison.differences).toHaveLength(7);
    expect(comparison.differences.filter(d => d.impact === "high")).toHaveLength(4);
  });
});

// --- Risk level determination logic tests ---

describe("Risk level assessment", () => {
  function computeRisk(diffs: RawRenderedDiff[]): "low" | "medium" | "high" {
    const hasHigh = diffs.some(d => d.impact === "high");
    const hasMedium = diffs.some(d => d.impact === "medium");
    return hasHigh ? "high" : hasMedium ? "medium" : "low";
  }

  it("returns low when no differences", () => {
    expect(computeRisk([])).toBe("low");
  });

  it("returns low when only low-impact differences", () => {
    expect(computeRisk([
      { element: "contentSize", raw: 1000, rendered: 1500, impact: "low", description: "" },
    ])).toBe("low");
  });

  it("returns medium when medium-impact differences present", () => {
    expect(computeRisk([
      { element: "headings", raw: 2, rendered: 5, impact: "medium", description: "" },
    ])).toBe("medium");
  });

  it("returns high when any high-impact difference present", () => {
    expect(computeRisk([
      { element: "contentSize", raw: 1000, rendered: 5000, impact: "low", description: "" },
      { element: "title", raw: "Old", rendered: "New", impact: "high", description: "" },
    ])).toBe("high");
  });

  it("high takes precedence over medium", () => {
    expect(computeRisk([
      { element: "headings", raw: 0, rendered: 3, impact: "medium", description: "" },
      { element: "canonical", raw: null, rendered: "https://x.com", impact: "high", description: "" },
    ])).toBe("high");
  });
});

// --- SEO element extraction logic tests (regex-based, matching background.ts) ---

describe("Raw HTML SEO extraction (regex patterns)", () => {
  function extractTitle(html: string): string | null {
    return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim() || null;
  }

  function extractMetaDescription(html: string): string | null {
    const m = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    return m?.[1] || null;
  }

  function extractCanonical(html: string): string | null {
    const m = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
    return m?.[1] || null;
  }

  function extractHeadings(html: string): Array<{ level: number; text: string }> {
    const headings: Array<{ level: number; text: string }> = [];
    const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      headings.push({ level: parseInt(m[1].substring(1), 10), text: m[2].replace(/<[^>]*>/g, "").trim().substring(0, 200) });
    }
    return headings;
  }

  function extractLinkCount(html: string): number {
    return (html.match(/<a\s[^>]*href=/gi) || []).length;
  }

  function extractStructuredDataCount(html: string): number {
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      try { JSON.parse(m[1]); count++; } catch { /* skip */ }
    }
    return count;
  }

  it("extracts title from standard HTML", () => {
    expect(extractTitle("<html><head><title>Hello World</title></head></html>")).toBe("Hello World");
  });

  it("returns null for empty title", () => {
    expect(extractTitle("<html><head><title></title></head></html>")).toBeNull();
  });

  it("returns null when no title tag", () => {
    expect(extractTitle("<html><head></head></html>")).toBeNull();
  });

  it("extracts meta description with name before content", () => {
    expect(extractMetaDescription('<meta name="description" content="A great page">')).toBe("A great page");
  });

  it("extracts meta description with content before name", () => {
    expect(extractMetaDescription('<meta content="A great page" name="description">')).toBe("A great page");
  });

  it("returns null when no meta description", () => {
    expect(extractMetaDescription("<html></html>")).toBeNull();
  });

  it("extracts canonical with rel before href", () => {
    expect(extractCanonical('<link rel="canonical" href="https://example.com/">')).toBe("https://example.com/");
  });

  it("extracts canonical with href before rel", () => {
    expect(extractCanonical('<link href="https://example.com/" rel="canonical">')).toBe("https://example.com/");
  });

  it("extracts headings in document order", () => {
    const html = "<h1>Title</h1><h3>Sub</h3><h2>Section</h2>";
    const headings = extractHeadings(html);
    expect(headings).toEqual([
      { level: 1, text: "Title" },
      { level: 3, text: "Sub" },
      { level: 2, text: "Section" },
    ]);
  });

  it("strips inner HTML from heading text", () => {
    const html = "<h1><span class='highlight'>Bold</span> Title</h1>";
    const headings = extractHeadings(html);
    expect(headings[0].text).toBe("Bold Title");
  });

  it("counts links with href attribute", () => {
    const html = '<a href="/about">About</a><a href="/contact">Contact</a><a>No href</a>';
    expect(extractLinkCount(html)).toBe(2);
  });

  it("extracts JSON-LD structured data count", () => {
    const html = `
      <script type="application/ld+json">{"@type":"WebPage"}</script>
      <script type="application/ld+json">{"@type":"Organization"}</script>
      <script type="text/javascript">var x = 1;</script>
    `;
    expect(extractStructuredDataCount(html)).toBe(2);
  });

  it("skips malformed JSON-LD", () => {
    const html = '<script type="application/ld+json">not valid json</script><script type="application/ld+json">{"@type":"WebPage"}</script>';
    expect(extractStructuredDataCount(html)).toBe(1);
  });
});

// --- Diff detection thresholds ---

describe("Diff detection thresholds", () => {
  it("link count difference must exceed 5 to be flagged", () => {
    // This matches the logic in background.ts: Math.abs(rawLinkCount - renderedLinkCount) > 5
    const rawLinks = 10;
    const renderedLinks = 15;
    expect(Math.abs(rawLinks - renderedLinks) > 5).toBe(false); // 5 is not > 5

    const renderedLinks2 = 16;
    expect(Math.abs(rawLinks - renderedLinks2) > 5).toBe(true); // 6 > 5
  });

  it("content size ratio must exceed 30% to be flagged", () => {
    const rawSize = 10000;
    const renderedSize = 13000; // 30% increase
    const ratio = Math.abs(renderedSize - rawSize) / rawSize;
    expect(ratio > 0.3).toBe(false); // 0.3 is not > 0.3

    const renderedSize2 = 13001;
    const ratio2 = Math.abs(renderedSize2 - rawSize) / rawSize;
    expect(ratio2 > 0.3).toBe(true);
  });
});
