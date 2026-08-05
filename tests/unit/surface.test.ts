import { describe, it, expect } from "vitest";
import { describeSurface } from "../../src/mcp-server/surface.js";

/**
 * These assertions are the published numbers. They exist so that changing the tool surface
 * forces a deliberate decision about the documentation that quotes it, rather than letting the
 * two drift apart silently — which is how the README came to carry four different tool counts
 * at once while the startup banner claimed a fifth.
 *
 * If a number here fails, the surface changed. Update the number AND the places that quote it
 * (`npm run check:surface -- --fix` rewrites the README markers).
 */
describe("describeSurface", () => {
  it("reports the tool surface a client actually receives", async () => {
    const s = await describeSurface();

    expect(s.full).toHaveLength(145);
    expect(s.code).toHaveLength(6);
  });

  it("exposes exactly the code-mode tools, with connect_tab shared with full mode", async () => {
    const s = await describeSurface();
    const code = s.code.map((t) => t.name).sort();

    expect(code).toEqual(
      ["cancel_job", "connect_tab", "execute", "get_job_result", "list_jobs", "search"]
    );

    // connect_tab is the one tool present in both modes: code mode still needs a way to attach.
    const full = new Set(s.full.map((t) => t.name));
    expect(code.filter((n) => full.has(n))).toEqual(["connect_tab"]);
  });

  it("indexes every full-mode tool plus the Crawlio HTTP endpoints for search", async () => {
    const s = await describeSurface();

    expect(s.catalog.browser).toBe(145);
    expect(s.catalog.crawlioHttp).toBe(33);
    expect(s.catalog.total).toBe(178);
    expect(s.catalog.total).toBe(s.catalog.browser + s.catalog.crawlioHttp);
  });

  it("describes the smart object at its maximum extent", async () => {
    const s = await describeSurface();

    expect(s.smart.core).toHaveLength(7);
    expect(s.smart.higherOrder).toHaveLength(18);
    expect(s.smart.namespaces).toHaveLength(17);

    expect(s.smart.core).toEqual(
      ["click", "evaluate", "navigate", "rebuild", "snapshot", "type", "waitFor"]
    );
    // Namespaces attach only when detection says so. The description feeds every trigger at
    // once, so a real page always sees a subset of this — hence "up to 17".
    expect(s.smart.namespaces).toContain("react");
    expect(s.smart.namespaces).toContain("wordpress");
  });

  it("never reaches the browser", async () => {
    // The inert bridge rejects anything but framework detection, so a builder that tried to
    // issue a real command during description would fail this rather than hang or silently
    // return an undercounted surface.
    await expect(describeSurface()).resolves.toBeDefined();
  });

  it("returns tools with usable metadata, not bare names", async () => {
    const s = await describeSurface();

    for (const tool of [...s.full, ...s.code]) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});
