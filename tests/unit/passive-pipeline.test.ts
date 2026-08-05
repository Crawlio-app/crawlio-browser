import { describe, it, expect, vi, beforeEach } from "vitest";
import { isGoogleSerp, extractSearchQuery } from "@/extension/serp-detector";
import { setBadgeInfo, setTooltip, clearBadge } from "@/extension/icon-generator";
import { handleContextMenuClick } from "@/extension/context-menus";

// --- Test the passive pipeline components used by background.ts ---
// background.ts wires these together; we test the pure functions and state logic

// --- SEO Intelligence Settings ---

interface SeoIntelligenceSettings {
  enabled: boolean;
  autoOverlay: boolean;
  autoBadge: boolean;
}

const SEO_INTELLIGENCE_DEFAULTS: SeoIntelligenceSettings = { enabled: true, autoOverlay: false, autoBadge: true };

describe("SEO Intelligence Settings", () => {
  it("defaults: enabled=true, autoOverlay=false, autoBadge=true", () => {
    const settings = { ...SEO_INTELLIGENCE_DEFAULTS };
    expect(settings.enabled).toBe(true);
    expect(settings.autoOverlay).toBe(false);
    expect(settings.autoBadge).toBe(true);
  });

  it("partial update preserves other fields", () => {
    const settings = { ...SEO_INTELLIGENCE_DEFAULTS };
    const updated = { ...settings, autoOverlay: true };
    expect(updated.enabled).toBe(true);
    expect(updated.autoOverlay).toBe(true);
    expect(updated.autoBadge).toBe(true);
  });

  it("master disable turns off all behavior", () => {
    const settings = { ...SEO_INTELLIGENCE_DEFAULTS, enabled: false };
    // When enabled is false, SERP pipeline should skip badge/overlay
    expect(settings.enabled).toBe(false);
    expect(settings.enabled && settings.autoBadge).toBe(false);
    expect(settings.enabled && settings.autoOverlay).toBe(false);
  });
});

// --- Full Pipeline Logic ---

describe("Passive SERP Pipeline Logic", () => {
  // Simulates the background.ts tabs.onUpdated SERP detection pipeline
  interface TabSerpState {
    isSerp: boolean;
    query: string | null;
    url: string;
    hasDebugger: boolean;
  }

  function runPipeline(
    url: string,
    debuggerAttachedTabId: number | null,
    tabId: number,
    settings: SeoIntelligenceSettings,
  ): { serpState: TabSerpState | null; badgeText: string | null; badgeColor: string | null; tooltip: string | null } {
    if (isGoogleSerp(url)) {
      const query = extractSearchQuery(url);
      const hasDebugger = debuggerAttachedTabId === tabId;
      const serpState: TabSerpState = { isSerp: true, query, url, hasDebugger };

      let badgeText: string | null = null;
      let badgeColor: string | null = null;
      let tooltip: string | null = null;

      if (settings.enabled && settings.autoBadge) {
        if (hasDebugger) {
          badgeText = "SERP";
          badgeColor = "#f97316";
          tooltip = query ? `Crawlio | SERP: ${query}` : "Crawlio | Google SERP";
        } else {
          badgeText = "SEO";
          badgeColor = "#9ca3af";
          tooltip = query ? `Crawlio | SERP: ${query} (connect for full analysis)` : "Crawlio | SERP detected — connect for full analysis";
        }
      }

      return { serpState, badgeText, badgeColor, tooltip };
    }

    return { serpState: null, badgeText: null, badgeColor: null, tooltip: null };
  }

  it("SERP URL + debugger → SERP badge + full tooltip", () => {
    const result = runPipeline(
      "https://www.google.com/search?q=crawlio+browser",
      42, 42,
      SEO_INTELLIGENCE_DEFAULTS,
    );
    expect(result.serpState?.isSerp).toBe(true);
    expect(result.serpState?.query).toBe("crawlio browser");
    expect(result.serpState?.hasDebugger).toBe(true);
    expect(result.badgeText).toBe("SERP");
    expect(result.badgeColor).toBe("#f97316");
    expect(result.tooltip).toBe("Crawlio | SERP: crawlio browser");
  });

  it("SERP URL + no debugger → limited SEO badge + connect prompt", () => {
    const result = runPipeline(
      "https://www.google.com/search?q=test",
      null, 42,
      SEO_INTELLIGENCE_DEFAULTS,
    );
    expect(result.serpState?.isSerp).toBe(true);
    expect(result.serpState?.hasDebugger).toBe(false);
    expect(result.badgeText).toBe("SEO");
    expect(result.badgeColor).toBe("#9ca3af");
    expect(result.tooltip).toContain("connect for full analysis");
  });

  it("non-SERP URL → no badge, no state", () => {
    const result = runPipeline(
      "https://example.com",
      42, 42,
      SEO_INTELLIGENCE_DEFAULTS,
    );
    expect(result.serpState).toBeNull();
    expect(result.badgeText).toBeNull();
  });

  it("master toggle disabled → SERP detected but no badge", () => {
    const result = runPipeline(
      "https://www.google.com/search?q=test",
      42, 42,
      { enabled: false, autoOverlay: false, autoBadge: true },
    );
    expect(result.serpState?.isSerp).toBe(true);
    expect(result.badgeText).toBeNull();
  });

  it("autoBadge disabled → SERP detected but no badge", () => {
    const result = runPipeline(
      "https://www.google.com/search?q=test",
      42, 42,
      { enabled: true, autoOverlay: false, autoBadge: false },
    );
    expect(result.serpState?.isSerp).toBe(true);
    expect(result.badgeText).toBeNull();
  });

  it("autoOverlay only triggers when debugger attached + enabled", () => {
    const settings: SeoIntelligenceSettings = { enabled: true, autoOverlay: true, autoBadge: true };
    const withDebugger = runPipeline("https://www.google.com/search?q=test", 42, 42, settings);
    expect(withDebugger.serpState?.hasDebugger).toBe(true);
    // autoOverlay would fire (checked in background.ts, not in this pure function)

    const withoutDebugger = runPipeline("https://www.google.com/search?q=test", null, 42, settings);
    expect(withoutDebugger.serpState?.hasDebugger).toBe(false);
    // autoOverlay would NOT fire (no debugger)
  });
});

