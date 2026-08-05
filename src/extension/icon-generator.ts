/// <reference path="../env.d.ts" />
// Runtime icon generation via OffscreenCanvas with colored state indicator dots

export type IconState = "default" | "active" | "framework" | "warning" | "error" | "serp";

export const STATE_COLORS: Record<IconState, string | null> = {
  default: null,        // no overlay
  active: "#22c55e",    // green-500
  framework: "#3b82f6", // blue-500
  warning: "#f59e0b",   // amber-500
  error: "#ef4444",     // red-500
  serp: "#f97316",      // orange-500 — Google SERP detected
};

const baseIconCache = new Map<number, ImageBitmap>();

async function loadBaseIcon(size: number): Promise<ImageBitmap> {
  const cached = baseIconCache.get(size);
  if (cached) return cached;
  const response = await fetch(chrome.runtime.getURL(`icon${size}.png`));
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  baseIconCache.set(size, bitmap);
  return bitmap;
}

export async function generateIcon(size: number, state: IconState): Promise<ImageData> {
  const base = await loadBaseIcon(size);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(base, 0, 0, size, size);

  const color = STATE_COLORS[state];
  if (color) {
    const dotRadius = Math.max(Math.round(size * 0.2), 2);
    const cx = size - dotRadius - 1;
    const cy = size - dotRadius - 1;
    // White border ring for contrast
    ctx.beginPath();
    ctx.arc(cx, cy, dotRadius + 1, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    // Colored dot
    ctx.beginPath();
    ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}

export async function setDynamicIcon(state: IconState, tabId?: number): Promise<void> {
  try {
    const [icon16, icon32] = await Promise.all([
      generateIcon(16, state),
      generateIcon(32, state),
    ]);
    const details: chrome.action.TabIconDetails = {
      imageData: { "16": icon16, "32": icon32 } as unknown as ImageData,
    };
    if (tabId !== undefined) details.tabId = tabId;
    await chrome.action.setIcon(details);
  } catch (err) {
    if (__DEV__) console.warn("[Crawlio] Icon generation failed:", err);
  }
}

export function resetIcon(tabId?: number): void {
  const details: chrome.action.TabIconDetails = {
    path: { "16": "icon16.png", "32": "icon32.png", "48": "icon48.png", "128": "icon128.png" },
  };
  if (tabId !== undefined) details.tabId = tabId;
  chrome.action.setIcon(details).catch(() => {});
}

// --- Badge text system ---

const BADGE_DEFAULT_COLOR = "#3b82f6"; // blue-500
const BADGE_TEXT_COLOR = "#ffffff";

/** Set badge text and background color on the extension icon for a specific tab */
export async function setBadgeInfo(tabId: number, text: string, color?: string): Promise<void> {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: color ?? BADGE_DEFAULT_COLOR }),
      chrome.action.setBadgeTextColor({ tabId, color: BADGE_TEXT_COLOR }),
    ]);
  } catch {
    // Tab may be gone or badge API unavailable
  }
}

/** Clear badge text for a specific tab */
export async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
  } catch {
    // Tab may be gone
  }
}

/** Set the tooltip (title) text for the extension icon on a specific tab */
export async function setTooltip(tabId: number, text: string): Promise<void> {
  try {
    await chrome.action.setTitle({ tabId, title: text });
  } catch {
    // Tab may be gone
  }
}
