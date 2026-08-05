import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock OffscreenCanvas before importing module
class MockOffscreenCanvas {
  width: number;
  height: number;
  private _ctx: Record<string, unknown>;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this._ctx = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      getImageData: vi.fn(() => ({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4),
      })),
      fillStyle: "",
    };
  }
  getContext() {
    return this._ctx;
  }
}
globalThis.OffscreenCanvas = MockOffscreenCanvas as unknown as typeof OffscreenCanvas;
globalThis.createImageBitmap = vi.fn(async () => ({ width: 32, height: 32, close: vi.fn() })) as unknown as typeof createImageBitmap;

// Mock chrome APIs
const mockSetBadgeText = vi.fn().mockResolvedValue(undefined);
const mockSetBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
const mockSetBadgeTextColor = vi.fn().mockResolvedValue(undefined);
const mockSetTitle = vi.fn().mockResolvedValue(undefined);

globalThis.chrome = {
  runtime: { getURL: vi.fn((path: string) => `chrome-extension://abc/${path}`) },
  action: {
    setIcon: vi.fn().mockResolvedValue(undefined),
    setBadgeText: mockSetBadgeText,
    setBadgeBackgroundColor: mockSetBadgeBackgroundColor,
    setBadgeTextColor: mockSetBadgeTextColor,
    setTitle: mockSetTitle,
  },
} as unknown as typeof chrome;

// Mock fetch for loadBaseIcon
globalThis.fetch = vi.fn(async () => ({
  blob: async () => new Blob(["fake-png"], { type: "image/png" }),
})) as unknown as typeof fetch;

// Mock __DEV__
(globalThis as Record<string, unknown>).__DEV__ = false;

import {
  setBadgeInfo,
  clearBadge,
  setTooltip,
} from "../src/extension/icon-generator";

describe("icon-badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("setBadgeInfo", () => {
    it("calls setBadgeText with tabId and text", async () => {
      await setBadgeInfo(42, "Next");
      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 42, text: "Next" });
    });

    it("calls setBadgeBackgroundColor with default blue", async () => {
      await setBadgeInfo(42, "React");
      expect(mockSetBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 42, color: "#3b82f6" });
    });

    it("calls setBadgeBackgroundColor with custom color", async () => {
      await setBadgeInfo(42, "SERP", "#f97316");
      expect(mockSetBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 42, color: "#f97316" });
    });

    it("calls setBadgeTextColor with white", async () => {
      await setBadgeInfo(42, "Vue");
      expect(mockSetBadgeTextColor).toHaveBeenCalledWith({ tabId: 42, color: "#ffffff" });
    });

    it("does not throw if chrome API fails", async () => {
      mockSetBadgeText.mockRejectedValueOnce(new Error("tab gone"));
      await expect(setBadgeInfo(999, "Test")).resolves.toBeUndefined();
    });
  });

  describe("clearBadge", () => {
    it("sets badge text to empty string", async () => {
      await clearBadge(42);
      expect(mockSetBadgeText).toHaveBeenCalledWith({ tabId: 42, text: "" });
    });

    it("does not throw if chrome API fails", async () => {
      mockSetBadgeText.mockRejectedValueOnce(new Error("tab gone"));
      await expect(clearBadge(999)).resolves.toBeUndefined();
    });
  });

  describe("setTooltip", () => {
    it("calls chrome.action.setTitle with tabId and text", async () => {
      await setTooltip(42, "Crawlio | React 18.2");
      expect(mockSetTitle).toHaveBeenCalledWith({ tabId: 42, title: "Crawlio | React 18.2" });
    });

    it("does not throw if chrome API fails", async () => {
      mockSetTitle.mockRejectedValueOnce(new Error("tab gone"));
      await expect(setTooltip(999, "test")).resolves.toBeUndefined();
    });
  });
});
