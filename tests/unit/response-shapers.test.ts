import { describe, it, expect } from "vitest";
import {
  truncateUrl,
  shapeListTabs,
  shapeConnectTab,
  shapeCapturePage,
  shapeConsoleLogs,
  shapeNetworkLog,
  shapeCookies,
  shapeInteraction,
} from "../../src/mcp-server/response-shapers.js";
import type { PageCapture, NetworkEntry, ConsoleEntry } from "../../src/shared/types.js";
// --- truncateUrl ---

describe("truncateUrl", () => {
  it("should return short URLs unchanged", () => {
    expect(truncateUrl("https://example.com")).toBe("https://example.com");
  });

  it("should truncate long URLs with ellipsis", () => {
    const longUrl = "https://example.com/" + "a".repeat(200);
    const result = truncateUrl(longUrl, 120);
    expect(result.length).toBe(120);
    expect(result.endsWith("...")).toBe(true);
  });

  it("should respect custom max", () => {
    const url = "https://example.com/some/really/long/path/here";
    const result = truncateUrl(url, 30);
    expect(result.length).toBe(30);
    expect(result.endsWith("...")).toBe(true);
  });

  it("should not truncate at exactly max length", () => {
    const url = "x".repeat(120);
    expect(truncateUrl(url, 120)).toBe(url);
  });
});

// --- shapeListTabs ---

describe("shapeListTabs", () => {
  const tabs = [
    { tabId: 1, url: "https://example.com/page", title: "Example", windowId: 1, active: true, connected: true },
    { tabId: 2, url: "https://other.com/long/" + "x".repeat(200), title: "Other", windowId: 1, active: false, connected: false },
  ];

  it("should shape tabs from object format", () => {
    const result = shapeListTabs({ tabs, connectedTabId: 1 }) as any;
    expect(result.connectedTabId).toBe(1);
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0]).toEqual({ id: 1, title: "Example", url: "https://example.com/page", active: true });
    // windowId dropped, connected dropped
    expect(result.tabs[0].windowId).toBeUndefined();
    expect(result.tabs[0].connected).toBeUndefined();
  });

  it("should truncate long URLs in tabs", () => {
    const result = shapeListTabs({ tabs, connectedTabId: null }) as any;
    expect(result.tabs[1].url.length).toBeLessThanOrEqual(120);
    expect(result.tabs[1].url.endsWith("...")).toBe(true);
  });

  it("should handle array input", () => {
    const result = shapeListTabs(tabs) as any;
    expect(result.connectedTabId).toBeNull();
    expect(result.tabs).toHaveLength(2);
  });

  it("should omit active: false from non-active tabs", () => {
    const result = shapeListTabs({ tabs, connectedTabId: null }) as any;
    expect(result.tabs[1].active).toBeUndefined();
  });
});

// --- shapeConnectTab ---

describe("shapeConnectTab", () => {
  it("should shape successful connection", () => {
    const result = shapeConnectTab({
      tabId: 42,
      url: "https://example.com",
      title: "Example",
      domainState: {
        required: [
          { domain: "Runtime", success: true },
          { domain: "Page", success: true },
          { domain: "Network", success: true },
        ],
        optional: [
          { domain: "DOMStorage", success: false, error: "timeout" },
        ],
      },
    }) as any;

    expect(result.tabId).toBe(42);
    expect(result.ok).toBe(true);
    expect(result.failedDomains).toBeUndefined();
    // Optional failures dropped
  });

  it("should flag required domain failures", () => {
    const result = shapeConnectTab({
      tabId: 42,
      url: "https://example.com",
      title: "Example",
      domainState: {
        required: [
          { domain: "Runtime", success: true },
          { domain: "Page", success: false, error: "detached" },
        ],
      },
    }) as any;

    expect(result.ok).toBe(false);
    expect(result.failedDomains).toEqual(["Page"]);
  });

  it("should handle missing domainState", () => {
    const result = shapeConnectTab({ tabId: 1, url: "https://x.com", title: "X" }) as any;
    expect(result.ok).toBe(true);
  });

  it("should truncate long URLs", () => {
    const result = shapeConnectTab({
      tabId: 1,
      url: "https://example.com/" + "a".repeat(200),
      title: "T",
    }) as any;
    expect(result.url.length).toBeLessThanOrEqual(120);
  });
});

