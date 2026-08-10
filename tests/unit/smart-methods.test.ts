import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSmartObject, createCodeModeTools, createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";
import { CrawlioClient } from "@/mcp-server/crawlio-client";
import type { PageEvidence, ScrollEvidence, IdleStatus, ComparisonEvidence, Finding, CoverageGap, TableCandidate, TableExtraction, NetworkIdleResult, DataExtraction, PageSections } from "@/shared/evidence-types";
// --- Extraction program helpers ---
// Generated extraction programs start with a stable sentinel comment and end with a
// single trailing JSON argument list: `/*crawlio:detect-tables*/(function(opts){...})({"maxCandidates":5})`.
// Mocks key off the sentinel and parse the trailing literal instead of pattern-matching the body.

function extractionArgs(expr: string): unknown[] {
  const start = expr.lastIndexOf("})(");
  const end = expr.lastIndexOf(")");
  if (start < 0 || end <= start + 2) return [];
  return JSON.parse(`[${expr.slice(start + 3, end)}]`);
}

const MOCK_TABLE_CANDIDATES: TableCandidate[] = [
  { selector: "table.data", score: 800000, rowCount: 12, sampleText: "Name Price Widget A $10 Widget B $20", area: 60000, confidence: 0.826, strategy: "table-rows", warnings: [] },
  { selector: "div.product-grid", score: 500000, rowCount: 10, sampleText: "Product 1 Widget A Product 2 Widget B", area: 50000, confidence: 0.75, strategy: "sibling-repeated-blocks", warnings: [] },
  { selector: "ul.results", score: 200000, rowCount: 5, sampleText: "Result 1 Result 2", area: 30000, confidence: 0.675, strategy: "sibling-repeated-blocks", warnings: ["row heights inconsistent"] },
];

const MOCK_PAGE_SECTIONS: PageSections = {
  url: "https://test.com",
  viewport: { width: 1280, height: 800 },
  sections: [
    {
      role: "navigation", source: "aria-landmark", name: "Main nav",
      selector: "nav.top", selectorVerified: true,
      box: { x: 0, y: 0, width: 1280, height: 64 },
      inViewport: true, interactiveCount: 8, textLength: 120, headings: [],
      children: [],
    },
    {
      role: "main", source: "semantic-tag", name: "Products",
      selector: "main#content", selectorVerified: true,
      box: { x: 0, y: 64, width: 1280, height: 2000 },
      inViewport: true, interactiveCount: 24, textLength: 5400, headings: ["Products"],
      children: [
        {
          role: "ProductCard", source: "class-hint", name: "Widget A",
          selector: "main#content div.ProductCard", selectorVerified: false,
          box: { x: 20, y: 120, width: 300, height: 400 },
          inViewport: true, interactiveCount: 2, textLength: 240, headings: ["Widget A"],
          children: [],
        },
      ],
    },
  ],
  totalDetected: 3,
  truncated: false,
};

// --- Bridge mock with configurable scroll state ---

function createSmartBridge(opts?: {
  scrollHeight?: number;
  viewportHeight?: number;
  stuckAtScroll?: number;
}) {
  const scrollHeight = opts?.scrollHeight ?? 3000;
  const viewportHeight = opts?.viewportHeight ?? 800;
  const stuckAt = opts?.stuckAtScroll ?? -1;
  let currentScrollY = 0;

  const sendSpy = vi.fn(async (msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "get_connection_status":
        return { connectedTab: { url: "" } };
      case "detect_framework":
        return { detections: [] };
      case "browser_evaluate": {
        const expr = String(msg.expression || "");
        // detectTables — sentinel + trailing JSON options
        if (expr.startsWith("/*crawlio:detect-tables*/")) {
          const [opts] = extractionArgs(expr) as [{ maxCandidates?: number }];
          const max = opts?.maxCandidates ?? 5;
          return { result: MOCK_TABLE_CANDIDATES.slice(0, max), type: "object" };
        }
        // extractTable — sentinel + (selector, options) trailing args
        if (expr.startsWith("/*crawlio:extract-table*/")) {
          const [selector] = extractionArgs(expr) as [string, { maxRows?: number }];
          return { result: {
            selector: selector ?? "div.unknown",
            columns: [
              { name: "title", path: "/h3.title", fillRate: 1.0 },
              { name: "price", path: "/span.price", fillRate: 0.9 },
            ],
            rows: [
              { title: "Product 1", price: "$19.99" },
              { title: "Product 2", price: "$29.99" },
            ],
            totalRows: 2,
            truncated: false,
          }, type: "object" };
        }
        // detectSections — sentinel + trailing JSON options
        if (expr.startsWith("/*crawlio:detect-sections*/")) {
          return { result: MOCK_PAGE_SECTIONS, type: "object" };
        }
        // scrollCapture position query
        if (expr.includes("scrollY") && expr.includes("scrollHeight") && expr.includes("viewportHeight")) {
          return { result: { scrollY: currentScrollY, scrollHeight, viewportHeight }, type: "object" };
        }
        // scrollCapture post-scroll position check
        if (expr.trim() === "window.scrollY") {
          return { result: currentScrollY, type: "number" };
        }
        // scrollCapture scroll-to-top
        if (expr.includes("window.scrollTo(0, 0)")) {
          currentScrollY = 0;
          return { result: undefined, type: "undefined" };
        }
        // waitForIdle — return 'idle'
        if (expr.includes("MutationObserver")) {
          return { result: "idle", type: "string" };
        }
        // extractPage meta extraction
        if (expr.includes("querySelectorAll('meta')")) {
          return { result: { _title: "Test Page", _canonical: null, _structuredData: [], _headings: [], _nav: [] }, type: "object" };
        }
        // mobile readiness extraction
        if (expr.includes("meta[name=\"viewport\"]") && expr.includes("mediaQueryCount")) {
          return { result: { hasViewportMeta: true, viewportContent: "width=device-width, initial-scale=1", mediaQueryCount: 3, bodyScrollWidth: 1024, windowInnerWidth: 1024, isOverflowing: false }, type: "object" };
        }
        // JSON-LD extraction for extractData
        if (expr.includes("application/ld+json")) {
          return { result: [{ "@type": "Product", name: "Test" }], type: "object" };
        }
        return { result: "evaluated", type: "string" };
      }
      case "take_screenshot":
        return { screenshot: "base64data" };
      case "browser_scroll": {
        const px = Number(msg.pixels) || 800;
        if (stuckAt >= 0 && currentScrollY >= stuckAt) {
          // Simulate stuck — don't move
        } else {
          currentScrollY = Math.min(currentScrollY + px, scrollHeight - viewportHeight);
        }
        return { ok: true };
      }
      case "capture_page":
        return { url: "https://test.com", title: "Test", framework: null, network: { total: 5 }, console: { total: 2 }, cookies: { total: 1 }, dom: { nodeCount: 100 } };
      case "get_performance_metrics":
        return { metrics: { LCP: 1200, FCP: 800 } };
      case "get_security_state":
        return { securityState: "secure", protocol: "TLS 1.3" };
      case "detect_fonts":
        return { fonts: ["Arial", "Roboto"] };
      case "get_accessibility_tree":
        return { tree: [
          { role: "banner", name: "header", children: [] },
          { role: "main", name: "content", children: [
            { role: "heading", name: "Test Heading", level: 1, children: [] },
            { role: "img", name: "", children: [] },
            { role: "img", name: "Logo", children: [] },
          ] },
          { role: "navigation", name: "nav", children: [] },
        ], nodeCount: 6 };
      case "browser_navigate":
        currentScrollY = 0;
        return { ok: true };
      case "browser_hover":
        return { ok: true };
      case "wait_for_network_idle": {
        const t = Number(msg.timeout) || 15000;
        // Simulate idle result by default; timeout if timeout=1
        if (t <= 100) {
          return { status: "timeout", elapsed: t, pendingAtTimeout: 2 };
        }
        return { status: "idle", elapsed: 350 };
      }
      default:
        return { ok: true };
    }
  });

  return {
    send: sendSpy,
    isConnected: true,
    push: vi.fn(),
    resetScroll: () => { currentScrollY = 0; },
  };
}

