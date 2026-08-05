// Typed evidence records for Method Mode smart methods.
// Interfaces only — no runtime code.

import type { PageCapture } from "./types.js";

// --- Phase 2: Evidence Records ---

export interface AccessibilitySummary {
  nodeCount: number;
  landmarkCount: number;
  imagesWithoutAlt: number;
  headingStructure: Array<{ level: number; text: string }>;
}

export interface MobileReadiness {
  hasViewportMeta: boolean;
  viewportContent: string | null;
  mediaQueryCount: number;
  isOverflowing: boolean;
}

export interface PageEvidence {
  capture: PageCapture | Record<string, unknown>;
  performance: Record<string, unknown> | null;
  security: Record<string, unknown> | null;
  fonts: Record<string, unknown> | null;
  meta: PageMeta | null;
  accessibility: AccessibilitySummary | null;
  mobileReadiness: MobileReadiness | null;
}

export interface PageMeta {
  _title: string;
  _canonical: string | null;
  _structuredData: unknown[];
  _headings: Array<{ level: string; text: string }>;
  _nav: string[];
  [key: string]: unknown;
}

export interface ScrollSection {
  index: number;
  scrollY: number;
  screenshot: string;
}

export interface ScrollEvidence {
  sectionCount: number;
  sections: ScrollSection[];
}

export interface IdleStatus {
  status: "idle" | "timeout";
}

export interface ComparisonEvidence {
  siteA: PageEvidence & { url: string; gaps: CoverageGap[] };
  siteB: PageEvidence & { url: string; gaps: CoverageGap[] };
  scaffold: ComparisonScaffold;
}

// --- Phase 3: Findings ---

export type FindingConfidence = "high" | "medium" | "low";

/** @deprecated Use FindingConfidence instead — renamed to avoid collision with schema.ts ConfidenceLevel */
export type ConfidenceLevel = FindingConfidence;

export interface Finding {
  claim: string;
  evidence: string[];
  sourceUrl: string;
  confidence: FindingConfidence;
  method: string;
  dimension?: string;
  confidenceCapped?: boolean;
  cappedBy?: string;
}

// --- Phase 4: Coverage Gaps ---

export type GapImpact = "data-absent" | "data-stale" | "method-failed" | "timeout";

export interface CoverageGap {
  dimension: string;
  reason: string;
  impact: GapImpact;
  reducesConfidence: boolean;
}

export type ObservationType = "present" | "absent" | "degraded";

export interface Observation {
  type: ObservationType;
  dimension: string;
  value?: unknown;
  gap?: CoverageGap;
}

// --- Phase 5: Comparison Scaffolds ---

export interface DimensionSlot {
  name: string;
  siteA: Observation;
  siteB: Observation;
  comparable: boolean;
}

export interface ComparableMetric {
  name: string;
  siteA: number | null;
  siteB: number | null;
  unit?: string;
}

export interface ComparisonScaffold {
  dimensions: DimensionSlot[];
  sharedFields: string[];
  missingFields: { siteA: string[]; siteB: string[] };
  metrics: ComparableMetric[];
}

// --- Phase 6: Method Telemetry ---

export interface StepTrace {
  name: string;
  elapsed: number;
  success: boolean;
  fallback?: string;
}

export interface MethodTrace {
  method: string;
  startedAt: number;
  elapsed: number;
  steps: StepTrace[];
  outcome: "success" | "partial" | "timeout" | "error";
}

// --- Monitor Family: Diff Evidence ---

export interface DiffChange {
  dimension: string;           // One of the 10 comparison dimensions
  field: string;               // Specific field that changed
  before: unknown;
  after: unknown;
  severity: "breaking" | "warning" | "info";
  description: string;
}

export interface DiffReport {
  baselineId: string;          // evidenceId of the baseline capture
  currentId: string;           // evidenceId of the re-capture
  url: string;
  capturedAt: {
    baseline: string;          // ISO timestamp
    current: string;
  };
  changes: DiffChange[];
  summary: {
    totalChanges: number;
    breakingChanges: number;
    dimensions: string[];      // Which dimensions had changes
  };
}

// --- Phase 11: Structured Data Extraction ---

export type TableDetectStrategy = "table-rows" | "sibling-repeated-blocks";

export interface TableCandidate {
  selector: string;
  score: number;             // legacy area×rows² score, kept for back-compat
  rowCount: number;
  sampleText: string;       // first 200 chars of children text
  area: number;              // visual area of container
  confidence: number;        // 0..1 — native tables ~0.82 baseline, div-soup capped at 0.78
  strategy: TableDetectStrategy;
  warnings: string[];        // e.g. "no header row found", "row heights inconsistent"
}

export interface TableColumn {
  name: string;              // smart-named (from IDS column naming algo)
  path: string;              // XPath-like key from recursive extraction
  fillRate: number;          // 0-1, fraction of rows that have this column
}