// --- shapeCapturePage ---

describe("shapeCapturePage", () => {
  const fullCapture: PageCapture = {
    url: "https://example.com/page",
    title: "Test Page",
    capturedAt: "2026-03-02T00:00:00Z",
    framework: { framework: "Next.js", confidence: "high", signals: ["__NEXT_DATA__"], version: "14.2" },
    networkRequests: [
      { url: "https://example.com/api/data", method: "GET", status: 200, mimeType: "application/json", size: 1024, transferSize: 512, durationMs: 100, resourceType: "fetch" },
      { url: "https://example.com/api/fail", method: "POST", status: 500, mimeType: "text/html", size: 200, transferSize: 100, durationMs: 50, resourceType: "fetch" },
      { url: "https://cdn.example.com/styles.css", method: "GET", status: 200, mimeType: "text/css", size: 2048, transferSize: 1024, durationMs: 30, resourceType: "stylesheet" },
    ],
    consoleLogs: [
      { level: "error", text: "Uncaught TypeError: x is not a function", timestamp: "2026-03-02T00:00:01Z", url: "https://example.com/app.js", lineNumber: 42 },
      { level: "warning", text: "Deprecated API used", timestamp: "2026-03-02T00:00:02Z" },
      { level: "info", text: "App loaded", timestamp: "2026-03-02T00:00:03Z" },
      { level: "debug", text: "Debug info", timestamp: "2026-03-02T00:00:04Z" },
    ],
    cookies: [
      { name: "session", value: "[REDACTED]", domain: ".example.com", path: "/", expires: 0, httpOnly: true, secure: true, sameSite: "Lax", size: 64 },
      { name: "_ga", value: "GA1.1.123", domain: ".example.com", path: "/", expires: 1700000000, httpOnly: false, secure: false, sameSite: "None", size: 32 },
    ],
    domSnapshot: {
      tag: "html",
      children: [
        {
          tag: "body",
          children: [
            { tag: "form", children: [{ tag: "input" }, { tag: "textarea" }] },
            { tag: "a", attrs: { href: "/" } },
            { tag: "a", attrs: { href: "/about" } },
            { tag: "img", attrs: { src: "/logo.png" } },
            { tag: "div", children: [{ tag: "p", text: "Hello" }] },
          ],
        },
      ],
    },
  };

  it("should produce compact summary with counts", () => {
    const result = shapeCapturePage(fullCapture) as any;
    expect(result.url).toBe("https://example.com/page");
    expect(result.title).toBe("Test Page");
    expect(result.framework.framework).toBe("Next.js");
    expect(result.network.total).toBe(3);
    expect(result.network.failed).toBe(1);
    expect(result.network.errors).toHaveLength(1);
    expect(result.network.errors[0].status).toBe(500);
    expect(result.console.total).toBe(4);
    expect(result.console.errors).toHaveLength(1);
    expect(result.console.warnings).toBe(1);
    expect(result.console.info).toBe(1);
    expect(result.console.debug).toBe(1);
    expect(result.cookies.total).toBe(2);
    expect(result.cookies.names).toEqual(["session", "_ga"]);
  });

  it("should produce DOM stats without the tree", () => {
    const result = shapeCapturePage(fullCapture) as any;
    expect(result.dom.nodeCount).toBe(10); // html, body, form, input, textarea, a, a, img, div, p
    expect(result.dom.forms).toBe(1);
    expect(result.dom.links).toBe(2);
    expect(result.dom.images).toBe(1);
    expect(result.dom.inputs).toBe(2); // input + textarea
    // Actual DOM tree NOT included
    expect(result.domSnapshot).toBeUndefined();
  });

  it("should handle missing optional fields", () => {
    const minimal: PageCapture = {
      url: "https://x.com",
      title: "X",
      capturedAt: "2026-03-02T00:00:00Z",
    };
    const result = shapeCapturePage(minimal) as any;
    expect(result.url).toBe("https://x.com");
    expect(result.network).toBeUndefined();
    expect(result.console).toBeUndefined();
    expect(result.cookies).toBeUndefined();
    expect(result.dom).toBeUndefined();
    expect(result.framework).toBeUndefined();
  });

  it("should cap network errors at 10", () => {
    const manyFailed: PageCapture = {
      url: "https://x.com",
      title: "X",
      capturedAt: "2026-03-02T00:00:00Z",
      networkRequests: Array.from({ length: 20 }, (_, i) => ({
        url: `https://x.com/fail/${i}`,
        method: "GET",
        status: 500,
        mimeType: "text/html",
        size: 0,
        transferSize: 0,
        durationMs: 10,
        resourceType: "fetch",
      })),
    };
    const result = shapeCapturePage(manyFailed) as any;
    expect(result.network.failed).toBe(20);
    expect(result.network.errors).toHaveLength(10);
  });
});

