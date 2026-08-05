import { describe, it, expect, vi, beforeEach } from "vitest";
import { MENU_ITEMS, setupContextMenus, handleContextMenuClick, hasContextMenusPermission } from "@/extension/context-menus";

// Mock chrome APIs
const mockCreate = vi.fn((_props: any, cb?: () => void) => { if (cb) cb(); });
const mockRemoveAll = vi.fn((cb: () => void) => cb());
const mockContains = vi.fn((_perms: any, cb: (result: boolean) => void) => cb(true));

vi.stubGlobal("chrome", {
  contextMenus: {
    create: mockCreate,
    removeAll: mockRemoveAll,
  },
  permissions: {
    contains: mockContains,
  },
  runtime: {
    lastError: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  (chrome.runtime as any).lastError = null;
});

describe("MENU_ITEMS", () => {
  it("has 5 menu items", () => {
    expect(MENU_ITEMS).toHaveLength(5);
  });

  it("all items have id and title", () => {
    for (const item of MENU_ITEMS) {
      expect(item.id).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.contexts.length).toBeGreaterThan(0);
    }
  });

  it("has selection context for Analyze Selection", () => {
    const analyzeItem = MENU_ITEMS.find(m => m.id === "crawlio-analyze-selection");
    expect(analyzeItem?.contexts).toContain("selection");
  });
});

describe("hasContextMenusPermission", () => {
  it("returns true when permission granted", async () => {
    mockContains.mockImplementation((_p: any, cb: (r: boolean) => void) => cb(true));
    expect(await hasContextMenusPermission()).toBe(true);
  });

  it("returns false when permission denied", async () => {
    mockContains.mockImplementation((_p: any, cb: (r: boolean) => void) => cb(false));
    expect(await hasContextMenusPermission()).toBe(false);
  });

  it("returns false on runtime error", async () => {
    mockContains.mockImplementation((_p: any, cb: (r: boolean) => void) => {
      (chrome.runtime as any).lastError = { message: "test error" };
      cb(false);
    });
    expect(await hasContextMenusPermission()).toBe(false);
  });
});

describe("setupContextMenus", () => {
  it("creates 5 menu items when permission granted", async () => {
    mockContains.mockImplementation((_p: any, cb: (r: boolean) => void) => cb(true));
    await setupContextMenus();
    expect(mockRemoveAll).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });

  it("skips creation when permission denied", async () => {
    mockContains.mockImplementation((_p: any, cb: (r: boolean) => void) => cb(false));
    await setupContextMenus();
    expect(mockRemoveAll).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes correct ids to chrome.contextMenus.create", async () => {
    mockContains.mockImplementation((_p: any, cb: (r: boolean) => void) => cb(true));
    await setupContextMenus();
    const createdIds = mockCreate.mock.calls.map((call: any[]) => call[0].id);
    expect(createdIds).toEqual([
      "crawlio-capture-page",
      "crawlio-extract-tables",
      "crawlio-analyze-selection",
      "crawlio-start-recording",
      "crawlio-seo-check",
    ]);
  });
});

describe("handleContextMenuClick", () => {
  const handlers = {
    capturePageFn: vi.fn(),
    extractTablesFn: vi.fn(),
    analyzeSelectionFn: vi.fn(),
    startRecordingFn: vi.fn(),
    seoCheckFn: vi.fn(),
  };

  beforeEach(() => {
    Object.values(handlers).forEach(fn => fn.mockClear());
  });

  const makeInfo = (menuItemId: string, selectionText?: string): chrome.contextMenus.OnClickData => ({
    menuItemId,
    editable: false,
    pageUrl: "https://example.com",
    selectionText,
  });

  const tab = { id: 42 } as chrome.tabs.Tab;

  it("dispatches capture-page", () => {
    handleContextMenuClick(makeInfo("crawlio-capture-page"), tab, handlers);
    expect(handlers.capturePageFn).toHaveBeenCalledWith(42);
  });

  it("dispatches extract-tables", () => {
    handleContextMenuClick(makeInfo("crawlio-extract-tables"), tab, handlers);
    expect(handlers.extractTablesFn).toHaveBeenCalledWith(42);
  });

  it("dispatches analyze-selection with text", () => {
    handleContextMenuClick(makeInfo("crawlio-analyze-selection", "selected text"), tab, handlers);
    expect(handlers.analyzeSelectionFn).toHaveBeenCalledWith("selected text", 42);
  });

  it("skips analyze-selection without selectionText", () => {
    handleContextMenuClick(makeInfo("crawlio-analyze-selection"), tab, handlers);
    expect(handlers.analyzeSelectionFn).not.toHaveBeenCalled();
  });

  it("dispatches start-recording", () => {
    handleContextMenuClick(makeInfo("crawlio-start-recording"), tab, handlers);
    expect(handlers.startRecordingFn).toHaveBeenCalledWith(42);
  });

  it("dispatches seo-check", () => {
    handleContextMenuClick(makeInfo("crawlio-seo-check"), tab, handlers);
    expect(handlers.seoCheckFn).toHaveBeenCalledWith(42);
  });

  it("does nothing for undefined tab", () => {
    handleContextMenuClick(makeInfo("crawlio-capture-page"), undefined, handlers);
    expect(handlers.capturePageFn).not.toHaveBeenCalled();
  });

  it("does nothing for unknown menu item id", () => {
    handleContextMenuClick(makeInfo("unknown-id"), tab, handlers);
    Object.values(handlers).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });
});