function getExecuteTool(bridge: ReturnType<typeof createSmartBridge>) {
  const crawlio = new CrawlioClient("http://localhost:0");
  const tools = createCodeModeTools(bridge as never, crawlio);
  const execute = tools.find((t) => t.name === "execute");
  if (!execute) throw new Error("execute tool not found");
  return execute;
}

function parseResult(result: { isError?: boolean; content: Array<{ text: string }> }) {
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0].text);
}

describe("smart interaction command budgets", () => {
  it("covers the complete stop-old-capture and start-new-capture connection lifecycle", () => {
    expect(TOOL_TIMEOUTS.connect_tab).toBe(60000);
    expect(TOOL_TIMEOUTS.agent_session_create).toBe(60000);
    expect(TOOL_TIMEOUTS.agent_session_create_tab).toBe(60000);
  });

  it("uses full lifecycle timeouts for clicks and navigation", async () => {
    const bridge = createSmartBridge();
    bridge.send.mockImplementation(async (message: Record<string, unknown>) => {
      if (message.type === "browser_evaluate") {
        return { result: { actionable: true }, type: "object" };
      }
      return { ok: true };
    });
    const smart = await buildSmartObject(bridge as never) as {
      click: (selector: string, opts?: { settle?: number }) => Promise<unknown>;
      navigate: (url: string, opts?: { settle?: number }) => Promise<unknown>;
    };

    await smart.click("#submit", { settle: 0 });
    await smart.click("[ref=e3]", { settle: 0 });
    await smart.navigate("https://example.test", { settle: 0 });

    const clickCalls = bridge.send.mock.calls.filter(
      (call: [Record<string, unknown>, number?]) => call[0].type === "browser_click",
    );
    expect(clickCalls).toHaveLength(2);
    expect(clickCalls.map((call: [Record<string, unknown>, number?]) => call[1])).toEqual([15000, 15000]);
    const navigateCall = bridge.send.mock.calls.find(
      (call: [Record<string, unknown>, number?]) => call[0].type === "browser_navigate",
    );
    expect(navigateCall?.[1]).toBe(40000);
  });
});

// ============================================================
// scrollCapture
// ============================================================

describe("smart.scrollCapture", () => {
  let bridge: ReturnType<typeof createSmartBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createSmartBridge({ scrollHeight: 3000, viewportHeight: 800 });
    execute = getExecuteTool(bridge);
  });

  it("stops at page bottom", async () => {
    const result = await execute.handler({ code: "return await smart.scrollCapture()" });
    const data = parseResult(result);
    expect(data.sectionCount).toBeGreaterThanOrEqual(1);
    // Should not exceed what's needed to reach the bottom
    const maxNeeded = Math.ceil(3000 / 800) + 1;
    expect(data.sectionCount).toBeLessThanOrEqual(maxNeeded);
  });

  it("respects maxSections cap", async () => {
    const result = await execute.handler({
      code: "return await smart.scrollCapture({ maxSections: 2 })",
    });
    const data = parseResult(result);
    expect(data.sectionCount).toBeLessThanOrEqual(2);
  });

  it("returns sections with scroll positions and screenshots", async () => {
    const result = await execute.handler({
      code: "return await smart.scrollCapture({ maxSections: 2 })",
    });
    const data = parseResult(result);
    expect(data.sections.length).toBe(data.sectionCount);
    for (const section of data.sections) {
      expect(section).toHaveProperty("index");
      expect(section).toHaveProperty("scrollY");
      expect(section).toHaveProperty("screenshot");
      expect(typeof section.scrollY).toBe("number");
    }
  });

  it("detects stuck scroll (page shorter than expected)", async () => {
    bridge = createSmartBridge({ scrollHeight: 3000, viewportHeight: 800, stuckAtScroll: 0 });
    execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: "return await smart.scrollCapture({ maxSections: 5 })",
    });
    const data = parseResult(result);
    // Should stop after detecting stuck (first section at 0, scroll doesn't move)
    expect(data.sectionCount).toBeLessThanOrEqual(2);
  });

  it("returns 1 section for short page", async () => {
    bridge = createSmartBridge({ scrollHeight: 600, viewportHeight: 800 });
    execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: "return await smart.scrollCapture()",
    });
    const data = parseResult(result);
    expect(data.sectionCount).toBe(1);
  });
});

// ============================================================
// waitForIdle
// ============================================================

describe("smart.waitForIdle", () => {
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    const bridge = createSmartBridge();
    execute = getExecuteTool(bridge);
  });

  it("returns idle status", async () => {
    const result = await execute.handler({
      code: "return await smart.waitForIdle()",
    });
    const data = parseResult(result);
    expect(data.status).toBe("idle");
  });

  it("accepts custom timeout", async () => {
    const result = await execute.handler({
      code: "return await smart.waitForIdle(3000)",
    });
    const data = parseResult(result);
    expect(data.status).toBe("idle");
  });

  it("caps timeout at 15000ms", async () => {
    // The method caps at 15000 internally — should not throw
    const result = await execute.handler({
      code: "return await smart.waitForIdle(99999)",
    });
    const data = parseResult(result);
    expect(data).toHaveProperty("status");
  });
});

// ============================================================
// extractPage
// ============================================================

describe("smart.extractPage", () => {
  let bridge: ReturnType<typeof createSmartBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createSmartBridge();
    execute = getExecuteTool(bridge);
  });

  it("returns capture, performance, security, fonts, meta, accessibility, and mobileReadiness", async () => {
    const result = await execute.handler({
      code: "return await smart.extractPage()",
    });
    const data = parseResult(result);
    expect(data).toHaveProperty("capture");
    expect(data).toHaveProperty("performance");
    expect(data).toHaveProperty("security");
    expect(data).toHaveProperty("fonts");
    expect(data).toHaveProperty("meta");
    expect(data).toHaveProperty("accessibility");
    expect(data).toHaveProperty("mobileReadiness");
  });

  it("capture contains shaped capture_page output", async () => {
    const result = await execute.handler({
      code: "return await smart.extractPage()",
    });
    const data = parseResult(result);
    expect(data.capture).toHaveProperty("url");
    expect(data.capture).toHaveProperty("title");
    expect(data.capture).toHaveProperty("network");
    expect(data.capture).toHaveProperty("console");
    expect(data.capture).toHaveProperty("dom");
  });

  it("normalizes the extension's raw PageCapture before Method Mode consumes it", async () => {
    const fallback = bridge.send.getMockImplementation();
    bridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      if (msg.type !== "capture_page") return fallback?.(msg);
      return {
        url: "https://test.com/raw",
        title: "Raw capture",
        capturedAt: "2026-08-07T00:00:00.000Z",
        networkRequests: [
          { requestId: "1", url: "https://test.com/api", method: "GET", status: 200, resourceType: "XHR", durationMs: 10 },
        ],
        consoleLogs: [{ level: "warning", text: "warning", timestamp: "2026-08-07T00:00:00.000Z" }],
        cookies: [{ name: "sid", value: "redacted", domain: "test.com", path: "/", secure: true, httpOnly: true }],
        domSnapshot: { tag: "html", attrs: {}, children: [{ tag: "body", attrs: {}, children: [] }] },
      };
    });

    const result = await execute.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result);
    expect(data.capture.network).toMatchObject({ total: 1, failed: 0 });
    expect(data.capture.console).toMatchObject({ total: 1, warnings: 1 });
    expect(data.capture.cookies).toEqual({ total: 1, names: ["sid"] });
    expect(data.capture.dom.nodeCount).toBe(2);
    expect(data.capture.networkRequests).toBeUndefined();
    expect(data.capture.consoleLogs).toBeUndefined();
    expect(data.capture.domSnapshot).toBeUndefined();
  });

  it("calls capture_page, get_performance_metrics, get_security_state, detect_fonts, get_accessibility_tree in parallel", async () => {
    await execute.handler({ code: "return await smart.extractPage()" });
    const types = bridge.send.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(types).toContain("capture_page");
    expect(types).toContain("get_performance_metrics");
    expect(types).toContain("get_security_state");
    expect(types).toContain("detect_fonts");
    expect(types).toContain("get_accessibility_tree");
  });

  it("handles supplementary failures gracefully (catch → null)", async () => {
    // Override bridge to fail on perf/security/fonts/accessibility
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": throw new Error("perf unavailable");
        case "get_security_state": throw new Error("security unavailable");
        case "detect_fonts": throw new Error("fonts unavailable");
        case "get_accessibility_tree": throw new Error("a11y unavailable");
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]") && expr.includes("mediaQueryCount")) {
            return { result: { hasViewportMeta: false, viewportContent: null, mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          }
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    const result = await exec.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result);
    expect(data.capture).toBeTruthy();
    expect(data.performance).toBeNull();
    expect(data.security).toBeNull();
    expect(data.fonts).toBeNull();
    expect(data.accessibility).toBeNull();
    expect(data.meta).toBeTruthy(); // meta comes from evaluate, which succeeded
    expect(data.mobileReadiness).toBeTruthy(); // mobile comes from evaluate, which succeeded
  });

  it("meta includes headings and structured data", async () => {
    const result = await execute.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result);
    expect(data.meta).toHaveProperty("_title");
    expect(data.meta).toHaveProperty("_headings");
    expect(data.meta).toHaveProperty("_structuredData");
    expect(data.meta).toHaveProperty("_nav");
  });
});

