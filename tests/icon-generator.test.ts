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
const mockSetIcon = vi.fn().mockResolvedValue(undefined);
globalThis.chrome = {
  runtime: { getURL: vi.fn((path: string) => `chrome-extension://abc/${path}`) },
  action: { setIcon: mockSetIcon },
} as unknown as typeof chrome;

// Mock fetch for loadBaseIcon
globalThis.fetch = vi.fn(async () => ({
  blob: async () => new Blob(["fake-png"], { type: "image/png" }),
})) as unknown as typeof fetch;

// Mock __DEV__
(globalThis as Record<string, unknown>).__DEV__ = false;

import { STATE_COLORS, generateIcon, setDynamicIcon, resetIcon } from "../src/extension/icon-generator";
import type { IconState } from "../src/extension/icon-generator";

describe("icon-generator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("STATE_COLORS", () => {
    it("has an entry for every IconState value", () => {
      const states: IconState[] = ["default", "active", "framework", "warning", "error"];
      for (const state of states) {
        expect(state in STATE_COLORS).toBe(true);
      }
    });

    it("has null for default state", () => {
      expect(STATE_COLORS.default).toBeNull();
    });

    it("has non-null colors for non-default states", () => {
      expect(STATE_COLORS.active).toBe("#22c55e");
      expect(STATE_COLORS.framework).toBe("#3b82f6");
      expect(STATE_COLORS.warning).toBe("#f59e0b");
      expect(STATE_COLORS.error).toBe("#ef4444");
    });
  });

  describe("generateIcon", () => {
    it("returns ImageData with width=16 for size 16", async () => {
      const result = await generateIcon(16, "default");
      expect(result.width).toBe(16);
      expect(result.height).toBe(16);
    });

    it("returns ImageData with width=32 for size 32", async () => {
      const result = await generateIcon(32, "active");
      expect(result.width).toBe(32);
      expect(result.height).toBe(32);
    });

    it("returns valid ImageData for all states", async () => {
      const states: IconState[] = ["default", "active", "framework", "warning", "error"];
      for (const state of states) {
        const result = await generateIcon(16, state);
        expect(result.width).toBe(16);
        expect(result.height).toBe(16);
        expect(result.data).toBeInstanceOf(Uint8ClampedArray);
      }
    });
  });

  describe("setDynamicIcon", () => {
    it("calls chrome.action.setIcon with imageData for sizes 16 and 32", async () => {
      await setDynamicIcon("active");
      expect(mockSetIcon).toHaveBeenCalledTimes(1);
      const call = mockSetIcon.mock.calls[0][0];
      expect(call.imageData).toBeDefined();
      expect(call.imageData["16"]).toBeDefined();
      expect(call.imageData["32"]).toBeDefined();
    });

    it("passes tabId when provided", async () => {
      await setDynamicIcon("active", 42);
      expect(mockSetIcon).toHaveBeenCalledTimes(1);
      const call = mockSetIcon.mock.calls[0][0];
      expect(call.tabId).toBe(42);
    });

    it("does not pass tabId when not provided", async () => {
      await setDynamicIcon("framework");
      const call = mockSetIcon.mock.calls[0][0];
      expect(call.tabId).toBeUndefined();
    });

    it("does not throw on generation failure", async () => {
      // Force createImageBitmap to throw
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => { throw new Error("network error"); }) as unknown as typeof fetch;
      // Clear cache to force re-fetch
      await expect(setDynamicIcon("error")).resolves.toBeUndefined();
      globalThis.fetch = origFetch;
    });
  });

  describe("resetIcon", () => {
    it("calls chrome.action.setIcon with path-based details", () => {
      resetIcon();
      expect(mockSetIcon).toHaveBeenCalledTimes(1);
      const call = mockSetIcon.mock.calls[0][0];
      expect(call.path).toBeDefined();
      expect(call.path["16"]).toBe("icon16.png");
      expect(call.path["32"]).toBe("icon32.png");
      expect(call.path["48"]).toBe("icon48.png");
      expect(call.path["128"]).toBe("icon128.png");
    });

    it("passes tabId when provided", () => {
      resetIcon(42);
      const call = mockSetIcon.mock.calls[0][0];
      expect(call.tabId).toBe(42);
    });

    it("does not pass tabId when not provided", () => {
      resetIcon();
      const call = mockSetIcon.mock.calls[0][0];
      expect(call.tabId).toBeUndefined();
    });
  });
});
