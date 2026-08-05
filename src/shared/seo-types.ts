// On-page SEO audit type definitions.
// Interfaces only — no runtime code.

export interface MetaTagAudit {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  robots: string | null;
  viewport: string | null;
  charset: string | null;
  author: string | null;
  generator: string | null;
}

export interface HeadingEntry {
  level: number;
  text: string;
}

export interface HeadingAudit {
  h1Count: number;
  h1Texts: string[];
  hierarchy: HeadingEntry[];
  hasValidHierarchy: boolean;
  totalHeadings: number;
}

export interface LinkEntry {
  href: string;
  text: string;
  rel: string;
  isExternal: boolean;
  isNofollow: boolean;
}

export interface LinkAudit {
  total: number;
  internal: number;
  external: number;
  dofollow: number;
  nofollow: number;
  ugc: number;
  sponsored: number;
  broken: number;
  unique: number;
  links: LinkEntry[];
}

export interface ImageEntry {
  src: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  loading: string | null;
}

export interface ImageAudit {
  total: number;
  withAlt: number;
  withoutAlt: number;
  lazyLoaded: number;
  withDimensions: number;
  images: ImageEntry[];
}

export interface StructuredDataAudit {
  jsonLd: unknown[];
  microdataCount: number;
  rdfaCount: number;
  totalItems: number;
}

export interface OpenGraphAudit {
  title: string | null;
  description: string | null;
  image: string | null;
  url: string | null;
  type: string | null;
  siteName: string | null;
  allTags: Record<string, string>;
}

export interface TwitterCardAudit {
  card: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
  allTags: Record<string, string>;
}

export interface HreflangEntry {
  lang: string;
  href: string;
}

export interface CanonicalAudit {
  canonical: string | null;
  isCanonicalSelf: boolean;
  hreflangTags: HreflangEntry[];
}

export interface RobotsAudit {
  metaRobots: string | null;
  xRobotsTag: string | null;
  isIndexable: boolean;
  isFollowable: boolean;
  directives: string[];
}

export interface ContentMetrics {
  wordCount: number;
  textToHtmlRatio: number;
  readingTimeMinutes: number;
}

export interface TechnicalAudit {
  doctype: string | null;
  lang: string | null;
  charset: string | null;
  viewportMeta: string | null;
  hasHttps: boolean;
  hasFavicon: boolean;
}

export type SeoSeverity = "error" | "warning" | "info";

export interface SeoIssue {
  code: string;
  severity: SeoSeverity;
  message: string;
  dimension: string;
}

export interface SeoAuditResult {
  url: string;
  auditedAt: string;
  meta: MetaTagAudit;
  headings: HeadingAudit;
  links: LinkAudit;
  images: ImageAudit;
  structuredData: StructuredDataAudit;
  openGraph: OpenGraphAudit;
  twitterCard: TwitterCardAudit;
  canonical: CanonicalAudit;
  robots: RobotsAudit;
  content: ContentMetrics;
  technical: TechnicalAudit;
  score: number;
  issues: SeoIssue[];
}

export interface RobotsTxtResult {
  url: string;
  found: boolean;
  content: string | null;
  sitemapUrls: string[];
  disallowedPaths: string[];
  crawlDelay: number | null;
}

export interface SitemapResult {
  url: string;
  found: boolean;
  urlCount: number;
  sampleUrls: string[];
  lastmod: string | null;
}

// --- Phase 5: Raw vs Rendered Comparison ---

export interface SeoElements {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  headings: Array<{ level: number; text: string }>;
  linkCount: number;
  structuredData: unknown[];
  contentLength: number;
  textLength: number;
}

export interface RawRenderedDiff {
  element: string;
  raw: unknown;
  rendered: unknown;
  impact: "high" | "medium" | "low";
  description: string;
}

export interface RawRenderedComparison {
  url: string;
  raw: { html: string; seoElements: SeoElements; size: number };
  rendered: { html: string; seoElements: SeoElements; size: number };
  differences: RawRenderedDiff[];
  jsDependent: boolean;
  riskLevel: "low" | "medium" | "high";
}

// --- Phase 5: CrUX Metrics ---

export interface CruxMetricEntry {
  p75: number;
  assessment: "good" | "needs-improvement" | "poor";
  histogram: number[];
}

export interface CruxMetrics {
  available: boolean;
  url: string;
  origin?: string;
  formFactor?: string;
  reason?: string;
  metrics: {
    lcp?: CruxMetricEntry;
    cls?: CruxMetricEntry;
    inp?: CruxMetricEntry;
    ttfb?: CruxMetricEntry;
  };
  collectionPeriod?: { firstDate: string; lastDate: string };
}