// ============================================================
// comparePages
// ============================================================

describe("smart.comparePages", () => {
  let bridge: ReturnType<typeof createSmartBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createSmartBridge();
    execute = getExecuteTool(bridge);
  });

  it("returns siteA and siteB with urls", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result);
    expect(data.siteA.url).toBe("https://a.com");
    expect(data.siteB.url).toBe("https://b.com");
  });

  it("both sites have extractPage data", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result);
    expect(data.siteA).toHaveProperty("capture");
    expect(data.siteA).toHaveProperty("performance");
    expect(data.siteB).toHaveProperty("capture");
    expect(data.siteB).toHaveProperty("meta");
  });

  it("navigates to both URLs", async () => {
    await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const navCalls = bridge.send.mock.calls.filter(
      (c: unknown[]) => (c[0] as { type: string }).type === "browser_navigate"
    );
    const urls = navCalls.map((c: unknown[]) => (c[0] as { url: string }).url);
    expect(urls).toContain("https://a.com");
    expect(urls).toContain("https://b.com");
  });
});

// ============================================================
// smart object key count (updated)
// ============================================================

describe("smart object includes new methods", () => {
  it("has scrollCapture, waitForIdle, extractPage, comparePages, finding, findings, clearFindings", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return Object.keys(smart).sort()" });
    const keys = parseResult(result);
    expect(keys).toContain("scrollCapture");
    expect(keys).toContain("waitForIdle");
    expect(keys).toContain("extractPage");
    expect(keys).toContain("comparePages");
    expect(keys).toContain("finding");
    expect(keys).toContain("findings");
    expect(keys).toContain("clearFindings");
    // 7 core + 7 higher-order = 14 minimum
    expect(keys.length).toBeGreaterThanOrEqual(14);
  });
});

// ============================================================
// Phase 2: Typed Evidence Records
// ============================================================

describe("typed evidence records", () => {
  let bridge: ReturnType<typeof createSmartBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createSmartBridge();
    execute = getExecuteTool(bridge);
  });

  it("scrollCapture returns ScrollEvidence shape", async () => {
    const result = await execute.handler({ code: "return await smart.scrollCapture({ maxSections: 2 })" });
    const data = parseResult(result) as ScrollEvidence;
    expect(data).toHaveProperty("sectionCount");
    expect(data).toHaveProperty("sections");
    expect(typeof data.sectionCount).toBe("number");
    expect(Array.isArray(data.sections)).toBe(true);
    for (const s of data.sections) {
      expect(typeof s.index).toBe("number");
      expect(typeof s.scrollY).toBe("number");
      expect(typeof s.screenshot).toBe("string");
    }
  });

  it("waitForIdle returns IdleStatus shape", async () => {
    const result = await execute.handler({ code: "return await smart.waitForIdle()" });
    const data = parseResult(result) as IdleStatus;
    expect(["idle", "timeout"]).toContain(data.status);
  });

  it("extractPage returns PageEvidence shape with gaps", async () => {
    const result = await execute.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };
    expect(data).toHaveProperty("capture");
    expect(data).toHaveProperty("performance");
    expect(data).toHaveProperty("security");
    expect(data).toHaveProperty("fonts");
    expect(data).toHaveProperty("meta");
    expect(data).toHaveProperty("accessibility");
    expect(data).toHaveProperty("mobileReadiness");
    expect(data).toHaveProperty("gaps");
    expect(Array.isArray(data.gaps)).toBe(true);
  });

  it("comparePages returns ComparisonEvidence shape with scaffold", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    expect(data).toHaveProperty("siteA");
    expect(data).toHaveProperty("siteB");
    expect(data).toHaveProperty("scaffold");
    expect(data.siteA).toHaveProperty("url");
    expect(data.siteB).toHaveProperty("url");
    expect(data.scaffold).toHaveProperty("dimensions");
    expect(data.scaffold).toHaveProperty("sharedFields");
    expect(data.scaffold).toHaveProperty("missingFields");
    expect(data.scaffold).toHaveProperty("metrics");
  });
});

// ============================================================
// Phase 3: Tool-Enforced Findings
// ============================================================