// --- Tab Switch Badge Restoration ---

describe("Tab Switch Badge Restoration", () => {
  const tabSerpState = new Map<number, { isSerp: boolean; query: string | null; url: string; hasDebugger: boolean }>();

  beforeEach(() => {
    tabSerpState.clear();
  });

  function restoreBadge(
    tabId: number,
    settings: SeoIntelligenceSettings,
  ): { badgeText: string | null; tooltip: string | null } {
    const state = tabSerpState.get(tabId);
    if (!state?.isSerp || !settings.enabled || !settings.autoBadge) {
      return { badgeText: null, tooltip: null };
    }

    if (state.hasDebugger) {
      return {
        badgeText: "SERP",
        tooltip: state.query ? `Crawlio | SERP: ${state.query}` : "Crawlio | Google SERP",
      };
    }
    return {
      badgeText: "SEO",
      tooltip: state.query ? `Crawlio | SERP: ${state.query} (connect for full analysis)` : "Crawlio | SERP detected — connect for full analysis",
    };
  }

  it("restores full SERP badge from per-tab state", () => {
    tabSerpState.set(42, { isSerp: true, query: "test", url: "https://google.com/search?q=test", hasDebugger: true });
    const result = restoreBadge(42, SEO_INTELLIGENCE_DEFAULTS);
    expect(result.badgeText).toBe("SERP");
    expect(result.tooltip).toBe("Crawlio | SERP: test");
  });

  it("restores limited SEO badge from per-tab state", () => {
    tabSerpState.set(42, { isSerp: true, query: "test", url: "https://google.com/search?q=test", hasDebugger: false });
    const result = restoreBadge(42, SEO_INTELLIGENCE_DEFAULTS);
    expect(result.badgeText).toBe("SEO");
    expect(result.tooltip).toContain("connect for full analysis");
  });

  it("returns null for non-SERP tab", () => {
    tabSerpState.set(42, { isSerp: false, query: null, url: "https://example.com", hasDebugger: false });
    const result = restoreBadge(42, SEO_INTELLIGENCE_DEFAULTS);
    expect(result.badgeText).toBeNull();
  });

  it("returns null for unknown tab", () => {
    const result = restoreBadge(99, SEO_INTELLIGENCE_DEFAULTS);
    expect(result.badgeText).toBeNull();
  });

  it("respects disabled master toggle on tab switch", () => {
    tabSerpState.set(42, { isSerp: true, query: "test", url: "https://google.com/search?q=test", hasDebugger: true });
    const result = restoreBadge(42, { enabled: false, autoOverlay: false, autoBadge: true });
    expect(result.badgeText).toBeNull();
  });

  it("cleans up state on tab close", () => {
    tabSerpState.set(42, { isSerp: true, query: "test", url: "https://google.com/search?q=test", hasDebugger: true });
    tabSerpState.delete(42);
    const result = restoreBadge(42, SEO_INTELLIGENCE_DEFAULTS);
    expect(result.badgeText).toBeNull();
  });
});

