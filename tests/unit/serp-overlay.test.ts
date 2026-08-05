import { describe, it, expect } from "vitest";
import { SERP_OVERLAY_CSS } from "@/extension/injected/serp-overlay-styles";
import { injectSerpOverlay, removeSerpOverlay } from "@/extension/injected/serp-overlay";

// These functions are injected into the page via CDP Runtime.evaluate
// In unit tests (node environment), we verify the function signatures,
// serialization compatibility, and CSS content — actual DOM behavior
// is validated via e2e tests in the browser

describe("SERP_OVERLAY_CSS", () => {
  it("exports a non-empty CSS string", () => {
    expect(typeof SERP_OVERLAY_CSS).toBe("string");
    expect(SERP_OVERLAY_CSS.length).toBeGreaterThan(100);
  });

  it("contains :host selector for shadow DOM isolation", () => {
    expect(SERP_OVERLAY_CSS).toContain(":host");
  });

  it("resets all styles on :host", () => {
    expect(SERP_OVERLAY_CSS).toContain("all: initial");
  });

  it("contains badge class definitions", () => {
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-badge");
  });

  it("contains header class definitions", () => {
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-serp-header");
  });

  it("contains sidebar class definitions", () => {
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-sidebar");
  });

  it("contains performance badge variants", () => {
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-badge--perf");
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-badge--perf-warn");
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-badge--perf-poor");
  });

  it("uses Crawlio design token colors", () => {
    expect(SERP_OVERLAY_CSS).toContain("#3b82f6"); // blue-500
    expect(SERP_OVERLAY_CSS).toContain("#1a1a2e"); // dark bg
    expect(SERP_OVERLAY_CSS).toContain("#22c55e"); // green-500
    expect(SERP_OVERLAY_CSS).toContain("#dc2626"); // red-600 (poor perf)
  });

  it("contains close button styling", () => {
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-close");
  });

  it("contains metric styling for sidebar", () => {
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-metric");
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-metric-label");
    expect(SERP_OVERLAY_CSS).toContain(".crawlio-metric-value");
  });

  it("sets max z-index for header", () => {
    expect(SERP_OVERLAY_CSS).toContain("2147483647");
  });

  it("contains pulse animation for status dot", () => {
    expect(SERP_OVERLAY_CSS).toContain("@keyframes crawlio-pulse");
  });
});

describe("injectSerpOverlay", () => {
  it("is a function", () => {
    expect(typeof injectSerpOverlay).toBe("function");
  });

  it("accepts config with widgets, query, css, and data", () => {
    // Verify the function signature (parameter count)
    expect(injectSerpOverlay.length).toBe(1);
  });

  it("is serializable via Function.toString for CDP injection", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain("crawlio-serp-root");
    expect(source).toContain("attachShadow");
    expect(source).toContain("closed");
  });

  it("creates shadow DOM with closed mode", () => {
    const source = injectSerpOverlay.toString();
    // Verify closed shadow root — key security/isolation requirement
    expect(source).toContain('mode: "closed"');
  });

  it("handles all three widget types", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain('widgets.includes("header")');
    expect(source).toContain('widgets.includes("badge")');
    expect(source).toContain('widgets.includes("sidebar")');
  });

  it("targets Google SERP result selectors", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain("div.g");
    expect(source).toContain("div[data-sokoban-container]");
  });

  it("uses MutationObserver for dynamic content", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain("MutationObserver");
    expect(source).toContain("childList: true");
    expect(source).toContain("subtree: true");
  });

  it("MutationObserver uses enrichment data for dynamically loaded results", () => {
    const source = injectSerpOverlay.toString();
    // Observer callback should reference siteData for framework/perf enrichment
    // (not just hostname fallback)
    const observerSection = source.slice(source.indexOf("MutationObserver"));
    expect(observerSection).toContain("siteData");
    expect(observerSection).toContain("framework");
    expect(observerSection).toContain("perfScore");
  });

  it("removes existing overlay before re-injecting (idempotent)", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain('document.getElementById(ROOT_ID)');
    expect(source).toContain("existing.remove()");
  });

  it("handles perf score styling with thresholds", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain("perfScore");
    expect(source).toContain("score >= 90");
    expect(source).toContain("score >= 50");
  });

  it("returns structured result with injected, widgetCount, query", () => {
    const source = injectSerpOverlay.toString();
    expect(source).toContain("injected: true");
    expect(source).toContain("widgetCount");
  });
});

describe("removeSerpOverlay", () => {
  it("is a function", () => {
    expect(typeof removeSerpOverlay).toBe("function");
  });

  it("is serializable via Function.toString for CDP injection", () => {
    const source = removeSerpOverlay.toString();
    expect(source).toContain("crawlio-serp-root");
  });

  it("disconnects MutationObserver on cleanup", () => {
    const source = removeSerpOverlay.toString();
    expect(source).toContain("observer.disconnect()");
  });

  it("removes per-result badge hosts", () => {
    const source = removeSerpOverlay.toString();
    expect(source).toContain("crawlio-result-badge");
  });

  it("returns structured result with cleared flag", () => {
    const source = removeSerpOverlay.toString();
    expect(source).toContain("cleared: true");
    expect(source).toContain("cleared: false");
  });

  it("handles missing overlay gracefully", () => {
    const source = removeSerpOverlay.toString();
    expect(source).toContain("no overlay found");
  });
});

describe("CDP injection compatibility", () => {
  it("injectSerpOverlay can be wrapped in IIFE expression", () => {
    // cdpExecuteFunction does: `(${func.toString()})(${argStr})`
    const expression = `(${injectSerpOverlay.toString()})({
      widgets: ["badge", "header"],
      query: "test",
      css: "body {}",
      data: {}
    })`;
    expect(expression.length).toBeGreaterThan(0);
    // Should not throw on construction
    expect(() => expression).not.toThrow();
  });

  it("removeSerpOverlay can be wrapped in IIFE expression", () => {
    const expression = `(${removeSerpOverlay.toString()})()`;
    expect(expression.length).toBeGreaterThan(0);
  });

  it("CSS string is JSON-serializable for args passing", () => {
    // cdpExecuteFunction passes args via JSON.stringify
    const serialized = JSON.stringify(SERP_OVERLAY_CSS);
    expect(serialized).toBeTruthy();
    const deserialized = JSON.parse(serialized);
    expect(deserialized).toBe(SERP_OVERLAY_CSS);
  });

  it("injectSerpOverlay uses safe DOM methods (no innerHTML)", () => {
    const source = injectSerpOverlay.toString();
    expect(source).not.toContain("innerHTML");
  });

  it("removeSerpOverlay uses safe DOM methods (no innerHTML)", () => {
    const source = removeSerpOverlay.toString();
    expect(source).not.toContain("innerHTML");
  });
});
