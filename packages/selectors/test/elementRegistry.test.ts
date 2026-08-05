// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolvesExactlyTo,
  queryAll,
  ElementRegistry,
} from "../src/elementRegistry";
import type { SelectorRecord } from "../src/contract";

const css = (value: string): SelectorRecord => ({ type: "css", value });

describe("resolvesExactlyTo (verification oracle)", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<ul id="list"><li class="row pick">A</li><li class="row pick">B</li><li class="row">C</li></ul>';
  });
  const picks = () => Array.from(document.querySelectorAll(".pick"));

  it("accepts a selector that resolves to exactly the expected set", () => {
    expect(resolvesExactlyTo(css(".pick"), picks(), document)).toBe(true);
  });

  it("rejects an OVER-matching selector", () => {
    expect(resolvesExactlyTo(css(".row"), picks(), document)).toBe(false); // 3 vs 2
  });

  it("rejects an UNDER-matching selector", () => {
    expect(
      resolvesExactlyTo(css("#list > li:first-child"), picks(), document)
    ).toBe(false); // 1 vs 2
  });

  it("rejects a same-size but wrong-member set", () => {
    expect(
      resolvesExactlyTo(
        css("#list > li:nth-child(2), #list > li:nth-child(3)"),
        picks(),
        document
      )
    ).toBe(false); // matches [B,C], expected [A,B]
  });

  it("never matches an empty expected set", () => {
    expect(resolvesExactlyTo(css(".pick"), [], document)).toBe(false);
  });

  it("queryAll returns all css matches in document order", () => {
    expect(queryAll(css(".row"), document).length).toBe(3);
    expect(queryAll(css(".pick"), document).length).toBe(2);
  });
});

describe("ElementRegistry", () => {
  beforeEach(() => {
    document.body.innerHTML = '<a id="x">x</a><b id="y">y</b>';
  });

  it("assigns stable ids per element", () => {
    const reg = new ElementRegistry();
    const a = document.getElementById("x")!;
    expect(reg.idFor(a)).toBe("el-1");
    expect(reg.idFor(a)).toBe("el-1");
  });

  it("re-anchors caller-supplied ids and bumps the counter past them", () => {
    const reg = new ElementRegistry();
    const a = document.getElementById("x")!;
    const b = document.getElementById("y")!;
    reg.register(b, "el-9");
    expect(reg.elFor("el-9")).toBe(b);
    expect(reg.idFor(a)).toBe("el-10"); // counter bumped past 9
  });
});
