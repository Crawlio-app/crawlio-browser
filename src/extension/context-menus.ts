/// <reference path="../env.d.ts" />
// Context menu setup and click dispatch. Items form a parentId hierarchy and dispatch by
// id; text-selection entries read info.selectionText.

export const MENU_ITEMS = [
  { id: "crawlio-capture-page", title: "Capture This Page", contexts: ["page"] as chrome.contextMenus.ContextType[] },
  { id: "crawlio-extract-tables", title: "Extract Tables", contexts: ["page"] as chrome.contextMenus.ContextType[] },
  { id: "crawlio-analyze-selection", title: "Analyze Selection", contexts: ["selection"] as chrome.contextMenus.ContextType[] },
  { id: "crawlio-start-recording", title: "Start Recording", contexts: ["page"] as chrome.contextMenus.ContextType[] },
  { id: "crawlio-seo-check", title: "Quick SEO Check", contexts: ["page"] as chrome.contextMenus.ContextType[] },
] as const;

export type MenuItemId = typeof MENU_ITEMS[number]["id"];

/** Check if contextMenus permission is granted */
export async function hasContextMenusPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ permissions: ["contextMenus"] }, (result) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(result);
    });
  });
}

/** Create all context menu items. Call on startup + onInstalled (Chrome clears menus on update).
 * Always removeAll first, then create fresh — creating over an existing id throws. */
export async function setupContextMenus(): Promise<void> {
  const hasPermission = await hasContextMenusPermission();
  if (!hasPermission) return;

  // Clear existing menus before re-creating (idempotent)
  await new Promise<void>((resolve) => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) { /* ignore */ }
      resolve();
    });
  });

  for (const item of MENU_ITEMS) {
    chrome.contextMenus.create(
      { id: item.id, title: item.title, contexts: [...item.contexts] },
      () => { if (chrome.runtime.lastError) { /* ignore duplicate ID errors */ } },
    );
  }
}

/** Dispatch context menu clicks to the appropriate handler.
 * Handlers call into existing Crawlio functions (extractToCrawlio, table detection, recording). */
export function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  handlers: {
    capturePageFn: (tabId: number) => void;
    extractTablesFn: (tabId: number) => void;
    analyzeSelectionFn: (text: string, tabId: number) => void;
    startRecordingFn: (tabId: number) => void;
    seoCheckFn: (tabId: number) => void;
  },
): void {
  const tabId = tab?.id;
  if (tabId === undefined) return;

  switch (info.menuItemId) {
    case "crawlio-capture-page":
      handlers.capturePageFn(tabId);
      break;
    case "crawlio-extract-tables":
      handlers.extractTablesFn(tabId);
      break;
    case "crawlio-analyze-selection":
      if (info.selectionText) {
        handlers.analyzeSelectionFn(info.selectionText, tabId);
      }
      break;
    case "crawlio-start-recording":
      handlers.startRecordingFn(tabId);
      break;
    case "crawlio-seo-check":
      handlers.seoCheckFn(tabId);
      break;
  }
}