describe("smart.finding()", () => {
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    const bridge = createSmartBridge();
    execute = getExecuteTool(bridge);
  });

  it("creates a valid Finding", async () => {
    const result = await execute.handler({
      code: `return smart.finding({
        claim: "Site A loads 2x faster than Site B",
        evidence: ["LCP: 800ms vs 1600ms"],
        sourceUrl: "https://example.com",
        confidence: "high",
        method: "extractPage + compare",
      })`,
    });
    const finding = parseResult(result) as Finding;
    expect(finding.claim).toBe("Site A loads 2x faster than Site B");
    expect(finding.evidence).toEqual(["LCP: 800ms vs 1600ms"]);
    expect(finding.sourceUrl).toBe("https://example.com");
    expect(finding.confidence).toBe("high");
    expect(finding.method).toBe("extractPage + compare");
  });

  it("accepts optional dimension", async () => {
    const result = await execute.handler({
      code: `return smart.finding({
        claim: "Missing CSP header",
        evidence: ["security.csp is null"],
        sourceUrl: "https://example.com",
        confidence: "medium",
        method: "extractPage",
        dimension: "security",
      })`,
    });
    const finding = parseResult(result) as Finding;
    expect(finding.dimension).toBe("security");
  });

  it("rejects missing claim", async () => {
    const result = await execute.handler({
      code: `try {
        smart.finding({ evidence: ["x"], sourceUrl: "https://a.com", confidence: "high", method: "m" });
        return { error: false };
      } catch (e) { return { error: true, message: e.message }; }`,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.message).toContain("claim");
  });

  it("rejects empty evidence array", async () => {
    const result = await execute.handler({
      code: `try {
        smart.finding({ claim: "x", evidence: [], sourceUrl: "https://a.com", confidence: "high", method: "m" });
        return { error: false };
      } catch (e) { return { error: true, message: e.message }; }`,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.message).toContain("evidence");
  });

  it("rejects invalid confidence", async () => {
    const result = await execute.handler({
      code: `try {
        smart.finding({ claim: "x", evidence: ["y"], sourceUrl: "https://a.com", confidence: "maybe", method: "m" });
        return { error: false };
      } catch (e) { return { error: true, message: e.message }; }`,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.message).toContain("confidence");
  });

  it("rejects non-string evidence entries", async () => {
    const result = await execute.handler({
      code: `try {
        smart.finding({ claim: "x", evidence: [42], sourceUrl: "https://a.com", confidence: "high", method: "m" });
        return { error: false };
      } catch (e) { return { error: true, message: e.message }; }`,
    });
    const data = parseResult(result);
    expect(data.error).toBe(true);
    expect(data.message).toContain("evidence");
  });
});

// ============================================================
// Phase 4: Coverage-Gap Modeling
// ============================================================

describe("extractPage coverage gaps", () => {
  it("emits gaps when supplementary calls fail", async () => {
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: { total: 5 }, console: { total: 2 }, cookies: { total: 1 }, dom: { nodeCount: 100 } };
        case "get_performance_metrics": throw new Error("perf timeout");
        case "get_security_state": throw new Error("security unavailable");
        case "detect_fonts": throw new Error("fonts fail");
        case "get_accessibility_tree": throw new Error("a11y fail");
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]") && expr.includes("mediaQueryCount")) {
            return { result: { hasViewportMeta: true, viewportContent: "width=device-width", mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          }
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    const result = await exec.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };

    expect(data.gaps.length).toBe(4);
    const dimensions = data.gaps.map(g => g.dimension).sort();
    expect(dimensions).toEqual(["accessibility", "fonts", "performance", "security"]);
    for (const gap of data.gaps) {
      expect(gap.impact).toBe("method-failed");
      expect(typeof gap.reason).toBe("string");
      expect(gap.reason.length).toBeGreaterThan(0);
    }
  });

  it("emits zero gaps when all calls succeed", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };
    expect(data.gaps).toEqual([]);
  });

  it("gaps preserve original error messages", async () => {
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": throw new Error("CDP domain disabled");
        case "get_security_state": return { ok: true };
        case "detect_fonts": return { fonts: [] };
        case "get_accessibility_tree": return { tree: [], nodeCount: 0 };
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]") && expr.includes("mediaQueryCount")) {
            return { result: { hasViewportMeta: false, viewportContent: null, mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          }
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    const result = await exec.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };
    expect(data.gaps.length).toBe(1);
    expect(data.gaps[0].reason).toBe("CDP domain disabled");
  });
});

// ============================================================
// Phase 5: Comparison Scaffold
// ============================================================

describe("comparePages scaffold", () => {
  let bridge: ReturnType<typeof createSmartBridge>;
  let execute: ReturnType<typeof getExecuteTool>;

  beforeEach(() => {
    bridge = createSmartBridge();
    execute = getExecuteTool(bridge);
  });

  it("scaffold has 11 dimensions", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    expect(data.scaffold.dimensions.length).toBe(11);
  });

  it("each dimension has siteA, siteB, comparable flag", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    for (const dim of data.scaffold.dimensions) {
      expect(dim).toHaveProperty("name");
      expect(dim).toHaveProperty("siteA");
      expect(dim).toHaveProperty("siteB");
      expect(typeof dim.comparable).toBe("boolean");
      expect(["present", "absent", "degraded"]).toContain(dim.siteA.type);
      expect(["present", "absent", "degraded"]).toContain(dim.siteB.type);
    }
  });

  it("scaffold includes sharedFields and missingFields", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    expect(Array.isArray(data.scaffold.sharedFields)).toBe(true);
    expect(data.scaffold.missingFields).toHaveProperty("siteA");
    expect(data.scaffold.missingFields).toHaveProperty("siteB");
  });

  it("scaffold extracts comparable metrics", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    expect(Array.isArray(data.scaffold.metrics)).toBe(true);
    // Bridge mock returns LCP/FCP in performance.metrics
    const lcpMetric = data.scaffold.metrics.find(m => m.name === "LCP");
    expect(lcpMetric).toBeTruthy();
    expect(typeof lcpMetric!.siteA).toBe("number");
    expect(typeof lcpMetric!.siteB).toBe("number");
  });

  it("scaffold extracts metrics from real extension shape (webVitals + timing)", async () => {
    // Override bridge to return real extension perf shape
    const realPerfBridge = createSmartBridge();
    realPerfBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: { total: 5 }, console: { total: 2 }, cookies: { total: 1 }, dom: { nodeCount: 100 } };
        case "get_performance_metrics": return {
          chrome: { documents: 1, frames: 1, jsEventListeners: 50, nodes: 200, taskDuration: 0.45, scriptDuration: 0.12, jsHeapUsedSize: 5000000 },
          webVitals: { lcp: 1100, cls: 0.05, fid: null },
          timing: { domContentLoaded: 450, load: 900, firstByte: 120, domInteractive: 350 },
        };
        case "get_security_state": return { securityState: "secure" };
        case "detect_fonts": return { fonts: ["Arial"] };
        case "get_accessibility_tree": return { tree: [], nodeCount: 0 };
        case "browser_navigate": return { ok: true };
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]") && expr.includes("mediaQueryCount")) {
            return { result: { hasViewportMeta: true, viewportContent: "width=device-width", mediaQueryCount: 2, isOverflowing: false }, type: "object" };
          }
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(realPerfBridge);
    const result = await exec.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    const metricNames = data.scaffold.metrics.map(m => m.name);
    expect(metricNames).toContain("LCP");
    expect(metricNames).toContain("CLS");
    expect(metricNames).toContain("TTFB");
    expect(metricNames).toContain("taskDuration");
    expect(metricNames).toContain("networkRequests");
    expect(metricNames).toContain("domNodeCount");
    const lcpMetric = data.scaffold.metrics.find(m => m.name === "LCP")!;
    expect(lcpMetric.siteA).toBe(1100);
    expect(lcpMetric.siteB).toBe(1100);
  });

  it("dimensions include expected names", async () => {
    const result = await execute.handler({
      code: `return await smart.comparePages("https://a.com", "https://b.com")`,
    });
    const data = parseResult(result) as ComparisonEvidence;
    const names = data.scaffold.dimensions.map(d => d.name);
    expect(names).toContain("framework");
    expect(names).toContain("performance");
    expect(names).toContain("security");
    expect(names).toContain("seo");
    expect(names).toContain("mobile-readiness");
  });
});

// ============================================================
// Phase 6: Method Telemetry
// ============================================================

describe("extractPage trace", () => {
  it("returns _trace when trace: true", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: "return await smart.extractPage({ trace: true })",
    });
    const data = parseResult(result);
    expect(data._trace).toBeTruthy();
    expect(data._trace.method).toBe("extractPage");
    expect(typeof data._trace.elapsed).toBe("number");
    expect(typeof data._trace.startedAt).toBe("number");
    expect(Array.isArray(data._trace.steps)).toBe(true);
    expect(data._trace.steps.length).toBeGreaterThan(0);
    expect(["success", "partial", "timeout", "error"]).toContain(data._trace.outcome);
  });

  it("does not return _trace when trace not requested", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: "return await smart.extractPage()",
    });
    const data = parseResult(result);
    expect(data._trace).toBeUndefined();
  });

  it("trace steps include all parallel calls", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: "return await smart.extractPage({ trace: true })",
    });
    const data = parseResult(result);
    const stepNames = data._trace.steps.map((s: { name: string }) => s.name);
    expect(stepNames).toContain("capture_page");
    expect(stepNames).toContain("get_performance_metrics");
    expect(stepNames).toContain("get_security_state");
    expect(stepNames).toContain("detect_fonts");
    expect(stepNames).toContain("meta_extraction");
    expect(stepNames).toContain("accessibility_tree");
    expect(stepNames).toContain("mobile_readiness");
  });

  it("trace shows partial outcome on failures", async () => {
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": throw new Error("fail");
        case "get_security_state": return { ok: true };
        case "detect_fonts": return { fonts: [] };
        case "get_accessibility_tree": return { tree: [], nodeCount: 0 };
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]") && expr.includes("mediaQueryCount")) {
            return { result: { hasViewportMeta: false, viewportContent: null, mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          }
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    const result = await exec.handler({ code: "return await smart.extractPage({ trace: true })" });
    const data = parseResult(result);
    expect(data._trace.outcome).toBe("partial");
  });
});

