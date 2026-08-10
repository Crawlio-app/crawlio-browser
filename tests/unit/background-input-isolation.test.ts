import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const BACKGROUND = readFileSync(resolve(ROOT, "src/extension/background.ts"), "utf8");

function sourceBetween(start: string, end: string): string {
  const startAt = BACKGROUND.indexOf(start);
  const endAt = BACKGROUND.indexOf(end, startAt + start.length);
  expect(startAt, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing source marker: ${end}`).toBeGreaterThan(startAt);
  return BACKGROUND.slice(startAt, endAt);
}

describe("background input isolation", () => {
  it("preserves the background connection bit across navigation metadata refreshes", () => {
    const navigate = sourceBetween('case "browser_navigate":', 'case "browser_click":');
    const navigationComplete = sourceBetween(
      "// Refresh connectedTab storage so get_connection_status returns current URL/favicon",
      "// Clear IDB on navigation only when actively capturing",
    );

    expect(navigate).toContain("...navConnection");
    expect(navigate).toContain("navConnection?.tabId === updated.id");
    expect(navigationComplete).toContain("...conn");
  });

  it("keeps agent-owned URLs usable when Chrome redacts tab metadata without the tabs grant", () => {
    const connect = sourceBetween('case "connect_tab":', 'case "disconnect_tab":');
    const navigate = sourceBetween('case "browser_navigate":', 'case "browser_click":');
    const debuggerRecovery = sourceBetween("async function requireDebuggerTab", "async function enableBackgroundInput");

    expect(connect).toContain('const connectedUrl = tab.url || targetUrl || ""');
    expect(connect).toContain("url: connectedUrl");
    expect(navigate).toContain("const navigatedUrl = updated.url || rawUrl");
    expect(navigate).toContain("url: navigatedUrl");
    expect(debuggerRecovery).toContain("const knownUrl = tab.url ?? conn.url");
    expect(debuggerRecovery).toContain('knownUrl?.startsWith("http")');
  });

  it("preserves the background connection bit across a service-worker restore", () => {
    const restore = sourceBetween("async function restoreState()", "function startPersistTimer()");
    expect(restore).toContain("...connected");
  });

  it("marks an inactive connected create_tab as background-owned", () => {
    const createTab = sourceBetween('case "create_tab":', 'case "close_tab":');
    expect(createTab).toContain("background: command.active === false");
  });

  it("lets browser_wait_for absorb a fresh background tab's pending-URL race", () => {
    const helper = sourceBetween(
      "async function waitForExplicitHttpTabCommit",
      "async function refreshAgentSession",
    );
    const waitFor = sourceBetween('case "wait_for_selector":', "// --- Frame execution context tools ---");

    expect(helper).toContain("tab.pendingUrl");
    expect(helper).toContain('tab.url?.startsWith("http")');
    expect(waitFor.indexOf("waitForExplicitHttpTabCommit(command.tabId")).toBeLessThan(
      waitFor.indexOf("requireDebuggerTab(command)"),
    );
    expect(waitFor).toContain("remainingTimeout");
  });

  it("keeps the left mouse button held throughout a drag gesture", () => {
    const drag = sourceBetween('case "browser_drag":', 'case "browser_file_upload":');
    expect(drag).toContain('type: "mouseMoved", x: zfx, y: zfy, button: "none", buttons: 0');
    expect(drag).toContain('type: "mousePressed", x: zfx, y: zfy, button: "left", buttons: 1');
    expect(drag).toContain('type: "mouseMoved", x: mx, y: my, button: "left", buttons: 1, force: 0.5');
    expect(drag).toContain('type: "mouseReleased", x: ztx, y: zty, button: "left", buttons: 0');
    expect(drag).toContain("await waitForDragFrame()");
  });

  it("uses Chromium's intercepted DataTransfer payload for deterministic HTML5 drops", () => {
    const helper = sourceBetween("async function captureNativeDragData", "function buildModifiers");
    const drag = sourceBetween('case "browser_drag":', 'case "browser_file_upload":');

    expect(helper).toContain('"Input.setInterceptDrags"');
    expect(helper).toContain('method !== "Input.dragIntercepted"');
    expect(drag).toContain('"Input.dispatchDragEvent"');
    expect(drag).toContain('type: "dragEnter"');
    expect(drag).toContain('type: "dragOver"');
    expect(drag).toContain('type: "drop"');
    expect(drag).toContain("if (dragData)");
  });

  it("bounds the optional accessibility snapshot after navigation", () => {
    const navigate = sourceBetween('case "browser_navigate":', 'case "browser_click":');
    expect(navigate).toContain("generateAriaSnapshot(tab.id!, {}, 5000)");
  });

  it("restores the caller's pinned tab before a resident training tab is closed", () => {
    const start = sourceBetween("async function startResidentTraining", "const RESIDENT_STATIC_RESOURCE_TYPES");
    const stop = sourceBetween("async function stopResidentTrainingInternal", "async function stopResidentTraining(");
    const restoreAt = stop.indexOf("restoreResidentPriorConnection(runId)");
    const closeAt = stop.indexOf("chrome.tabs.remove(run.tabId)", restoreAt);

    expect(start).toContain("rememberResidentPriorConnection(runId)");
    expect(restoreAt).toBeGreaterThanOrEqual(0);
    expect(closeAt).toBeGreaterThan(restoreAt);
  });

  it("keeps every real-Chrome MCP harness on agent-owned background tabs", () => {
    for (const filename of [
      "tests/e2e-stress.mjs",
      "tests/e2e-method-mode.mjs",
      "tests/e2e-recording.mjs",
      "tests/e2e-sessions.mjs",
    ]) {
      const source = readFileSync(resolve(ROOT, filename), "utf8");
      const calls = [...source.matchAll(/(?:cmd|callTool|soft)\("connect_tab",\s*\{([^}]*)\}/g)];
      expect(calls.length, `${filename} should exercise connect_tab`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[1], `${filename} must not connect a foreground E2E tab`).toContain("background: true");
      }
    }
  });
});