// --- shapeConsoleLogs ---

describe("shapeConsoleLogs", () => {
  const entries: ConsoleEntry[] = [
    { level: "error", text: "Error 1", timestamp: "t1", url: "https://x.com/app.js", lineNumber: 10 },
    { level: "error", text: "Error 2", timestamp: "t2" },
    { level: "warning", text: "Warn 1", timestamp: "t3" },
    { level: "info", text: "Info 1", timestamp: "t4" },
    { level: "info", text: "Info 2", timestamp: "t5" },
    { level: "debug", text: "Debug 1", timestamp: "t6" },
  ];

  it("should return errors in full with url/lineNumber", () => {
    const result = shapeConsoleLogs(entries) as any;
    expect(result.total).toBe(6);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].text).toBe("Error 1");
    expect(result.errors[0].url).toBe("https://x.com/app.js");
    expect(result.errors[0].lineNumber).toBe(10);
  });

  it("should cap warnings at 10", () => {
    const manyWarnings: ConsoleEntry[] = Array.from({ length: 15 }, (_, i) => ({
      level: "warning" as const,
      text: `Warning ${i}`,
      timestamp: `t${i}`,
    }));
    const result = shapeConsoleLogs(manyWarnings) as any;
    expect(result.warnings).toHaveLength(10);
  });

  it("should count info and debug", () => {
    const result = shapeConsoleLogs(entries) as any;
    expect(result.info).toBe(2);
    expect(result.debug).toBe(1);
  });

  it("should truncate long error text", () => {
    const longError: ConsoleEntry[] = [
      { level: "error", text: "x".repeat(500), timestamp: "t1" },
    ];
    const result = shapeConsoleLogs(longError) as any;
    expect(result.errors[0].text.length).toBeLessThanOrEqual(300);
  });
});

// --- shapeNetworkLog ---

describe("shapeNetworkLog", () => {
  const entries: NetworkEntry[] = [
    { url: "https://example.com/api/data", method: "GET", status: 200, mimeType: "application/json", size: 1024, transferSize: 512, durationMs: 100, resourceType: "fetch" },
    { url: "https://example.com/api/fail", method: "POST", status: 500, mimeType: "text/html", size: 200, transferSize: 100, durationMs: 50, resourceType: "fetch" },
    { url: "https://cdn.example.com/styles.css", method: "GET", status: 200, mimeType: "text/css", size: 2048, transferSize: 1024, durationMs: 200, resourceType: "stylesheet" },
    { url: "https://example.com/timeout", method: "GET", status: 0, mimeType: "", size: 0, transferSize: 0, durationMs: 30000, resourceType: "fetch" },
  ];

  it("should produce summary with counts", () => {
    const result = shapeNetworkLog(entries) as any;
    expect(result.total).toBe(4);
    expect(result.failed).toHaveLength(2); // status 500 + status 0
    expect(result.byStatus["2xx"]).toBe(2);
    expect(result.byStatus["5xx"]).toBe(1);
    expect(result.byStatus["0xx"]).toBe(1);
  });

  it("should include slowest requests sorted by duration", () => {
    const result = shapeNetworkLog(entries) as any;
    expect(result.slowest[0].durationMs).toBe(30000);
    expect(result.slowest[1].durationMs).toBe(200);
  });

  it("should group by type", () => {
    const result = shapeNetworkLog(entries) as any;
    expect(result.byType.fetch).toBe(3);
    expect(result.byType.stylesheet).toBe(1);
  });

  it("should handle empty array", () => {
    const result = shapeNetworkLog([]) as any;
    expect(result.total).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.slowest).toEqual([]);
  });
});