// ============================================================
// Phase 7: Accessibility & Mobile Readiness Dimensions
// ============================================================

describe("extractPage accessibility", () => {
  it("returns AccessibilitySummary from tree data", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };
    expect(data.accessibility).toBeTruthy();
    expect(data.accessibility!.nodeCount).toBeGreaterThan(0);
    expect(data.accessibility!.landmarkCount).toBe(3); // banner, main, navigation
    expect(data.accessibility!.imagesWithoutAlt).toBe(1); // one img with empty name
    expect(data.accessibility!.headingStructure.length).toBe(1);
    expect(data.accessibility!.headingStructure[0].level).toBe(1);
  });

  it("returns null when accessibility tree fails", async () => {
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": return { metrics: { LCP: 1000 } };
        case "get_security_state": return { securityState: "secure" };
        case "detect_fonts": return { fonts: [] };
        case "get_accessibility_tree": throw new Error("a11y not supported");
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]")) return { result: { hasViewportMeta: true, viewportContent: "width=device-width", mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    const result = await exec.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };
    expect(data.accessibility).toBeNull();
    expect(data.gaps.some(g => g.dimension === "accessibility")).toBe(true);
  });
});

describe("extractPage mobileReadiness", () => {
  it("returns MobileReadiness from evaluate", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractPage()" });
    const data = parseResult(result) as PageEvidence & { gaps: CoverageGap[] };
    expect(data.mobileReadiness).toBeTruthy();
    expect(data.mobileReadiness!.hasViewportMeta).toBe(true);
    expect(data.mobileReadiness!.viewportContent).toBe("width=device-width, initial-scale=1");
    expect(data.mobileReadiness!.mediaQueryCount).toBe(3);
    expect(data.mobileReadiness!.isOverflowing).toBe(false);
  });
});

// ============================================================
// Phase 8: Confidence Propagation
// ============================================================

describe("confidence propagation", () => {
  it("caps confidence when dimension has active gap with reducesConfidence", async () => {
    // Use a bridge where performance fails (creates gap with reducesConfidence: true)
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": throw new Error("perf fail");
        case "get_security_state": return { securityState: "secure" };
        case "detect_fonts": return { fonts: [] };
        case "get_accessibility_tree": return { tree: [], nodeCount: 0 };
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]")) return { result: { hasViewportMeta: true, viewportContent: "width=device-width", mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    // First call extractPage to populate sessionGaps
    await exec.handler({ code: "smart.clearFindings(); return await smart.extractPage()" });
    // Now create a finding with dimension="performance" — should be capped
    const result = await exec.handler({
      code: `return smart.finding({
        claim: "Page is slow",
        evidence: ["LCP > 2000ms"],
        sourceUrl: "https://test.com",
        confidence: "high",
        method: "extractPage",
        dimension: "performance",
      })`,
    });
    const finding = parseResult(result) as Finding;
    expect(finding.confidence).toBe("medium"); // high → medium
    expect(finding.confidenceCapped).toBe(true);
    expect(finding.cappedBy).toBe("performance");
  });

  it("does not cap confidence when dimension has no gap", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    // extractPage with all calls succeeding — no gaps
    await execute.handler({ code: "smart.clearFindings(); return await smart.extractPage()" });
    const result = await execute.handler({
      code: `return smart.finding({
        claim: "Security is good",
        evidence: ["TLS 1.3"],
        sourceUrl: "https://test.com",
        confidence: "high",
        method: "extractPage",
        dimension: "security",
      })`,
    });
    const finding = parseResult(result) as Finding;
    expect(finding.confidence).toBe("high");
    expect(finding.confidenceCapped).toBeUndefined();
  });

  it("does not cap when dimension doesn't match any gap", async () => {
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": throw new Error("perf fail");
        case "get_security_state": return { securityState: "secure" };
        case "detect_fonts": return { fonts: [] };
        case "get_accessibility_tree": return { tree: [], nodeCount: 0 };
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]")) return { result: { hasViewportMeta: true, viewportContent: "width=device-width", mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    await exec.handler({ code: "smart.clearFindings(); return await smart.extractPage()" });
    // Finding with dimension="fonts" — fonts gap has reducesConfidence: false
    const result = await exec.handler({
      code: `return smart.finding({
        claim: "Font loading issue",
        evidence: ["fonts failed"],
        sourceUrl: "https://test.com",
        confidence: "high",
        method: "extractPage",
        dimension: "fonts",
      })`,
    });
    const finding = parseResult(result) as Finding;
    expect(finding.confidence).toBe("high"); // fonts gap has reducesConfidence: false
    expect(finding.confidenceCapped).toBeUndefined();
  });

  it("caps medium to low", async () => {
    const failBridge = createSmartBridge();
    failBridge.send.mockImplementation(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        case "capture_page": return { url: "https://test.com", title: "Test", network: {}, console: {}, cookies: {}, dom: {} };
        case "get_performance_metrics": return { metrics: { LCP: 1000 } };
        case "get_security_state": throw new Error("sec fail");
        case "detect_fonts": return { fonts: [] };
        case "get_accessibility_tree": return { tree: [], nodeCount: 0 };
        case "browser_evaluate": {
          const expr = String(msg.expression || "");
          if (expr.includes("meta[name=\"viewport\"]")) return { result: { hasViewportMeta: true, viewportContent: "width=device-width", mediaQueryCount: 0, isOverflowing: false }, type: "object" };
          return { result: { _title: "T", _headings: [], _nav: [], _structuredData: [], _canonical: null }, type: "object" };
        }
        default: return { ok: true };
      }
    });
    const exec = getExecuteTool(failBridge);
    await exec.handler({ code: "smart.clearFindings(); return await smart.extractPage()" });
    const result = await exec.handler({
      code: `return smart.finding({
        claim: "Missing HTTPS",
        evidence: ["no TLS"],
        sourceUrl: "https://test.com",
        confidence: "medium",
        method: "extractPage",
        dimension: "security",
      })`,
    });
    const finding = parseResult(result) as Finding;
    expect(finding.confidence).toBe("low"); // medium → low
    expect(finding.confidenceCapped).toBe(true);
    expect(finding.cappedBy).toBe("security");
  });
});

// ============================================================
// Phase 9: Evidence Aggregation
// ============================================================