export interface ExtractedRow {
  [column: string]: string;  // column name → cell value
}

export interface TableExtraction {
  selector: string;
  columns: TableColumn[];
  rows: ExtractedRow[];
  totalRows: number;
  truncated: boolean;        // true if rows were capped
}

export interface NetworkIdleResult {
  status: "idle" | "timeout";
  elapsed: number;           // ms waited
  pendingAtTimeout?: number; // requests still pending if timeout
}

export interface DataExtraction {
  tables: TableExtraction[];
  structuredData: unknown[];  // JSON-LD (already extracted by extractPage meta)
  url: string;
}

// --- Structured Page Perception: Section Detection ---

export interface SectionNode {
  role: string;
  source: "semantic-tag" | "aria-landmark" | "data-attr" | "class-hint";
  name: string | null;        // aria-label > data-component value > first heading text
  selector: string;
  selectorVerified: boolean;  // selector matches exactly one element, and it is this one
  box: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  interactiveCount: number;
  textLength: number;
  headings: string[];
  children: SectionNode[];
}

export interface PageSections {
  url: string;
  viewport: { width: number; height: number };
  sections: SectionNode[];
  totalDetected: number;
  truncated: boolean;
}

// --- Extract Family: Design Tokens ---

export interface ColorToken {
  name: string;
  value: string;            // hex, rgb, hsl
  usage: string | null;     // "primary", "background", "text", etc.
}

export interface TypographyToken {
  family: string;
  weight: string | null;
  size: string | null;
  usage: string | null;     // "heading", "body", "caption"
}

export interface SpacingToken {
  name: string;
  value: string;            // e.g., "8px", "1rem"
}

export interface BreakpointToken {
  name: string;
  value: string;            // e.g., "768px"
  type: "min-width" | "max-width" | "other";
}

export interface DesignTokens {
  colors: ColorToken[];
  typography: TypographyToken[];
  spacing: SpacingToken[];
  breakpoints: BreakpointToken[];
  cssCustomProperties: number;     // count of --var declarations
  signals: string[];               // how tokens were detected
}

// --- Extract Family: Auth Flow ---

export interface AuthFlow {
  loginUrl: string | null;
  authType: string | null;          // "JWT", "cookie", "OAuth2", "API key", "none"
  tokenStorage: string | null;      // "cookie", "localStorage", "sessionStorage"
  csrfProtection: boolean;
  oauthProvider: string | null;
  signals: string[];
}

// --- Compare Family: Comparison Report ---

export interface DimensionComparison {
  dimension: string;
  siteA: unknown;
  siteB: unknown;
  comparable: boolean;
  differences: string[];
  verdict: "A-better" | "B-better" | "equivalent" | "incomparable";
  confidence: FindingConfidence;
}

export interface ComparisonReport {
  urlA: string;
  urlB: string;
  dimensions: DimensionComparison[];
  summary: {
    totalDifferences: number;
    criticalDifferences: number;
    winner: "A" | "B" | "tie" | "inconclusive";
    winnerReason: string | null;
  };
  evidenceChain: string[];
}

// --- Clone Family: CloneBlueprint ---

export type ComponentType = "layout" | "navigation" | "content" | "interactive" | "decorative";

export type AssetType = "image" | "font" | "script" | "stylesheet" | "video";

export interface CloneComponent {
  name: string;
  type: ComponentType;
  children: (string | CloneComponent)[];
  props: Record<string, unknown>;
}

export interface CloneAsset {
  url: string;
  type: AssetType;
  size: number | null;
}

export interface CloneBlueprint {
  url: string;
  designTokens: {
    colors: ColorToken[];
    typography: TypographyToken[];
    spacing: SpacingToken[];
    breakpoints: Array<{ name: string; value: string }>;
  };
  componentTree: {
    root: string;
    components: CloneComponent[];
  };
  assets: CloneAsset[];
  compiledSkillPath: string | null;
}

// --- Test Family: TestSuite ---

export interface TestAudit {
  category: "accessibility" | "performance" | "security" | "seo" | "best-practices";
  name: string;
  status: "pass" | "fail" | "warning" | "skip";
  score: number | null;   // 0-100 per audit
  details: string;
  recommendation: string | null;
  evidence: string[];     // Supporting evidence IDs
}

export interface TestFlow {
  name: string;
  steps: string[];        // Human-readable step descriptions
  status: "discovered" | "tested" | "failed";
  url: string;
  method: string;         // How the flow was discovered
}

export interface TestSuite {
  url: string;
  audits: TestAudit[];
  flows: TestFlow[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    warnings: number;
    score: number;        // 0-100 overall score
  };
}

// --- Phase 2: Intelligence Runtime Agent Types ---