// --- shapeCookies ---

describe("shapeCookies", () => {
  const data = {
    cookies: [
      { name: "session", value: "[REDACTED]", domain: ".example.com", path: "/", expires: 0, httpOnly: true, secure: true, sameSite: "Lax" as const, size: 64 },
      { name: "_ga", value: "GA1.1.123", domain: ".example.com", path: "/", expires: 1700000000, httpOnly: false, secure: false, sameSite: "None" as const, size: 32 },
    ],
    fallbackUsed: false,
  };

  it("should drop value, path, expires, size", () => {
    const result = shapeCookies(data) as any;
    expect(result.total).toBe(2);
    expect(result.cookies[0].value).toBeUndefined();
    expect(result.cookies[0].path).toBeUndefined();
    expect(result.cookies[0].expires).toBeUndefined();
    expect(result.cookies[0].size).toBeUndefined();
  });

  it("should keep name, domain, httpOnly, secure, sameSite", () => {
    const result = shapeCookies(data) as any;
    expect(result.cookies[0]).toEqual({
      name: "session",
      domain: ".example.com",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
  });

  it("should default fallbackUsed to false", () => {
    const result = shapeCookies({ cookies: [], fallbackUsed: undefined }) as any;
    expect(result.fallbackUsed).toBe(false);
  });
});

// --- shapeInteraction ---

describe("shapeInteraction", () => {
  it("should keep actionable fields and drop coordinates", () => {
    const result = shapeInteraction({
      action: "click",
      selector: "#btn",
      x: 150,
      y: 300,
      success: true,
      snapshot: "- button 'Submit'",
      deltaX: 0,
      deltaY: 0,
      steps: 10,
      clearFirst: true,
    }) as any;

    expect(result.action).toBe("click");
    expect(result.selector).toBe("#btn");
    expect(result.success).toBe(true);
    expect(result.snapshot).toBe("- button 'Submit'");
    // Dropped fields
    expect(result.x).toBeUndefined();
    expect(result.y).toBeUndefined();
    expect(result.deltaX).toBeUndefined();
    expect(result.deltaY).toBeUndefined();
    expect(result.steps).toBeUndefined();
    expect(result.clearFirst).toBeUndefined();
  });

  it("should keep navigation URL and truncate it", () => {
    const result = shapeInteraction({
      action: "navigate",
      url: "https://example.com/" + "a".repeat(200),
      title: "Page",
    }) as any;
    expect(result.url.length).toBeLessThanOrEqual(120);
    expect(result.title).toBe("Page");
  });

  it("should keep typing fields", () => {
    const result = shapeInteraction({
      action: "type",
      selector: "#input",
      text: "hello world",
      key: "Enter",
    }) as any;
    expect(result.text).toBe("hello world");
    expect(result.key).toBe("Enter");
  });

  it("should keep select option fields", () => {
    const result = shapeInteraction({
      action: "select_option",
      selector: "#dropdown",
      previousValue: "a",
      newValue: "b",
    }) as any;
    expect(result.previousValue).toBe("a");
    expect(result.newValue).toBe("b");
  });

  it("should keep file upload count", () => {
    const result = shapeInteraction({
      action: "file_upload",
      selector: "#file",
      filesCount: 3,
    }) as any;
    expect(result.filesCount).toBe(3);
  });

  it("should handle null/undefined data gracefully", () => {
    expect(shapeInteraction(null)).toBeNull();
    expect(shapeInteraction(undefined)).toBeUndefined();
  });

  it("should keep ref field", () => {
    const result = shapeInteraction({
      action: "click",
      ref: "e3",
      success: true,
    }) as any;
    expect(result.ref).toBe("e3");
  });

  it("should keep filled and submitted fields", () => {
    const result = shapeInteraction({
      action: "fill_form",
      filled: 3,
      submitted: true,
      snapshot: "...",
    }) as any;
    expect(result.filled).toBe(3);
    expect(result.submitted).toBe(true);
  });
});