describe("evidence aggregation", () => {
  it("accumulates findings across multiple calls", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    await execute.handler({ code: "smart.clearFindings()" });
    await execute.handler({
      code: `smart.finding({ claim: "A", evidence: ["e1"], sourceUrl: "https://a.com", confidence: "high", method: "m" })`,
    });
    await execute.handler({
      code: `smart.finding({ claim: "B", evidence: ["e2"], sourceUrl: "https://b.com", confidence: "low", method: "m" })`,
    });
    const result = await execute.handler({ code: "return smart.findings()" });
    const findings = parseResult(result) as Finding[];
    expect(findings.length).toBe(2);
    expect(findings[0].claim).toBe("A");
    expect(findings[1].claim).toBe("B");
  });

  it("clearFindings resets accumulator", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    await execute.handler({
      code: `smart.finding({ claim: "X", evidence: ["e"], sourceUrl: "https://x.com", confidence: "high", method: "m" })`,
    });
    await execute.handler({ code: "smart.clearFindings()" });
    const result = await execute.handler({ code: "return smart.findings()" });
    const findings = parseResult(result) as Finding[];
    expect(findings.length).toBe(0);
  });

  it("findings returns a copy (not the internal array)", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    await execute.handler({ code: "smart.clearFindings()" });
    await execute.handler({
      code: `smart.finding({ claim: "C", evidence: ["e"], sourceUrl: "https://c.com", confidence: "medium", method: "m" })`,
    });
    // Mutating the returned array should not affect internal state
    const result = await execute.handler({
      code: `const arr = smart.findings(); arr.length = 0; return smart.findings().length`,
    });
    const length = parseResult(result);
    expect(length).toBe(1);
  });
});

// ============================================================
// Phase 11: Structured Data Extraction
// ============================================================

describe("smart.detectTables", () => {
  it("returns array of candidates", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables()" });
    const candidates = parseResult(result) as TableCandidate[];
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("respects maxCandidates option", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables({ maxCandidates: 1 })" });
    const candidates = parseResult(result) as TableCandidate[];
    expect(candidates.length).toBe(1);
  });

  it("candidates have required fields", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables()" });
    const candidates = parseResult(result) as TableCandidate[];
    for (const c of candidates) {
      expect(typeof c.selector).toBe("string");
      expect(typeof c.score).toBe("number");
      expect(typeof c.rowCount).toBe("number");
      expect(typeof c.sampleText).toBe("string");
      expect(typeof c.area).toBe("number");
    }
  });

  it("scores are non-negative", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables()" });
    const candidates = parseResult(result) as TableCandidate[];
    for (const c of candidates) {
      expect(c.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("candidates sorted by score descending", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables()" });
    const candidates = parseResult(result) as TableCandidate[];
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1].score).toBeGreaterThanOrEqual(candidates[i].score);
    }
  });

  it("returns empty array when no candidates from page", async () => {
    const bridge = createSmartBridge();
    // Override evaluate to return empty array for detectTables
    const origSend = bridge.send;
    bridge.send = vi.fn(async (msg: Record<string, unknown>) => {
      if (msg.type === "browser_evaluate") {
        const expr = String(msg.expression || "");
        if (expr.startsWith("/*crawlio:detect-tables*/")) {
          return { result: [], type: "object" };
        }
      }
      return origSend(msg);
    });
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables()" });
    const candidates = parseResult(result) as TableCandidate[];
    expect(candidates).toEqual([]);
  });

  it("candidates carry confidence, strategy, and warnings", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectTables()" });
    const candidates = parseResult(result) as TableCandidate[];
    for (const c of candidates) {
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(["table-rows", "sibling-repeated-blocks"]).toContain(c.strategy);
      expect(Array.isArray(c.warnings)).toBe(true);
    }
    expect(candidates[0].strategy).toBe("table-rows");
    expect(candidates.some(c => c.warnings.includes("row heights inconsistent"))).toBe(true);
  });

  it("embeds maxCandidates once, as the trailing JSON options literal", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    await execute.handler({ code: "return await smart.detectTables({ maxCandidates: 17 })" });
    const call = bridge.send.mock.calls.find((c: unknown[]) =>
      String((c[0] as { expression?: string }).expression || "").startsWith("/*crawlio:detect-tables*/")
    );
    expect(call).toBeTruthy();
    const expr = String((call![0] as { expression: string }).expression);
    const [opts] = extractionArgs(expr) as [{ maxCandidates: number }];
    expect(opts.maxCandidates).toBe(17);
    // The value appears only in the trailing literal — never interpolated through the body
    expect(expr.slice(0, expr.lastIndexOf("})("))).not.toContain("17");
  });
});

describe("smart.extractTable", () => {
  it("returns columns and rows", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    expect(extraction.columns.length).toBeGreaterThan(0);
    expect(extraction.rows.length).toBeGreaterThan(0);
  });

  it("columns have name, path, fillRate", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    for (const col of extraction.columns) {
      expect(typeof col.name).toBe("string");
      expect(typeof col.path).toBe("string");
      expect(typeof col.fillRate).toBe("number");
    }
  });

  it("rows are objects with string values", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    for (const row of extraction.rows) {
      for (const val of Object.values(row)) {
        expect(typeof val).toBe("string");
      }
    }
  });

  it("returns totalRows and truncated fields", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    expect(typeof extraction.totalRows).toBe("number");
    expect(typeof extraction.truncated).toBe("boolean");
  });

  it("returns selector in result", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    expect(extraction.selector).toBe("div.product-grid");
  });

  it("fillRate is between 0 and 1", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    for (const col of extraction.columns) {
      expect(col.fillRate).toBeGreaterThanOrEqual(0);
      expect(col.fillRate).toBeLessThanOrEqual(1);
    }
  });

  it("column names are strings, not raw paths", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.product-grid")` });
    const extraction = parseResult(result) as TableExtraction;
    for (const col of extraction.columns) {
      // Column name should not start with /
      expect(col.name.startsWith("/")).toBe(false);
    }
  });

  it("handles empty container gracefully", async () => {
    const bridge = createSmartBridge();
    const origSend = bridge.send;
    bridge.send = vi.fn(async (msg: Record<string, unknown>) => {
      if (msg.type === "browser_evaluate") {
        const expr = String(msg.expression || "");
        if (expr.startsWith("/*crawlio:extract-table*/")) {
          return { result: { selector: "div.empty", columns: [], rows: [], totalRows: 0, truncated: false }, type: "object" };
        }
      }
      return origSend(msg);
    });
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: `return await smart.extractTable("div.empty")` });
    const extraction = parseResult(result) as TableExtraction;
    expect(extraction.columns).toEqual([]);
    expect(extraction.rows).toEqual([]);
    expect(extraction.totalRows).toBe(0);
  });

  it("embeds the selector via JSON.stringify and options as the trailing literal", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const tricky = `div[data-name="a\\"b"]`;
    await execute.handler({ code: `return await smart.extractTable(${JSON.stringify(tricky)}, { maxRows: 37 })` });
    const call = bridge.send.mock.calls.find((c: unknown[]) =>
      String((c[0] as { expression?: string }).expression || "").startsWith("/*crawlio:extract-table*/")
    );
    expect(call).toBeTruthy();
    const expr = String((call![0] as { expression: string }).expression);
    expect(expr).toContain(JSON.stringify(tricky));
    const [selector, opts] = extractionArgs(expr) as [string, { maxRows: number }];
    expect(selector).toBe(tricky);
    expect(opts.maxRows).toBe(37);
  });
});

describe("smart.waitForNetworkIdle", () => {
  it("returns idle status", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.waitForNetworkIdle()" });
    const idle = parseResult(result) as NetworkIdleResult;
    expect(idle.status).toBe("idle");
  });

  it("returns elapsed time", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.waitForNetworkIdle()" });
    const idle = parseResult(result) as NetworkIdleResult;
    expect(typeof idle.elapsed).toBe("number");
    expect(idle.elapsed).toBeGreaterThan(0);
  });

  it("returns timeout status when requests are pending", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.waitForNetworkIdle({ timeout: 100 })" });
    const idle = parseResult(result) as NetworkIdleResult;
    expect(idle.status).toBe("timeout");
    expect(typeof idle.pendingAtTimeout).toBe("number");
  });

  it("caps timeout at 30000ms", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    // Should not throw — timeout is capped internally
    const result = await execute.handler({ code: "return await smart.waitForNetworkIdle({ timeout: 99999 })" });
    const idle = parseResult(result) as NetworkIdleResult;
    expect(idle.status).toBe("idle");
  });

  it("accepts idleTime option", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.waitForNetworkIdle({ idleTime: 1000 })" });
    const idle = parseResult(result) as NetworkIdleResult;
    expect(idle.status).toBe("idle");
  });
});