export interface FrameworkEvidence {
  framework: {
    name: string;
    version: string | null;
    confidence: FindingConfidence;
    signals: string[];
  } | null;
  rendering: {
    mode: "SSR" | "CSR" | "SSG" | "ISR" | "hybrid" | "unknown";
    signals: string[];
  };
  components: {
    count: number | null;
    patterns: string[];
  };
  stateManagement: {
    library: string | null;
    signals: string[];
  };
  routing: {
    type: string | null;
    signals: string[];
  };
  bundler: {
    name: string | null;
    signals: string[];
  };
}

export interface APIMap {
  endpoints: Array<{
    url: string;
    method: string;
    contentType: string | null;
    purpose: string;
    confidence: FindingConfidence;
  }>;
  authentication: {
    type: string | null;
    signals: string[];
    loginEndpoint: string | null;
    tokenStorage: string | null;
  };
  thirdParty: Array<{
    name: string;
    domain: string;
    purpose: string;
    confidence: FindingConfidence;
  }>;
  rateLimiting: {
    detected: boolean;
    signals: string[];
  };
  cors: {
    allowedOrigins: string[] | null;
    signals: string[];
  };
}

export interface TechBlueprint {
  summary: string;
  framework: {
    name: string | null;
    version: string | null;
    rendering: string;
  };
  apiSurface: {
    endpointCount: number;
    authType: string | null;
    hasGraphQL: boolean;
  };
  designSystem: {
    fonts: string[];
    hasCustomProperties: boolean;
    componentLibrary: string | null;
  };
  performance: {
    lcp: number | null;
    fcp: number | null;
    cls: number | null;
    ttfb: number | null;
  };
  security: {
    https: boolean;
    csp: boolean;
    hsts: boolean;
    securityHeaders: string[];
  };
  thirdParty: Array<{
    name: string;
    purpose: string;
  }>;
  findings: Finding[];
  gaps: CoverageGap[];
  evidenceChain: string[];
}

// --- Investigate Family: Traffic Analysis ---

export interface TrafficEndpoint {
  url: string;
  method: string;
  contentType: string | null;
  purpose: string;
  confidence: FindingConfidence;
}

export interface TrafficService {
  name: string;
  domain: string;
  purpose: string;
  confidence: FindingConfidence;
}

export interface TrafficTrace {
  traceId: string;
  spans: number;
  duration: number | null;
  service: string;
}

export interface TrafficSession {
  sessionId: string;
  pageCount: number;
  duration: number | null;
  entryUrl: string;
}

export interface TrafficAnalysis {
  endpoints: TrafficEndpoint[];
  services: TrafficService[];
  traces: TrafficTrace[];
  sessions: TrafficSession[];
  flowCount: number;
  duration: number;
}

// --- Compose Family: CompetitiveDossier ---

export interface DossierRecommendation {
  priority: "critical" | "high" | "medium" | "low";
  category: string;
  action: string;
  evidence: string[];
}

export interface CompetitiveDossier {
  url: string;
  generatedAt: string;
  sections: {
    techBlueprint: string | null;
    testResults: string | null;
    extractedData: string[];
    comparisons: string[];
  };
  executiveSummary: string;
  strengths: Finding[];
  weaknesses: Finding[];
  opportunities: Finding[];
  recommendations: DossierRecommendation[];
  evidenceChain: string[];
  familiesExecuted: string[];
}

// --- Snapshot Diffing ---

export interface SnapshotDiffResult {
  diff: string;
  additions: number;
  removals: number;
  unchanged: number;
  changed: boolean;
}

// --- Detection Wedge: Tracking Pixel Parser ---

export type TrackingVendor = 'facebook' | 'ga4' | 'tiktok' | 'linkedin' | 'pinterest' | 'unknown';

// --- Detection Wedge: Tracking Event Validation ---

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface TrackingValidationIssue {
  vendor: TrackingVendor;
  pixelId: string;
  eventName: string;
  severity: ValidationSeverity;
  code: string;
  message: string;
  recommendation: string;
  parameter?: string;
}

export interface TrackingValidationResult {
  events: TrackingPixelEvent[];
  issues: TrackingValidationIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  isHealthy: boolean;
}

export interface TrackingPixelEvent {
  vendor: TrackingVendor;
  pixelId: string;
  eventName: string;
  eventType: 'standard' | 'custom';
  parameters: Record<string, string>;
  url: string;
  method: string;
  timestamp: number;
  status?: number;
  /** Original NetworkEntry URL for cross-reference */
  requestUrl: string;
}

export interface TrackingPixelSummary {
  vendor: TrackingVendor;
  pixelId: string;
  eventCount: number;
  events: TrackingPixelEvent[];
  uniqueEventNames: string[];
}

export interface TrackingParseResult {
  totalPixelFires: number;
  vendors: TrackingVendor[];
  pixels: TrackingPixelSummary[];
  events: TrackingPixelEvent[];
  unrecognizedTrackingUrls: string[];
}

