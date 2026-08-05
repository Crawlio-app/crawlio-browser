// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { buildInspectionView } from "../src/inspectionView";

describe("buildInspectionView", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("prunes script/style/noscript and stamps element_id on targets", () => {
    document.body.innerHTML =
      '<div id="wrap"><script>var x=1;</script><style>.a{color:red}</style><noscript>n</noscript><button id="t">Hi</button></div>';
    const el = document.getElementById("t")!;
    const out = buildInspectionView([{ el, id: "el-1" }]);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("<noscript");
    expect(out).toContain('element_id="el-1"');
    expect(out.toLowerCase()).toContain("button");
  });

  it("caps output at 250KB with a truncation marker", () => {
    document.body.innerHTML = "<div>" + "x".repeat(300_000) + "</div>";
    const out = buildInspectionView([]);
    expect(out.length).toBeGreaterThan(250_000);
    expect(out.length).toBeLessThanOrEqual(250_000 + 40);
    expect(out.trimEnd().endsWith("inspection view truncated -->")).toBe(true);
  });
});