// --- Context Menu Dispatch ---

describe("Context Menu → Tool Dispatch", () => {
  const handlers = {
    capturePageFn: vi.fn(),
    extractTablesFn: vi.fn(),
    analyzeSelectionFn: vi.fn(),
    startRecordingFn: vi.fn(),
    seoCheckFn: vi.fn(),
  };

  const tab = { id: 42 } as chrome.tabs.Tab;

  const makeInfo = (menuItemId: string, selectionText?: string): chrome.contextMenus.OnClickData => ({
    menuItemId,
    editable: false,
    pageUrl: "https://example.com",
    selectionText,
  });

  beforeEach(() => {
    Object.values(handlers).forEach(fn => fn.mockClear());
  });

  it("capture dispatches with tabId", () => {
    handleContextMenuClick(makeInfo("crawlio-capture-page"), tab, handlers);
    expect(handlers.capturePageFn).toHaveBeenCalledWith(42);
  });

  it("extract tables dispatches with tabId", () => {
    handleContextMenuClick(makeInfo("crawlio-extract-tables"), tab, handlers);
    expect(handlers.extractTablesFn).toHaveBeenCalledWith(42);
  });

  it("seo check dispatches with tabId", () => {
    handleContextMenuClick(makeInfo("crawlio-seo-check"), tab, handlers);
    expect(handlers.seoCheckFn).toHaveBeenCalledWith(42);
  });

  it("start recording dispatches with tabId", () => {
    handleContextMenuClick(makeInfo("crawlio-start-recording"), tab, handlers);
    expect(handlers.startRecordingFn).toHaveBeenCalledWith(42);
  });

  it("analyze selection passes text + tabId", () => {
    handleContextMenuClick(makeInfo("crawlio-analyze-selection", "selected text"), tab, handlers);
    expect(handlers.analyzeSelectionFn).toHaveBeenCalledWith("selected text", 42);
  });
});

// --- Icon Generator Integration ---

describe("Icon Generator - Badge + Tooltip", () => {
  // Mock chrome APIs for icon tests
  const mockSetBadgeText = vi.fn().mockResolvedValue(undefined);
  const mockSetBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
  const mockSetBadgeTextColor = vi.fn().mockResolvedValue(undefined);
  const mockSetTitle = vi.fn().mockResolvedValue(undefined);
  const mockSetIcon = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      action: {
        setBadgeText: mockSetBadgeText,
        setBadgeBackgroundColor: mockSetBadgeBackgroundColor,
        setBadgeTextColor: mockSetBadgeTextColor,
        setTitle: mockSetTitle,
        setIcon: mockSetIcon,
      },
      runtime: { getURL: vi.fn((p: string) => p) },
    });
    vi.clearAllMocks();
  });

  it("setBadgeInfo sets text + color on specific tab", async () => {
    await setBadgeInfo(42, "SERP", "#f97316");
    expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 42, text: "SERP" });
    expect(mockSetBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 42, color: "#f97316" });
  });

  it("setTooltip sets title text on specific tab", async () => {
    await setTooltip(42, "Crawlio | SERP: test");
    expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 42, title: "Crawlio | SERP: test" });
  });

  it("clearBadge removes badge text", async () => {
    await clearBadge(42);
    expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 42, text: "" });
  });
});