// --- Detection Wedge: DataLayer Inspection ---

export interface DataLayerState {
  facebook: { loaded: boolean; version: string | null; pixelIds: string[]; queueLength: number } | null;
  ga4: { dataLayerLength: number; events: string[]; gtag: boolean; gaLegacy: boolean } | null;
  gtm: { containers: string[] } | null;
  tiktok: { loaded: boolean; queueLength: number } | null;
}

// --- Detection Wedge: Duplicate Event Cluster ---

export interface DuplicateCluster {
  vendor: TrackingVendor;
  pixelId: string;
  eventName: string;
  url: string;
  count: number;
  timestamps: number[];
}

// --- Detection Wedge: Technology Relationship Graph ---

export interface TechRelationship {
  name: string;
  confidence: number;  // confidence modifier (default 100 = full propagation)
}

// --- Detection Wedge: Technographic Fingerprint Import ---

export interface TechnologyFingerprint {
  name: string;
  cats: number[];
  website?: string;
  icon?: string;
  cpe?: string;
  pricing?: string[];
  /** Signal patterns, keyed by the kind of evidence they match against */
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  js?: Record<string, string>;
  meta?: Record<string, string>;
  scriptSrc?: string | string[];
  html?: string | string[];
  css?: string | string[];
  url?: string;
  /** Relationship graph — populated but resolved in Phase 5 */
  implies?: string | string[];
  excludes?: string | string[];
}

export interface TechnologyCategory {
  id: number;
  name: string;
  slug: string;
}

/** Top ~30 technology categories used to group detections. */
export const TECHNOLOGY_CATEGORIES: Record<number, TechnologyCategory> = {
  1: { id: 1, name: "CMS", slug: "cms" },
  2: { id: 2, name: "Message boards", slug: "message-boards" },
  5: { id: 5, name: "Widgets", slug: "widgets" },
  6: { id: 6, name: "Ecommerce", slug: "ecommerce" },
  10: { id: 10, name: "Analytics", slug: "analytics" },
  12: { id: 12, name: "JavaScript frameworks", slug: "javascript-frameworks" },
  13: { id: 13, name: "Issue trackers", slug: "issue-trackers" },
  14: { id: 14, name: "Video players", slug: "video-players" },
  17: { id: 17, name: "Font scripts", slug: "font-scripts" },
  18: { id: 18, name: "Web frameworks", slug: "web-frameworks" },
  22: { id: 22, name: "Web servers", slug: "web-servers" },
  23: { id: 23, name: "Caching", slug: "caching" },
  25: { id: 25, name: "JavaScript libraries", slug: "javascript-libraries" },
  27: { id: 27, name: "Programming languages", slug: "programming-languages" },
  31: { id: 31, name: "CDN", slug: "cdn" },
  32: { id: 32, name: "Marketing automation", slug: "marketing-automation" },
  36: { id: 36, name: "Advertising", slug: "advertising" },
  41: { id: 41, name: "Payment processors", slug: "payment-processors" },
  42: { id: 42, name: "Tag managers", slug: "tag-managers" },
  47: { id: 47, name: "Live chat", slug: "live-chat" },
  54: { id: 54, name: "User onboarding", slug: "user-onboarding" },
  65: { id: 65, name: "A/B testing", slug: "ab-testing" },
  77: { id: 77, name: "Email", slug: "email" },
  57: { id: 57, name: "Cookie compliance", slug: "cookie-compliance" },
  59: { id: 59, name: "UI frameworks", slug: "ui-frameworks" },
  62: { id: 62, name: "Reverse proxy", slug: "reverse-proxy" },
  66: { id: 66, name: "Hosting", slug: "hosting" },
  84: { id: 84, name: "Page builders", slug: "page-builders" },
  76: { id: 76, name: "Consent management", slug: "consent-management" },
  87: { id: 87, name: "CSS frameworks", slug: "css-frameworks" },
};

export interface TechDetection {
  name: string;
  /** Numeric 0-100 confidence — additive from multiple signals, capped at 100 */
  confidence: number;
  version: string;
  categories: TechnologyCategory[];
  website?: string;
  icon?: string;
  /** Which signals contributed to this detection (for transparency) */
  matchedSignals: string[];
}

export interface TechnographicResult {
  technologies: TechDetection[];
  categories: Record<string, TechDetection[]>;
  totalDetected: number;
  /** Only technologies at confidence >= threshold (default 50) */
  highConfidenceCount: number;
  signalsUsed: string[];
}

export interface CapturedSignals {
  headers?: Record<string, string[]>;
  cookies?: Record<string, string[]>;
  js?: Record<string, string>;
  meta?: Record<string, string[]>;
  scriptSrc?: string[];
  html?: string;
  css?: string;
  url?: string;
}