describe("smart.extractData", () => {
  it("returns tables and structuredData arrays", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractData()" });
    const data = parseResult(result) as DataExtraction;
    expect(Array.isArray(data.tables)).toBe(true);
    expect(Array.isArray(data.structuredData)).toBe(true);
  });

  it("returns url field", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractData()" });
    const data = parseResult(result) as DataExtraction;
    expect(typeof data.url).toBe("string");
  });

  it("tables have valid structure", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractData()" });
    const data = parseResult(result) as DataExtraction;
    for (const table of data.tables) {
      expect(table.columns.length).toBeGreaterThanOrEqual(2);
      expect(table.rows.length).toBeGreaterThanOrEqual(2);
      expect(typeof table.selector).toBe("string");
    }
  });

  it("structuredData contains JSON-LD", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractData()" });
    const data = parseResult(result) as DataExtraction;
    expect(data.structuredData.length).toBeGreaterThan(0);
  });

  it("respects maxTables option", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractData({ maxTables: 1 })" });
    const data = parseResult(result) as DataExtraction;
    // maxTables=1 means only 1 candidate detected, then filtered
    expect(data.tables.length).toBeLessThanOrEqual(1);
  });

  it("returns empty tables array when no patterns found", async () => {
    const bridge = createSmartBridge();
    const origSend = bridge.send;
    bridge.send = vi.fn(async (msg: Record<string, unknown>) => {
      if (msg.type === "browser_evaluate") {
        const expr = String(msg.expression || "");
        if (expr.startsWith("/*crawlio:detect-tables*/")) {
          return { result: [], type: "object" };
        }
        if (expr.includes("application/ld+json")) {
          return { result: [], type: "object" };
        }
      }
      return origSend(msg);
    });
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.extractData()" });
    const data = parseResult(result) as DataExtraction;
    expect(data.tables).toEqual([]);
  });
});

// ============================================================
// Structured page perception: smart.detectSections
// ============================================================

describe("smart.detectSections", () => {
  it("returns PageSections shape", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectSections()" });
    const data = parseResult(result) as PageSections;
    expect(typeof data.url).toBe("string");
    expect(data.viewport).toHaveProperty("width");
    expect(data.viewport).toHaveProperty("height");
    expect(Array.isArray(data.sections)).toBe(true);
    expect(typeof data.totalDetected).toBe("number");
    expect(typeof data.truncated).toBe("boolean");
  });

  it("section nodes carry role, source, selector, box, and interaction stats", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectSections()" });
    const data = parseResult(result) as PageSections;
    expect(data.sections.length).toBeGreaterThan(0);
    const walk = (nodes: PageSections["sections"]) => {
      for (const n of nodes) {
        expect(typeof n.role).toBe("string");
        expect(["semantic-tag", "aria-landmark", "data-attr", "class-hint"]).toContain(n.source);
        expect(typeof n.selector).toBe("string");
        expect(typeof n.selectorVerified).toBe("boolean");
        expect(n.box).toHaveProperty("x");
        expect(n.box).toHaveProperty("width");
        expect(typeof n.inViewport).toBe("boolean");
        expect(typeof n.interactiveCount).toBe("number");
        expect(typeof n.textLength).toBe("number");
        expect(Array.isArray(n.headings)).toBe(true);
        walk(n.children);
      }
    };
    walk(data.sections);
  });

  it("sections never mint [ref=eN] handles — selectors only", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return await smart.detectSections()" });
    const data = parseResult(result) as PageSections;
    const walk = (nodes: PageSections["sections"]) => {
      for (const n of nodes) {
        expect(n.selector).not.toMatch(/^\[ref=/);
        expect(n).not.toHaveProperty("ref");
        walk(n.children);
      }
    };
    walk(data.sections);
  });

  it("embeds maxDepth/maxSections once, as the trailing JSON options literal", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    await execute.handler({ code: "return await smart.detectSections({ maxDepth: 3, maxSections: 19 })" });
    const call = bridge.send.mock.calls.find((c: unknown[]) =>
      String((c[0] as { expression?: string }).expression || "").startsWith("/*crawlio:detect-sections*/")
    );
    expect(call).toBeTruthy();
    const expr = String((call![0] as { expression: string }).expression);
    const [opts] = extractionArgs(expr) as [{ maxDepth: number; maxSections: number }];
    expect(opts.maxDepth).toBe(3);
    expect(opts.maxSections).toBe(19);
    // Options must reach the program only through the trailing literal, never interpolated
    // into its body. Assert on the parameter names rather than their values: a bare number
    // collides with unrelated digits in the source, such as the 1999 in the XHTML namespace.
    // Distinguish the JSON form ("maxSections":19) from a property access (opts.maxSections):
    // the body legitimately reads the options, it just must not have them baked in. Asserting
    // on the bare number would collide with unrelated digits, such as the 1999 in the XHTML
    // namespace URI.
    const body = expr.slice(0, expr.lastIndexOf("})("));
    expect(body).not.toContain('"maxSections":');
    expect(body).not.toContain('"maxDepth":');
    expect(expr.slice(expr.lastIndexOf("})("))).toContain('"maxSections":19');
  });

  it("is present on the smart object", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({ code: "return Object.keys(smart).sort()" });
    const keys = parseResult(result) as string[];
    expect(keys).toContain("detectSections");
  });
});

describe("comparison scaffold with data-structure", () => {
  it("COMPARISON_DIMENSIONS has 11 entries", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: `
        const evidence = await smart.comparePages("https://a.com", "https://b.com");
        return evidence.scaffold.dimensions.length;
      `,
    });
    const count = parseResult(result);
    expect(count).toBe(11);
  });

  it("data-structure dimension present when JSON-LD exists", async () => {
    const bridge = createSmartBridge();
    // Mock meta extraction to include structured data
    const origSend = bridge.send;
    bridge.send = vi.fn(async (msg: Record<string, unknown>) => {
      if (msg.type === "browser_evaluate") {
        const expr = String(msg.expression || "");
        if (expr.includes("querySelectorAll('meta')")) {
          return { result: { _title: "Test", _canonical: null, _structuredData: [{ "@type": "Product" }], _headings: [], _nav: [] }, type: "object" };
        }
      }
      return origSend(msg);
    });
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: `
        const evidence = await smart.comparePages("https://a.com", "https://b.com");
        const ds = evidence.scaffold.dimensions.find(d => d.name === "data-structure");
        return ds;
      `,
    });
    const ds = parseResult(result);
    expect(ds.name).toBe("data-structure");
    expect(ds.siteA.type).toBe("present");
  });

  it("data-structure dimension absent when no structured data", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: `
        const evidence = await smart.comparePages("https://a.com", "https://b.com");
        const ds = evidence.scaffold.dimensions.find(d => d.name === "data-structure");
        return ds;
      `,
    });
    const ds = parseResult(result);
    expect(ds.name).toBe("data-structure");
    expect(ds.siteA.type).toBe("absent");
  });

  it("scaffold slot has correct shape", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: `
        const evidence = await smart.comparePages("https://a.com", "https://b.com");
        const ds = evidence.scaffold.dimensions.find(d => d.name === "data-structure");
        return ds;
      `,
    });
    const ds = parseResult(result);
    expect(typeof ds.comparable).toBe("boolean");
    expect(ds.siteA).toBeDefined();
    expect(ds.siteB).toBeDefined();
    expect(ds.siteA.dimension).toBe("data-structure");
  });

  it("existing 10 dimensions still present", async () => {
    const bridge = createSmartBridge();
    const execute = getExecuteTool(bridge);
    const result = await execute.handler({
      code: `
        const evidence = await smart.comparePages("https://a.com", "https://b.com");
        return evidence.scaffold.dimensions.map(d => d.name);
      `,
    });
    const names = parseResult(result) as string[];
    const expected = [
      "framework", "performance", "security", "seo", "accessibility",
      "error-surface", "third-party-load", "architecture", "content-delivery", "mobile-readiness",
    ];
    for (const dim of expected) {
      expect(names).toContain(dim);
    }
    expect(names).toContain("data-structure");
  });
});

