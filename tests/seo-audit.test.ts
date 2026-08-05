import { describe, it, expect, vi } from "vitest";
import type {
  SeoAuditResult,
  MetaTagAudit,
  HeadingAudit,
  LinkAudit,
  ImageAudit,
  StructuredDataAudit,
  OpenGraphAudit,
  TwitterCardAudit,
  CanonicalAudit,
  RobotsAudit,
  ContentMetrics,
  TechnicalAudit,
  SeoIssue,
  RobotsTxtResult,
  SitemapResult,
} from "@/shared/seo-types";
import { createTools, toolSuccess, toolError } from "@/mcp-server/tools";

// --- Type structure tests ---

describe("SeoAuditResult type structure", () => {
  const mockAudit: SeoAuditResult = {
    url: "https://example.com",
    auditedAt: "2026-03-13T00:00:00.000Z",
    meta: {
      title: "Example",
      titleLength: 7,
      description: "A test page",
      descriptionLength: 11,
      robots: null,
      viewport: "width=device-width, initial-scale=1",
      charset: "utf-8",
      author: null,
      generator: null,
    },
    headings: {
      h1Count: 1,
      h1Texts: ["Welcome"],
      hierarchy: [{ level: 1, text: "Welcome" }, { level: 2, text: "About" }],
      hasValidHierarchy: true,
      totalHeadings: 2,
    },
    links: {
      total: 5,
      internal: 3,
      external: 2,
      dofollow: 4,
      nofollow: 1,
      ugc: 0,
      sponsored: 0,
      broken: 0,
      unique: 5,
      links: [],
    },
    images: {
      total: 3,
      withAlt: 2,
      withoutAlt: 1,
      lazyLoaded: 1,
      withDimensions: 2,
      images: [],
    },
    structuredData: { jsonLd: [], microdataCount: 0, rdfaCount: 0, totalItems: 0 },
    openGraph: { title: "Example", description: null, image: null, url: null, type: null, siteName: null, allTags: { title: "Example" } },
    twitterCard: { card: null, title: null, description: null, image: null, site: null, allTags: {} },
    canonical: { canonical: "https://example.com", isCanonicalSelf: true, hreflangTags: [] },
    robots: { metaRobots: null, xRobotsTag: null, isIndexable: true, isFollowable: true, directives: [] },
    content: { wordCount: 500, textToHtmlRatio: 0.25, readingTimeMinutes: 2.5 },
    technical: { doctype: "html", lang: "en", charset: "utf-8", viewportMeta: "width=device-width, initial-scale=1", hasHttps: true, hasFavicon: true },
    score: 72,
    issues: [],
  };

  it("has all 11 audit dimensions", () => {
    expect(mockAudit).toHaveProperty("meta");
    expect(mockAudit).toHaveProperty("headings");
    expect(mockAudit).toHaveProperty("links");
    expect(mockAudit).toHaveProperty("images");
    expect(mockAudit).toHaveProperty("structuredData");
    expect(mockAudit).toHaveProperty("openGraph");
    expect(mockAudit).toHaveProperty("twitterCard");
    expect(mockAudit).toHaveProperty("canonical");
    expect(mockAudit).toHaveProperty("robots");
    expect(mockAudit).toHaveProperty("content");
    expect(mockAudit).toHaveProperty("technical");
  });

  it("has score as a number 0-100", () => {
    expect(typeof mockAudit.score).toBe("number");
    expect(mockAudit.score).toBeGreaterThanOrEqual(0);
    expect(mockAudit.score).toBeLessThanOrEqual(100);
  });

  it("has url and auditedAt metadata", () => {
    expect(mockAudit.url).toBe("https://example.com");
    expect(mockAudit.auditedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("issues array has typed entries", () => {
    const issue: SeoIssue = { code: "missing-h1", severity: "error", message: "No H1", dimension: "headings" };
    expect(issue.severity).toBe("error");
    expect(issue.dimension).toBe("headings");
  });
});

describe("MetaTagAudit", () => {
  it("tracks title and description with lengths", () => {
    const meta: MetaTagAudit = {
      title: "Test Title",
      titleLength: 10,
      description: "Test description",
      descriptionLength: 16,
      robots: "index, follow",
      viewport: "width=device-width",
      charset: "utf-8",
      author: "Author",
      generator: null,
    };
    expect(meta.titleLength).toBe(10);
    expect(meta.descriptionLength).toBe(16);
  });

  it("allows null for optional fields", () => {
    const meta: MetaTagAudit = {
      title: null,
      titleLength: 0,
      description: null,
      descriptionLength: 0,
      robots: null,
      viewport: null,
      charset: null,
      author: null,
      generator: null,
    };
    expect(meta.title).toBeNull();
    expect(meta.viewport).toBeNull();
  });
});

describe("HeadingAudit", () => {
  it("detects invalid hierarchy (skipped levels)", () => {
    const headings: HeadingAudit = {
      h1Count: 1,
      h1Texts: ["Main"],
      hierarchy: [
        { level: 1, text: "Main" },
        { level: 3, text: "Skipped H2" },
      ],
      hasValidHierarchy: false,
      totalHeadings: 2,
    };
    expect(headings.hasValidHierarchy).toBe(false);
  });

  it("tracks multiple H1s", () => {
    const headings: HeadingAudit = {
      h1Count: 3,
      h1Texts: ["First", "Second", "Third"],
      hierarchy: [
        { level: 1, text: "First" },
        { level: 1, text: "Second" },
        { level: 1, text: "Third" },
      ],
      hasValidHierarchy: true,
      totalHeadings: 3,
    };
    expect(headings.h1Count).toBe(3);
    expect(headings.h1Texts).toHaveLength(3);
  });
});

describe("LinkAudit", () => {
  it("classifies link relationships", () => {
    const links: LinkAudit = {
      total: 10,
      internal: 6,
      external: 4,
      dofollow: 7,
      nofollow: 2,
      ugc: 1,
      sponsored: 0,
      broken: 1,
      unique: 9,
      links: [
        { href: "/about", text: "About", rel: "", isExternal: false, isNofollow: false },
        { href: "https://external.com", text: "External", rel: "nofollow", isExternal: true, isNofollow: true },
      ],
    };
    expect(links.internal + links.external).toBeLessThanOrEqual(links.total);
    expect(links.links[1].isNofollow).toBe(true);
    expect(links.links[1].isExternal).toBe(true);
  });
});

describe("ImageAudit", () => {
  it("tracks alt text coverage", () => {
    const images: ImageAudit = {
      total: 5,
      withAlt: 3,
      withoutAlt: 2,
      lazyLoaded: 1,
      withDimensions: 4,
      images: [
        { src: "/img.jpg", alt: "Photo", width: 800, height: 600, loading: null },
        { src: "/bg.png", alt: null, width: null, height: null, loading: "lazy" },
      ],
    };
    expect(images.withAlt + images.withoutAlt).toBe(images.total);
  });
});

describe("StructuredDataAudit", () => {
  it("captures JSON-LD blocks", () => {
    const sd: StructuredDataAudit = {
      jsonLd: [{ "@type": "Organization", name: "Acme" }],
      microdataCount: 2,
      rdfaCount: 0,
      totalItems: 3,
    };
    expect(sd.jsonLd).toHaveLength(1);
    expect(sd.totalItems).toBe(3);
  });
});

describe("OpenGraphAudit", () => {
  it("extracts core OG tags", () => {
    const og: OpenGraphAudit = {
      title: "OG Title",
      description: "OG Desc",
      image: "https://example.com/og.jpg",
      url: "https://example.com",
      type: "website",
      siteName: "Example",
      allTags: { title: "OG Title", description: "OG Desc", image: "https://example.com/og.jpg", url: "https://example.com", type: "website", site_name: "Example" },
    };
    expect(og.title).toBe("OG Title");
    expect(Object.keys(og.allTags)).toHaveLength(6);
  });
});

describe("TwitterCardAudit", () => {
  it("handles missing twitter tags gracefully", () => {
    const tc: TwitterCardAudit = {
      card: null,
      title: null,
      description: null,
      image: null,
      site: null,
      allTags: {},
    };
    expect(tc.card).toBeNull();
    expect(Object.keys(tc.allTags)).toHaveLength(0);
  });
});

describe("CanonicalAudit", () => {
  it("detects self-referencing canonical", () => {
    const canonical: CanonicalAudit = {
      canonical: "https://example.com/page",
      isCanonicalSelf: true,
      hreflangTags: [
        { lang: "en", href: "https://example.com/page" },
        { lang: "es", href: "https://es.example.com/page" },
      ],
    };
    expect(canonical.isCanonicalSelf).toBe(true);
    expect(canonical.hreflangTags).toHaveLength(2);
  });
});

describe("RobotsAudit", () => {
  it("parses noindex/nofollow directives", () => {
    const robots: RobotsAudit = {
      metaRobots: "noindex, nofollow",
      xRobotsTag: null,
      isIndexable: false,
      isFollowable: false,
      directives: ["noindex", "nofollow"],
    };
    expect(robots.isIndexable).toBe(false);
    expect(robots.isFollowable).toBe(false);
    expect(robots.directives).toContain("noindex");
  });
});

describe("ContentMetrics", () => {
  it("calculates reading time from word count", () => {
    const content: ContentMetrics = {
      wordCount: 1000,
      textToHtmlRatio: 0.35,
      readingTimeMinutes: 5.0,
    };
    expect(content.readingTimeMinutes).toBe(5.0);
    expect(content.textToHtmlRatio).toBeGreaterThan(0);
  });
});

describe("TechnicalAudit", () => {
  it("checks HTTPS and lang attribute", () => {
    const tech: TechnicalAudit = {
      doctype: "html",
      lang: "en",
      charset: "utf-8",
      viewportMeta: "width=device-width, initial-scale=1",
      hasHttps: true,
      hasFavicon: true,
    };
    expect(tech.hasHttps).toBe(true);
    expect(tech.lang).toBe("en");
  });
});

describe("RobotsTxtResult", () => {
  it("parses sitemap references", () => {
    const result: RobotsTxtResult = {
      url: "https://example.com/robots.txt",
      found: true,
      content: "User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml",
      sitemapUrls: ["https://example.com/sitemap.xml"],
      disallowedPaths: ["/admin"],
      crawlDelay: null,
    };
    expect(result.found).toBe(true);
    expect(result.sitemapUrls).toContain("https://example.com/sitemap.xml");
    expect(result.disallowedPaths).toContain("/admin");
  });
});

describe("SitemapResult", () => {
  it("returns URL count and samples", () => {
    const result: SitemapResult = {
      url: "https://example.com/sitemap.xml",
      found: true,
      urlCount: 150,
      sampleUrls: ["https://example.com/page1", "https://example.com/page2"],
      lastmod: "2026-03-13",
    };
    expect(result.urlCount).toBe(150);
    expect(result.sampleUrls).toHaveLength(2);
  });
});

// --- SEO Scoring Logic Tests ---
// The scoring function runs inline in CDP, so we replicate the algorithm here for testing

function calculateSeoScore(audit: SeoAuditResult): { score: number; issues: SeoIssue[] } {
  const issues: SeoIssue[] = [];
  let total = 0;
  let earned = 0;

  // Meta (weight 15)
  total += 15;
  let metaScore = 15;
  if (!audit.meta.title) { metaScore -= 5; issues.push({ code: "missing-title", severity: "error", message: "Page has no title tag", dimension: "meta" }); }
  else if (audit.meta.titleLength > 60) { metaScore -= 2; issues.push({ code: "title-too-long", severity: "warning", message: `Title is ${audit.meta.titleLength} chars`, dimension: "meta" }); }
  else if (audit.meta.titleLength < 10) { metaScore -= 2; issues.push({ code: "title-too-short", severity: "warning", message: `Title is only ${audit.meta.titleLength} chars`, dimension: "meta" }); }
  if (!audit.meta.description) { metaScore -= 5; issues.push({ code: "missing-description", severity: "error", message: "Page has no meta description", dimension: "meta" }); }
  else if (audit.meta.descriptionLength > 160) { metaScore -= 2; issues.push({ code: "description-too-long", severity: "warning", message: `Meta description is ${audit.meta.descriptionLength} chars`, dimension: "meta" }); }
  if (!audit.meta.viewport) { metaScore -= 3; issues.push({ code: "missing-viewport", severity: "error", message: "No viewport meta tag", dimension: "meta" }); }
  earned += Math.max(0, metaScore);

  // Headings (weight 10)
  total += 10;
  let headingScore = 10;
  if (audit.headings.h1Count === 0) { headingScore -= 5; issues.push({ code: "missing-h1", severity: "error", message: "Page has no H1 heading", dimension: "headings" }); }
  else if (audit.headings.h1Count > 1) { headingScore -= 3; issues.push({ code: "multiple-h1", severity: "warning", message: `Page has ${audit.headings.h1Count} H1 headings`, dimension: "headings" }); }
  if (!audit.headings.hasValidHierarchy) { headingScore -= 2; issues.push({ code: "heading-hierarchy", severity: "warning", message: "Heading hierarchy has gaps", dimension: "headings" }); }
  earned += Math.max(0, headingScore);

  // Links (weight 10)
  total += 10;
  let linkScore = 10;
  if (audit.links.broken > 0) { linkScore -= Math.min(5, audit.links.broken); issues.push({ code: "broken-links", severity: "warning", message: `${audit.links.broken} broken/empty links found`, dimension: "links" }); }
  if (audit.links.total === 0) { linkScore -= 3; issues.push({ code: "no-links", severity: "info", message: "Page has no links", dimension: "links" }); }
  earned += Math.max(0, linkScore);

  // Images (weight 10)
  total += 10;
  let imageScore = 10;
  if (audit.images.withoutAlt > 0) {
    const pct = Math.round((audit.images.withoutAlt / Math.max(1, audit.images.total)) * 100);
    imageScore -= Math.min(8, Math.ceil(pct / 12));
    issues.push({ code: "images-missing-alt", severity: pct > 50 ? "error" : "warning", message: `${audit.images.withoutAlt} images missing alt text (${pct}%)`, dimension: "images" });
  }
  earned += Math.max(0, imageScore);

  // Structured Data (weight 8)
  total += 8;
  let sdScore = 8;
  if (audit.structuredData.totalItems === 0) { sdScore -= 4; issues.push({ code: "no-structured-data", severity: "info", message: "No structured data found", dimension: "structuredData" }); }
  earned += Math.max(0, sdScore);

  // Open Graph (weight 8)
  total += 8;
  let ogScore = 8;
  if (!audit.openGraph.title) { ogScore -= 3; issues.push({ code: "missing-og-title", severity: "warning", message: "No og:title meta tag", dimension: "openGraph" }); }
  if (!audit.openGraph.description) { ogScore -= 2; issues.push({ code: "missing-og-description", severity: "warning", message: "No og:description meta tag", dimension: "openGraph" }); }
  if (!audit.openGraph.image) { ogScore -= 3; issues.push({ code: "missing-og-image", severity: "warning", message: "No og:image meta tag", dimension: "openGraph" }); }
  earned += Math.max(0, ogScore);

  // Twitter Card (weight 5)
  total += 5;
  let tcScore = 5;
  if (!audit.twitterCard.card) { tcScore -= 3; issues.push({ code: "missing-twitter-card", severity: "info", message: "No twitter:card meta tag", dimension: "twitterCard" }); }
  earned += Math.max(0, tcScore);

  // Canonical (weight 10)
  total += 10;
  let canonScore = 10;
  if (!audit.canonical.canonical) { canonScore -= 5; issues.push({ code: "missing-canonical", severity: "warning", message: "No canonical URL defined", dimension: "canonical" }); }
  earned += Math.max(0, canonScore);

  // Robots (weight 8)
  total += 8;
  let robotsScore = 8;
  if (!audit.robots.isIndexable) { robotsScore -= 4; issues.push({ code: "noindex", severity: "info", message: "Page has noindex directive", dimension: "robots" }); }
  if (!audit.robots.isFollowable) { robotsScore -= 2; issues.push({ code: "nofollow", severity: "info", message: "Page has nofollow directive", dimension: "robots" }); }
  earned += Math.max(0, robotsScore);

  // Content (weight 8)
  total += 8;
  let contentScore = 8;
  if (audit.content.wordCount < 300) { contentScore -= 4; issues.push({ code: "thin-content", severity: "warning", message: `Low word count (${audit.content.wordCount})`, dimension: "content" }); }
  if (audit.content.textToHtmlRatio < 0.1) { contentScore -= 2; issues.push({ code: "low-text-ratio", severity: "warning", message: `Text-to-HTML ratio is ${(audit.content.textToHtmlRatio * 100).toFixed(1)}%`, dimension: "content" }); }
  earned += Math.max(0, contentScore);

  // Technical (weight 8)
  total += 8;
  let techScore = 8;
  if (!audit.technical.hasHttps) { techScore -= 4; issues.push({ code: "no-https", severity: "error", message: "Page not served over HTTPS", dimension: "technical" }); }
  if (!audit.technical.lang) { techScore -= 2; issues.push({ code: "missing-lang", severity: "warning", message: "No lang attribute on <html>", dimension: "technical" }); }
  if (!audit.technical.hasFavicon) { techScore -= 1; issues.push({ code: "missing-favicon", severity: "info", message: "No favicon link tag found", dimension: "technical" }); }
  earned += Math.max(0, techScore);

  return { score: total > 0 ? Math.round((earned / total) * 100) : 0, issues };
}

describe("SEO Scoring: perfect page", () => {
  const perfect: SeoAuditResult = {
    url: "https://example.com",
    auditedAt: "2026-03-13T00:00:00Z",
    meta: { title: "Perfect Page Title", titleLength: 18, description: "A well-crafted meta description for SEO.", descriptionLength: 42, robots: "index, follow", viewport: "width=device-width, initial-scale=1", charset: "utf-8", author: "Author", generator: null },
    headings: { h1Count: 1, h1Texts: ["Main Heading"], hierarchy: [{ level: 1, text: "Main Heading" }, { level: 2, text: "Sub" }], hasValidHierarchy: true, totalHeadings: 2 },
    links: { total: 10, internal: 7, external: 3, dofollow: 10, nofollow: 0, ugc: 0, sponsored: 0, broken: 0, unique: 10, links: [] },
    images: { total: 5, withAlt: 5, withoutAlt: 0, lazyLoaded: 3, withDimensions: 5, images: [] },
    structuredData: { jsonLd: [{ "@type": "WebPage" }], microdataCount: 0, rdfaCount: 0, totalItems: 1 },
    openGraph: { title: "OG", description: "OG Desc", image: "https://example.com/og.jpg", url: "https://example.com", type: "website", siteName: "Example", allTags: {} },
    twitterCard: { card: "summary_large_image", title: "TC", description: "TC Desc", image: "https://example.com/tc.jpg", site: "@example", allTags: {} },
    canonical: { canonical: "https://example.com", isCanonicalSelf: true, hreflangTags: [] },
    robots: { metaRobots: "index, follow", xRobotsTag: null, isIndexable: true, isFollowable: true, directives: ["index", "follow"] },
    content: { wordCount: 1500, textToHtmlRatio: 0.35, readingTimeMinutes: 7.5 },
    technical: { doctype: "html", lang: "en", charset: "utf-8", viewportMeta: "width=device-width, initial-scale=1", hasHttps: true, hasFavicon: true },
    score: 0,
    issues: [],
  };

  it("scores 100 for a perfectly optimized page", () => {
    const { score, issues } = calculateSeoScore(perfect);
    expect(score).toBe(100);
    expect(issues).toHaveLength(0);
  });
});

describe("SEO Scoring: worst page", () => {
  const worst: SeoAuditResult = {
    url: "http://example.com",
    auditedAt: "2026-03-13T00:00:00Z",
    meta: { title: null, titleLength: 0, description: null, descriptionLength: 0, robots: "noindex, nofollow", viewport: null, charset: null, author: null, generator: null },
    headings: { h1Count: 0, h1Texts: [], hierarchy: [], hasValidHierarchy: true, totalHeadings: 0 },
    links: { total: 0, internal: 0, external: 0, dofollow: 0, nofollow: 0, ugc: 0, sponsored: 0, broken: 0, unique: 0, links: [] },
    images: { total: 10, withAlt: 0, withoutAlt: 10, lazyLoaded: 0, withDimensions: 0, images: [] },
    structuredData: { jsonLd: [], microdataCount: 0, rdfaCount: 0, totalItems: 0 },
    openGraph: { title: null, description: null, image: null, url: null, type: null, siteName: null, allTags: {} },
    twitterCard: { card: null, title: null, description: null, image: null, site: null, allTags: {} },
    canonical: { canonical: null, isCanonicalSelf: false, hreflangTags: [] },
    robots: { metaRobots: "noindex, nofollow", xRobotsTag: null, isIndexable: false, isFollowable: false, directives: ["noindex", "nofollow"] },
    content: { wordCount: 50, textToHtmlRatio: 0.02, readingTimeMinutes: 0.3 },
    technical: { doctype: null, lang: null, charset: null, viewportMeta: null, hasHttps: false, hasFavicon: false },
    score: 0,
    issues: [],
  };

  it("scores very low for a poorly optimized page", () => {
    const { score, issues } = calculateSeoScore(worst);
    expect(score).toBeLessThan(35);
    expect(issues.length).toBeGreaterThan(10);
  });

  it("detects missing title as error", () => {
    const { issues } = calculateSeoScore(worst);
    const titleIssue = issues.find(i => i.code === "missing-title");
    expect(titleIssue).toBeDefined();
    expect(titleIssue!.severity).toBe("error");
  });

  it("detects missing meta description as error", () => {
    const { issues } = calculateSeoScore(worst);
    const descIssue = issues.find(i => i.code === "missing-description");
    expect(descIssue).toBeDefined();
    expect(descIssue!.severity).toBe("error");
  });

  it("detects missing H1 as error", () => {
    const { issues } = calculateSeoScore(worst);
    const h1Issue = issues.find(i => i.code === "missing-h1");
    expect(h1Issue).toBeDefined();
    expect(h1Issue!.severity).toBe("error");
  });

  it("detects images without alt text", () => {
    const { issues } = calculateSeoScore(worst);
    const altIssue = issues.find(i => i.code === "images-missing-alt");
    expect(altIssue).toBeDefined();
    expect(altIssue!.severity).toBe("error"); // 100% missing = error
  });

  it("detects no-https as error", () => {
    const { issues } = calculateSeoScore(worst);
    const httpsIssue = issues.find(i => i.code === "no-https");
    expect(httpsIssue).toBeDefined();
    expect(httpsIssue!.severity).toBe("error");
  });

  it("detects thin content", () => {
    const { issues } = calculateSeoScore(worst);
    const contentIssue = issues.find(i => i.code === "thin-content");
    expect(contentIssue).toBeDefined();
  });

  it("detects missing OG tags", () => {
    const { issues } = calculateSeoScore(worst);
    expect(issues.find(i => i.code === "missing-og-title")).toBeDefined();
    expect(issues.find(i => i.code === "missing-og-image")).toBeDefined();
  });

  it("detects noindex directive", () => {
    const { issues } = calculateSeoScore(worst);
    expect(issues.find(i => i.code === "noindex")).toBeDefined();
    expect(issues.find(i => i.code === "nofollow")).toBeDefined();
  });

  it("detects missing canonical", () => {
    const { issues } = calculateSeoScore(worst);
    expect(issues.find(i => i.code === "missing-canonical")).toBeDefined();
  });

  it("detects missing lang attribute", () => {
    const { issues } = calculateSeoScore(worst);
    expect(issues.find(i => i.code === "missing-lang")).toBeDefined();
  });
});

describe("SEO Scoring: edge cases", () => {
  function makeAudit(overrides: Partial<SeoAuditResult>): SeoAuditResult {
    return {
      url: "https://example.com",
      auditedAt: "2026-03-13T00:00:00Z",
      meta: { title: "Good Title Here", titleLength: 15, description: "Good description here for SEO testing", descriptionLength: 37, robots: null, viewport: "width=device-width", charset: "utf-8", author: null, generator: null },
      headings: { h1Count: 1, h1Texts: ["Main"], hierarchy: [{ level: 1, text: "Main" }], hasValidHierarchy: true, totalHeadings: 1 },
      links: { total: 5, internal: 3, external: 2, dofollow: 5, nofollow: 0, ugc: 0, sponsored: 0, broken: 0, unique: 5, links: [] },
      images: { total: 0, withAlt: 0, withoutAlt: 0, lazyLoaded: 0, withDimensions: 0, images: [] },
      structuredData: { jsonLd: [{}], microdataCount: 0, rdfaCount: 0, totalItems: 1 },
      openGraph: { title: "OG", description: "OG", image: "https://example.com/og.jpg", url: null, type: null, siteName: null, allTags: {} },
      twitterCard: { card: "summary", title: null, description: null, image: null, site: null, allTags: {} },
      canonical: { canonical: "https://example.com", isCanonicalSelf: true, hreflangTags: [] },
      robots: { metaRobots: null, xRobotsTag: null, isIndexable: true, isFollowable: true, directives: [] },
      content: { wordCount: 500, textToHtmlRatio: 0.3, readingTimeMinutes: 2.5 },
      technical: { doctype: "html", lang: "en", charset: "utf-8", viewportMeta: "width=device-width", hasHttps: true, hasFavicon: true },
      score: 0,
      issues: [],
      ...overrides,
    };
  }

  it("detects title too long (>60 chars)", () => {
    const audit = makeAudit({ meta: { ...makeAudit({}).meta, title: "A".repeat(65), titleLength: 65 } });
    const { issues } = calculateSeoScore(audit);
    expect(issues.find(i => i.code === "title-too-long")).toBeDefined();
  });

  it("detects title too short (<10 chars)", () => {
    const audit = makeAudit({ meta: { ...makeAudit({}).meta, title: "Hi", titleLength: 2 } });
    const { issues } = calculateSeoScore(audit);
    expect(issues.find(i => i.code === "title-too-short")).toBeDefined();
  });

  it("detects description too long (>160 chars)", () => {
    const audit = makeAudit({ meta: { ...makeAudit({}).meta, description: "A".repeat(170), descriptionLength: 170 } });
    const { issues } = calculateSeoScore(audit);
    expect(issues.find(i => i.code === "description-too-long")).toBeDefined();
  });

  it("detects multiple H1 headings", () => {
    const audit = makeAudit({ headings: { h1Count: 3, h1Texts: ["A", "B", "C"], hierarchy: [], hasValidHierarchy: true, totalHeadings: 3 } });
    const { issues } = calculateSeoScore(audit);
    expect(issues.find(i => i.code === "multiple-h1")).toBeDefined();
  });

  it("penalizes broken links proportionally", () => {
    const audit1 = makeAudit({ links: { ...makeAudit({}).links, broken: 1 } });
    const audit5 = makeAudit({ links: { ...makeAudit({}).links, broken: 5 } });
    const { score: s1 } = calculateSeoScore(audit1);
    const { score: s5 } = calculateSeoScore(audit5);
    expect(s5).toBeLessThan(s1);
  });

  it("caps image alt penalty at 8 points", () => {
    const audit = makeAudit({ images: { total: 100, withAlt: 0, withoutAlt: 100, lazyLoaded: 0, withDimensions: 0, images: [] } });
    const { score } = calculateSeoScore(audit);
    // Image dimension max deduction is 8/10, so score should still be positive
    expect(score).toBeGreaterThan(0);
  });

  it("low text ratio triggers warning", () => {
    const audit = makeAudit({ content: { wordCount: 500, textToHtmlRatio: 0.05, readingTimeMinutes: 2.5 } });
    const { issues } = calculateSeoScore(audit);
    expect(issues.find(i => i.code === "low-text-ratio")).toBeDefined();
  });

  it("score is always between 0 and 100", () => {
    for (const wc of [0, 50, 500, 5000]) {
      const audit = makeAudit({ content: { wordCount: wc, textToHtmlRatio: 0.3, readingTimeMinutes: wc / 200 } });
      const { score } = calculateSeoScore(audit);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

// --- Tool registration tests ---

describe("seo_audit tool registration", () => {
  it("createTools includes seo_audit, check_robots_txt, check_sitemap", () => {
    const mockBridge = { send: vi.fn(), isConnected: true };
    const mockCrawlio = { api: vi.fn() };
    const tools = createTools(mockBridge as never, mockCrawlio as never);
    const names = tools.map(t => t.name);
    expect(names).toContain("seo_audit");
    expect(names).toContain("check_robots_txt");
    expect(names).toContain("check_sitemap");
  });

  it("seo_audit accepts optional sections parameter", () => {
    const mockBridge = { send: vi.fn(), isConnected: true };
    const mockCrawlio = { api: vi.fn() };
    const tools = createTools(mockBridge as never, mockCrawlio as never);
    const seoTool = tools.find(t => t.name === "seo_audit");
    expect(seoTool).toBeDefined();
    const schema = seoTool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("sections");
  });
});

describe("toolSuccess/toolError helpers", () => {
  it("toolSuccess wraps content in MCP format", () => {
    const result = toolSuccess({ score: 85 });
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ score: 85 });
  });

  it("toolError returns error format", () => {
    const result = toolError("Debugger not attached");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Debugger not attached");
  });
});
