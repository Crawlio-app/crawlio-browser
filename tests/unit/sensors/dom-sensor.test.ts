import { describe, it, expect } from "vitest";
import {
  SKIP_TAGS,
  MAX_TEXT_LENGTH,
  MAX_ATTR_LENGTH,
  DEFAULT_MAX_DEPTH,
  MAX_SNAPSHOT_SIZE,
  EVENT_HANDLER_ATTRS,
} from "@/extension/sensors/dom-sensor";
import type { DOMNode } from "@/extension/sensors/dom-sensor";
describe("DOM sensor constants", () => {
  it("SKIP_TAGS includes script and style", () => {
    expect(SKIP_TAGS).toContain("SCRIPT");
    expect(SKIP_TAGS).toContain("STYLE");
    expect(SKIP_TAGS).toContain("SVG");
    expect(SKIP_TAGS).toContain("NOSCRIPT");
  });

  it("MAX_SNAPSHOT_SIZE is 5MB", () => {
    expect(MAX_SNAPSHOT_SIZE).toBe(5 * 1024 * 1024);
  });

  it("DEFAULT_MAX_DEPTH is 10", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(10);
  });

  it("text and attr length limits are reasonable", () => {
    expect(MAX_TEXT_LENGTH).toBe(200);
    expect(MAX_ATTR_LENGTH).toBe(500);
  });
});

describe("EVENT_HANDLER_ATTRS regex", () => {
  it("matches onclick", () => {
    expect(EVENT_HANDLER_ATTRS.test("onclick")).toBe(true);
  });

  it("matches onmouseover", () => {
    expect(EVENT_HANDLER_ATTRS.test("onmouseover")).toBe(true);
  });

  it("does not match class", () => {
    expect(EVENT_HANDLER_ATTRS.test("class")).toBe(false);
  });

  it("does not match data-onclick", () => {
    expect(EVENT_HANDLER_ATTRS.test("data-onclick")).toBe(false);
  });
});

describe("DOMNode type", () => {
  it("accepts minimal node", () => {
    const node: DOMNode = { tag: "div" };
    expect(node.tag).toBe("div");
  });

  it("accepts node with children and shadow root marker", () => {
    const node: DOMNode = {
      tag: "div",
      attrs: { class: "container" },
      children: [{ tag: "span", text: "hello" }],
      isShadowRoot: false,
    };
    expect(node.children).toHaveLength(1);
  });
});
