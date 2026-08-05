// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { computeXPath } from "../src/xpath";

describe("computeXPath", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("short-circuits on id", () => {
    document.body.innerHTML = '<div><button id="go">Go</button></div>';
    const el = document.getElementById("go")!;
    expect(computeXPath(el)).toBe('//*[@id="go"]');
  });

  it("omits a sibling index when there are no same-named siblings", () => {
    document.body.innerHTML = "<main><section><p>only</p></section></main>";
    const p = document.querySelector("p")!;
    const xp = computeXPath(p)!;
    expect(xp).toBeTruthy();
    expect(xp).not.toContain("["); // no positional index needed
    expect(xp.endsWith("/p")).toBe(true);
  });

  it("adds a 1-based sibling index only when same-named siblings exist", () => {
    document.body.innerHTML = "<ul><li>a</li><li>b</li><li>c</li></ul>";
    const lis = document.querySelectorAll("li");
    expect(computeXPath(lis[0])!).toContain("li[1]");
    expect(computeXPath(lis[1])!).toContain("li[2]");
    expect(computeXPath(lis[2])!).toContain("li[3]");
  });

  it("prefers an optimized attribute anchor over structure", () => {
    document.body.innerHTML = '<div><a data-testid="login">x</a></div>';
    const a = document.querySelector("a")!;
    expect(computeXPath(a, true, ["data-testid"])).toBe(
      '//*[@data-testid="login"]'
    );
  });
});