// ============================================================
// Full-mode tools: detect_tables, extract_table, extract_data
// ============================================================

function getFullModeTool(bridge: ReturnType<typeof createSmartBridge>, toolName: string) {
  const crawlio = new CrawlioClient("http://localhost:0");
  const tools = createTools(bridge as never, crawlio);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`${toolName} tool not found`);
  return tool;
}

function parseFullModeResult(result: { isError?: boolean; content: Array<{ text: string }> }) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe("full-mode detect_tables tool", () => {
  it("exists in createTools output", () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_tables");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("detect_tables");
  });

  it("returns array of candidates", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_tables");
    const result = await tool.handler({});
    const candidates = parseFullModeResult(result) as TableCandidate[];
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("respects maxCandidates param", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_tables");
    const result = await tool.handler({ maxCandidates: 1 });
    const candidates = parseFullModeResult(result) as TableCandidate[];
    expect(candidates.length).toBe(1);
  });

  it("candidates have required shape", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_tables");
    const result = await tool.handler({});
    const candidates = parseFullModeResult(result) as TableCandidate[];
    for (const c of candidates) {
      expect(typeof c.selector).toBe("string");
      expect(typeof c.score).toBe("number");
      expect(typeof c.rowCount).toBe("number");
      expect(typeof c.sampleText).toBe("string");
      expect(typeof c.area).toBe("number");
    }
  });

  it("sends the sentinel-prefixed detect program to the bridge", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_tables");
    await tool.handler({ maxCandidates: 3 });
    const evaluateCalls = bridge.send.mock.calls.filter(
      (c: [{ type: string }]) => c[0].type === "browser_evaluate"
    );
    expect(evaluateCalls.length).toBeGreaterThan(0);
    const expr = (evaluateCalls[0][0] as { expression: string }).expression;
    expect(expr.startsWith("/*crawlio:detect-tables*/")).toBe(true);
    const [opts] = extractionArgs(expr) as [{ maxCandidates: number }];
    expect(opts.maxCandidates).toBe(3);
  });

  it("candidates include confidence, strategy, warnings alongside legacy score", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_tables");
    const result = await tool.handler({});
    const candidates = parseFullModeResult(result) as TableCandidate[];
    for (const c of candidates) {
      expect(typeof c.score).toBe("number");
      expect(typeof c.confidence).toBe("number");
      expect(["table-rows", "sibling-repeated-blocks"]).toContain(c.strategy);
      expect(Array.isArray(c.warnings)).toBe(true);
    }
  });
});

describe("full-mode detect_sections tool", () => {
  it("exists in createTools output", () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_sections");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("detect_sections");
  });

  it("documents the browser_snapshot({selector}) composition instead of refs", () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_sections");
    expect(tool.description).toContain("browser_snapshot");
    expect(tool.description).toContain("[ref=eN]");
  });

  it("returns PageSections from the page program", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_sections");
    const result = await tool.handler({});
    const data = parseFullModeResult(result) as PageSections;
    expect(Array.isArray(data.sections)).toBe(true);
    expect(data.sections.length).toBeGreaterThan(0);
    expect(data.sections[0]).toHaveProperty("role");
    expect(data.sections[0]).toHaveProperty("selector");
    expect(data.sections[0]).toHaveProperty("interactiveCount");
  });

  it("sends the sentinel-prefixed sections program with parsed options", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_sections");
    await tool.handler({ maxDepth: 4, maxSections: 25 });
    const evaluateCalls = bridge.send.mock.calls.filter(
      (c: [{ type: string }]) => c[0].type === "browser_evaluate"
    );
    expect(evaluateCalls.length).toBe(1);
    const expr = (evaluateCalls[0][0] as { expression: string }).expression;
    expect(expr.startsWith("/*crawlio:detect-sections*/")).toBe(true);
    const [opts] = extractionArgs(expr) as [{ maxDepth: number; maxSections: number }];
    expect(opts.maxDepth).toBe(4);
    expect(opts.maxSections).toBe(25);
  });

  it("rejects out-of-range options via zod", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "detect_sections");
    await expect(tool.handler({ maxDepth: 99 })).rejects.toThrow();
    await expect(tool.handler({ maxSections: 0 })).rejects.toThrow();
  });
});

describe("full-mode extract_table tool", () => {
  it("exists in createTools output", () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_table");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("extract_table");
  });

  it("returns columns and rows", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_table");
    const result = await tool.handler({ selector: "div.product-grid" });
    const extraction = parseFullModeResult(result) as TableExtraction;
    expect(extraction.columns.length).toBeGreaterThan(0);
    expect(extraction.rows.length).toBeGreaterThan(0);
  });

  it("requires selector parameter", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_table");
    await expect(tool.handler({})).rejects.toThrow();
  });

  it("preserves selector in response", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_table");
    const result = await tool.handler({ selector: "div.product-grid" });
    const extraction = parseFullModeResult(result) as TableExtraction;
    expect(extraction.selector).toBe("div.product-grid");
  });

  it("has totalRows and truncated fields", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_table");
    const result = await tool.handler({ selector: "div.product-grid" });
    const extraction = parseFullModeResult(result) as TableExtraction;
    expect(typeof extraction.totalRows).toBe("number");
    expect(typeof extraction.truncated).toBe("boolean");
  });

  it("columns have name, path, fillRate", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_table");
    const result = await tool.handler({ selector: "div.product-grid" });
    const extraction = parseFullModeResult(result) as TableExtraction;
    for (const col of extraction.columns) {
      expect(typeof col.name).toBe("string");
      expect(typeof col.path).toBe("string");
      expect(typeof col.fillRate).toBe("number");
    }
  });
});

describe("full-mode extract_data tool", () => {
  it("exists in createTools output", () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_data");
    expect(tool).toBeDefined();
    expect(tool.name).toBe("extract_data");
  });

  it("returns tables, structuredData, url", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_data");
    const result = await tool.handler({});
    const data = parseFullModeResult(result) as DataExtraction;
    expect(Array.isArray(data.tables)).toBe(true);
    expect(Array.isArray(data.structuredData)).toBe(true);
    expect(typeof data.url).toBe("string");
  });

  it("extracts JSON-LD structured data", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_data");
    const result = await tool.handler({});
    const data = parseFullModeResult(result) as DataExtraction;
    expect(data.structuredData.length).toBeGreaterThan(0);
  });

  it("respects maxTables param", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_data");
    const result = await tool.handler({ maxTables: 1 });
    const data = parseFullModeResult(result) as DataExtraction;
    // maxTables=1 means at most 1 candidate detected
    expect(data.tables.length).toBeLessThanOrEqual(1);
  });

  it("filters tables with <2 columns or <2 rows", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_data");
    const result = await tool.handler({});
    const data = parseFullModeResult(result) as DataExtraction;
    for (const table of data.tables) {
      expect(table.columns.length).toBeGreaterThanOrEqual(2);
      expect(table.rows.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("calls get_connection_status for URL", async () => {
    const bridge = createSmartBridge();
    const tool = getFullModeTool(bridge, "extract_data");
    await tool.handler({});
    const statusCalls = bridge.send.mock.calls.filter(
      (c: [{ type: string }]) => c[0].type === "get_connection_status"
    );
    expect(statusCalls.length).toBeGreaterThan(0);
  });
});
