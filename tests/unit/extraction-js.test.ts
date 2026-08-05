import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import type { TableCandidate, TableExtraction, PageSections } from "@/shared/evidence-types";
import {
  EXTRACTION_HELPERS_JS,
  MAX_EXTRACTION_PROGRAM_CHARS,
  buildDetectTablesJs,
  buildExtractTableJs,
  buildDetectSectionsJs,
} from "@/mcp-server/extraction-js";

// jsdom is in the tree via @crawlio/selectors but ships no bundled types — narrow local typing.
const nodeRequire = createRequire(import.meta.url);
interface JsdomInstance {
  window: {
    document: Document;
    HTMLElement: { prototype: HTMLElement };
    Element: { prototype: Element };
    innerWidth: number;
    innerHeight: number;
    location: { href: string };
  };
}
const { JSDOM } = nodeRequire("jsdom") as { JSDOM: new (html: string, opts?: { url?: string; contentType?: string }) => JsdomInstance };

/** Parse the trailing `})(<json args>)` of a generated program. */
function extractionArgs(program: string): unknown[] {
  const start = program.lastIndexOf("})(");
  const end = program.lastIndexOf(")");
  if (start < 0 || end <= start + 2) return [];
  return JSON.parse(`[${program.slice(start + 3, end)}]`);
}

const ALL_BUILDERS: Array<{ name: string; sentinel: string; build: () => string }> = [
  { name: "detect-tables", sentinel: "/*crawlio:detect-tables*/", build: () => buildDetectTablesJs() },
  { name: "extract-table", sentinel: "/*crawlio:extract-table*/", build: () => buildExtractTableJs("div.grid") },
  { name: "detect-sections", sentinel: "/*crawlio:detect-sections*/", build: () => buildDetectSectionsJs() },
];

describe("extraction program contract", () => {
  it.each(ALL_BUILDERS)("$name starts with its sentinel comment", ({ sentinel, build }) => {
    expect(build().startsWith(sentinel)).toBe(true);
  });

  it.each(ALL_BUILDERS)("$name stays under the 10,000-char budget", ({ build }) => {
    expect(build().length).toBeLessThan(MAX_EXTRACTION_PROGRAM_CHARS);
  });

  it("stays under budget with maximal options and a worst-case selector", () => {
    expect(buildDetectTablesJs({ maxCandidates: 20 }).length).toBeLessThan(MAX_EXTRACTION_PROGRAM_CHARS);
    // selectorSchema caps selectors at 1000 chars; a quote-heavy one doubles under JSON escaping
    expect(buildExtractTableJs('"'.repeat(1000), { maxRows: 1000 }).length).toBeLessThan(MAX_EXTRACTION_PROGRAM_CHARS);
    expect(buildDetectSectionsJs({ maxDepth: 5, maxSections: 100 }).length).toBeLessThan(MAX_EXTRACTION_PROGRAM_CHARS);
  });

  it.each(ALL_BUILDERS)("$name is syntactically valid JavaScript", ({ build }) => {
    expect(() => new Function(build())).not.toThrow();
  });

  it.each(ALL_BUILDERS)("$name includes the shared getClasses helper exactly once", ({ build }) => {
    expect(build().split("function getClasses(").length - 1).toBe(1);
  });

  it("each program embeds only the helpers it calls (size budget)", () => {
    const detect = buildDetectTablesJs();
    expect(detect).toContain("function getMatchingChildren(");
    expect(detect).toContain("function buildSelector(");
    expect(detect).not.toContain("function extractRow(");
    const extract = buildExtractTableJs("div");
    expect(extract).toContain("function getMatchingChildren(");
    expect(extract).toContain("function extractRow(");
    expect(extract).not.toContain("function buildSelector(");
    const sections = buildDetectSectionsJs();
    expect(sections).toContain("function buildSelector(");
    expect(sections).toContain("function verifySelector(");
    expect(sections).not.toContain("function extractRow(");
  });

  it.each(ALL_BUILDERS)("$name has no unexpanded template interpolations", ({ build }) => {
    expect(build()).not.toContain("${");
  });

  it("helpers block defines all five shared helpers plus the uniqueness check", () => {
    for (const fn of ["getClasses", "getMatchingChildren", "buildSelector", "directText", "extractRow", "verifySelector"]) {
      expect(EXTRACTION_HELPERS_JS).toContain(`function ${fn}(`);
    }
  });

  it("verifies selectors with the inline uniqueness check, not the selector-kernel prelude", () => {
    // The ~17KB kernel prelude would blow the program budget; the contract is the
    // compact querySelectorAll-length-1 + identity check.
    expect(EXTRACTION_HELPERS_JS).toContain("m.length === 1 && m[0] === el");
    expect(buildDetectSectionsJs()).not.toContain("__crawlioForge");
  });
});

describe("options embedding", () => {
  it("detect-tables options round-trip through the trailing JSON literal", () => {
    const program = buildDetectTablesJs({ maxCandidates: 7 });
    const [opts] = extractionArgs(program) as [{ maxCandidates: number }];
    expect(opts).toEqual({ maxCandidates: 7 });
  });

  it("detect-tables applies defaults and clamps out-of-range values", () => {
    expect(extractionArgs(buildDetectTablesJs())[0]).toEqual({ maxCandidates: 5 });
    expect(extractionArgs(buildDetectTablesJs({ maxCandidates: 999 }))[0]).toEqual({ maxCandidates: 20 });
    expect(extractionArgs(buildDetectTablesJs({ maxCandidates: -3 }))[0]).toEqual({ maxCandidates: 1 });
  });

  it("options appear only in the trailing literal, never interpolated into the body", () => {
    const program = buildDetectTablesJs({ maxCandidates: 17 });
    const body = program.slice(0, program.lastIndexOf("})("));
    expect(body).not.toContain("17");
    const sections = buildDetectSectionsJs({ maxDepth: 3, maxSections: 61 });
    expect(sections.slice(0, sections.lastIndexOf("})("))).not.toContain("61");
  });

  it("extract-table options round-trip and defaults apply", () => {
    const program = buildExtractTableJs("ul.items", { maxRows: 42 });
    const [selector, opts] = extractionArgs(program) as [string, { maxRows: number }];
    expect(selector).toBe("ul.items");
    expect(opts).toEqual({ maxRows: 42 });
    expect(extractionArgs(buildExtractTableJs("ul.items"))[1]).toEqual({ maxRows: 200 });
    expect(extractionArgs(buildExtractTableJs("ul.items", { maxRows: 5000 }))[1]).toEqual({ maxRows: 1000 });
  });

  it("detect-sections options round-trip and clamp", () => {
    const [opts] = extractionArgs(buildDetectSectionsJs({ maxDepth: 4, maxSections: 12 })) as [{ maxDepth: number; maxSections: number }];
    expect(opts).toEqual({ maxDepth: 4, maxSections: 12 });
    expect(extractionArgs(buildDetectSectionsJs())[0]).toEqual({ maxDepth: 2, maxSections: 40 });
    expect(extractionArgs(buildDetectSectionsJs({ maxDepth: 99, maxSections: 9999 }))[0]).toEqual({ maxDepth: 5, maxSections: 100 });
  });

  it("non-finite option values fall back to defaults", () => {
    expect(extractionArgs(buildDetectTablesJs({ maxCandidates: NaN }))[0]).toEqual({ maxCandidates: 5 });
    expect(extractionArgs(buildExtractTableJs("d", { maxRows: Infinity }))[1]).toEqual({ maxRows: 200 });
  });
});

describe("selector escaping", () => {
  it("embeds the selector with JSON.stringify escaping", () => {
    const tricky = `div[data-name="a\\"b"] > span.price`;
    const program = buildExtractTableJs(tricky);
    expect(program).toContain(JSON.stringify(tricky));
    const [selector] = extractionArgs(program) as [string];
    expect(selector).toBe(tricky);
  });

  it("neutralizes script-breaking selectors", () => {
    const hostile = `</script><script>alert(1)</script>`;
    const program = buildExtractTableJs(hostile);
    // Raw closing tag must not survive outside the JSON string literal
    expect(program).toContain(JSON.stringify(hostile));
    expect(() => new Function(program)).not.toThrow();
    const [selector] = extractionArgs(program) as [string];
    expect(selector).toBe(hostile);
  });

  it("round-trips unicode and newline selectors", () => {
    const weird = "div.café\n[title='a b']";
    const program = buildExtractTableJs(weird);
    expect(() => new Function(program)).not.toThrow();
    const [selector] = extractionArgs(program) as [string];
    expect(selector).toBe(weird);
  });
});

describe("generated detection logic (structural)", () => {
  it("detect-tables carries both strategies and the geometric/native markers", () => {
    const program = buildDetectTablesJs();
    expect(program).toContain("'table-rows'");
    expect(program).toContain("'sibling-repeated-blocks'");
    expect(program).toContain("no header row found");
    expect(program).toContain("row heights inconsistent");
    expect(program).toContain("container exceeds child cap");
  });

  it("detect-tables has a node-count bail-out", () => {
    expect(buildDetectTablesJs()).toContain("MAX_SCAN");
  });

  it("extract-table degrades row cap on huge subtrees", () => {
    expect(buildExtractTableJs("div")).toContain("40000");
  });

  it("detect-sections has a visit-count bail-out", () => {
    expect(buildDetectSectionsJs()).toContain("MAX_VISIT");
  });

  it("detect-sections covers the full taxonomy", () => {
    const program = buildDetectSectionsJs();
    // 8 ARIA landmark roles (same set as tools.ts summarizeAccessibility)
    for (const role of ["banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region"]) {
      expect(program).toContain(role);
    }
    for (const attr of ["data-component", "data-testid", "data-section", "data-block", "data-module"]) {
      expect(program).toContain(attr);
    }
    // semantic tags + class-hint sources
    for (const source of ["semantic-tag", "aria-landmark", "data-attr", "class-hint"]) {
      expect(program).toContain(`'${source}'`);
    }
  });

  it("detect-sections emits selectors, never snapshot refs", () => {
    const program = buildDetectSectionsJs();
    expect(program).toContain("selectorVerified");
    expect(program).not.toContain("[ref=");
    expect(program).not.toContain("refMap");
  });

  it("extract-table handles native tables (header promotion + url companions)", () => {
    const program = buildExtractTableJs("table.data");
    expect(program).toContain("thead th");
    expect(program).toContain("_url");
    expect(program).toContain("'TABLE'");
  });
});

// ============================================================
// DOM execution — run the real generated programs against jsdom
// ============================================================

/**
 * Execute a generated program against a jsdom document. jsdom has no layout, so
 * offsetWidth/offsetHeight/getBoundingClientRect are patched to read data-w/data-h
 * attributes (defaults 500x100) — this lets the geometric filters run deterministically.
 * CSS.escape is absent in jsdom; a minimal shim is passed instead.
 */
function runProgramIn<T>(program: string, dom: JsdomInstance): T {
  const win = dom.window;
  const sizeOf = (el: Element, attr: string, fallback: number): number => {
    const v = el.getAttribute(attr);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", {
    get(this: HTMLElement) { return sizeOf(this, "data-w", 500); },
    configurable: true,
  });
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    get(this: HTMLElement) { return sizeOf(this, "data-h", 100); },
    configurable: true,
  });
  win.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const width = sizeOf(this, "data-w", 500);
    const height = sizeOf(this, "data-h", 100);
    return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
  };
  const cssShim = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
  const fn = new Function("document", "window", "location", "CSS", `return (${program});`);
  return fn(win.document, win, win.location, cssShim) as T;
}

function runProgram<T>(program: string, html: string): T {
  return runProgramIn(program, new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.com/page" }));
}

describe("detect-tables against a real DOM", () => {
  it("finds a native <table> via the fast path with thead headers", () => {
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <table id="t">
        <thead><tr><th>Name</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Alpha</td><td>$10</td></tr>
          <tr><td>Beta</td><td>$20</td></tr>
          <tr><td>Gamma</td><td>$30</td></tr>
        </tbody>
      </table>`);
    expect(result.length).toBe(1);
    const t = result[0];
    expect(t.strategy).toBe("table-rows");
    expect(t.rowCount).toBe(3);
    expect(t.confidence).toBeGreaterThanOrEqual(0.82);
    expect(t.confidence).toBeLessThanOrEqual(0.9);
    expect(t.warnings).not.toContain("no header row found");
    expect(t.selector).toContain("t");
    expect(t.sampleText).toContain("Alpha");
  });

  it("warns when a native table has no header row", () => {
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <table><tbody>
        <tr><td>A</td><td>B</td></tr>
        <tr><td>C</td><td>D</td></tr>
      </tbody></table>`);
    expect(result.length).toBe(1);
    expect(result[0].warnings).toContain("no header row found");
  });

  it("promotes an all-th first row to headers (not counted as data)", () => {
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <table><tbody>
        <tr><th>H1</th><th>H2</th></tr>
        <tr><td>A</td><td>B</td></tr>
        <tr><td>C</td><td>D</td></tr>
      </tbody></table>`);
    expect(result.length).toBe(1);
    expect(result[0].rowCount).toBe(2);
    expect(result[0].warnings).not.toContain("no header row found");
  });

  it("ranks the table with the most rows first", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `<tr><td>r${i}</td><td>x</td></tr>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <table id="small"><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${rows(3)}</tbody></table>
      <table id="big"><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${rows(9)}</tbody></table>`);
    expect(result.length).toBe(2);
    expect(result[0].selector).toContain("big");
    expect(result[0].rowCount).toBe(9);
  });

  it("native tables outrank div-soup candidates", () => {
    const cards = Array.from({ length: 8 }, (_, i) => `<div class="card"><h3 class="title">Item ${i}</h3><span class="price">$${i}.99</span></div>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <div id="grid" data-w="1200" data-h="2000">${cards}</div>
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>
        <tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr>
      </tbody></table>`);
    expect(result[0].strategy).toBe("table-rows");
    const soup = result.find(c => c.strategy === "sibling-repeated-blocks");
    expect(soup).toBeTruthy();
    expect(soup!.confidence).toBeLessThan(result[0].confidence);
  });

  it("detects div-soup with the documented confidence formula", () => {
    const cards = Array.from({ length: 4 }, (_, i) => `<div class="card"><h3 class="title">Item ${i}</h3><span class="price">$${i}.99</span></div>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `<div id="list">${cards}</div>`);
    const list = result.find(c => c.selector.includes("list"));
    expect(list).toBeTruthy();
    expect(list!.strategy).toBe("sibling-repeated-blocks");
    expect(list!.rowCount).toBe(4);
    // 0.55 + min(4,12)*0.015 + 2 leaf columns * 0.025 = 0.66
    expect(list!.confidence).toBeCloseTo(0.66, 3);
    expect(list!.confidence).toBeLessThanOrEqual(0.78);
  });

  it("filters rows outside 30% of the median height and warns", () => {
    const row = (h: number, i: number) => `<div class="r" data-h="${h}"><span class="a">Item ${i}</span></div>`;
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <div id="list">${row(100, 1)}${row(100, 2)}${row(100, 3)}${row(300, 4)}</div>`);
    const list = result.find(c => c.selector.includes("list"));
    expect(list).toBeTruthy();
    expect(list!.rowCount).toBe(3);
    expect(list!.warnings).toContain("row heights inconsistent");
  });

  it("skips containers with more than 300 children (virtualized-list guard)", () => {
    const rows = Array.from({ length: 301 }, (_, i) => `<div class="r">Item ${i}</div>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `<div id="huge">${rows}</div>`);
    expect(result.find(c => c.selector.includes("huge"))).toBeUndefined();
  });

  it("does not re-propose table internals through the div-soup path", () => {
    const rows = Array.from({ length: 6 }, (_, i) => `<tr class="row"><td>a${i}</td><td>b${i}</td></tr>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${rows}</tbody></table>`);
    expect(result.length).toBe(1);
    expect(result[0].strategy).toBe("table-rows");
  });

  it("respects maxCandidates", () => {
    const mk = (id: string, n: number) => `<table id="${id}"><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${Array.from({ length: n }, () => "<tr><td>x</td><td>y</td></tr>").join("")}</tbody></table>`;
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs({ maxCandidates: 2 }), mk("a", 2) + mk("b", 3) + mk("c", 4));
    expect(result.length).toBe(2);
  });
});

describe("extract-table against a real DOM", () => {
  it("promotes thead th to column names with _url companions", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("#t"), `
      <table id="t">
        <thead><tr><th>Name</th><th>Price (USD)</th><th>Link</th></tr></thead>
        <tbody>
          <tr><td>Alpha</td><td>$10</td><td><a href="/a">open</a></td></tr>
          <tr><td>Beta</td><td>$20</td><td><a href="/b">open</a></td></tr>
        </tbody>
      </table>`);
    const names = result.columns.map(c => c.name);
    expect(names).toEqual(["name", "price_usd", "link", "link_url"]);
    expect(result.columns.find(c => c.name === "name")!.path).toBe("td:0");
    expect(result.rows[0].name).toBe("Alpha");
    expect(result.rows[0].price_usd).toBe("$10");
    expect(result.rows[0].link_url).toBe("https://example.com/a");
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("falls back to col_N names when a table has no headers", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("table"), `
      <table><tbody>
        <tr><td>A</td><td>B</td></tr>
        <tr><td>C</td><td>D</td></tr>
      </tbody></table>`);
    expect(result.columns.map(c => c.name)).toEqual(["col_1", "col_2"]);
    expect(result.rows[1].col_2).toBe("D");
  });

  it("descends into a wrapper with a single child table", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("#wrap"), `
      <div id="wrap"><table>
        <thead><tr><th>K</th><th>V</th></tr></thead>
        <tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody>
      </table></div>`);
    expect(result.columns.map(c => c.name)).toEqual(["k", "v"]);
    expect(result.rows.length).toBe(2);
  });

  it("truncates native tables at maxRows", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `<tr><td>r${i}</td><td>x${i}</td></tr>`).join("");
    const result = runProgram<TableExtraction>(buildExtractTableJs("table", { maxRows: 4 }), `
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>${rows}</tbody></table>`);
    expect(result.totalRows).toBe(10);
    expect(result.rows.length).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("names div-soup columns semantically with link-first ordering and preserved paths", () => {
    const item = (n: number, story: string, price: string, src: string) =>
      `<div class="item"><a class="storylink" href="/s${n}">${story}</a><span class="s-item__price">${price}</span><span class="from">${src}</span></div>`;
    const result = runProgram<TableExtraction>(buildExtractTableJs("#grid"), `
      <div id="grid">
        ${item(1, "First Story", "$19.99", "example.com")}
        ${item(2, "Second Story", "$25.50", "github.io")}
        ${item(3, "Third Story", "$7.00", "news.example.org")}
      </div>`);
    const names = result.columns.map(c => c.name);
    // anchor text column + its _url companion lead; BEM class collapses to "price"
    // via content hint; domain-looking values become source_domain
    expect(names[0]).toBe("storylink");
    expect(names[1]).toBe("storylink_url");
    expect(names).toContain("price");
    expect(names).toContain("source_domain");
    expect(result.columns.find(c => c.name === "storylink")!.path).toBe("/div.item/a.storylink");
    expect(result.columns.find(c => c.name === "storylink_url")!.path).toBe("/div.item/a.storylink href");
    expect(result.rows[0].storylink).toBe("First Story");
    expect(result.rows[0].storylink_url).toBe("https://example.com/s1");
    expect(result.rows[2].price).toBe("$7.00");
    expect(result.rows[1].source_domain).toBe("github.io");
  });

  it("names a class-less first link column 'title'", () => {
    const row = (n: number, t: string, d: string) => `<div class="row"><a href="/i${n}">${t}</a><span>(${d})</span></div>`;
    const result = runProgram<TableExtraction>(buildExtractTableJs("#hn"), `
      <div id="hn">${row(1, "Item One", "sub.example.com")}${row(2, "Item Two", "docs.example.io")}${row(3, "Item Three", "example.net")}</div>`);
    const names = result.columns.map(c => c.name);
    expect(names[0]).toBe("title");
    expect(names[1]).toBe("title_url");
    expect(names).toContain("source_domain");
    expect(result.rows[0].title).toBe("Item One");
  });

  it("returns the empty shape for a missing container", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("#nope"), `<div>nothing</div>`);
    expect(result).toEqual({ selector: "#nope", columns: [], rows: [], totalRows: 0, truncated: false });
  });

  it("returns the empty shape for an invalid selector instead of throwing", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("div[["), `<div>nothing</div>`);
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});

describe("detect-sections against a real DOM", () => {
  const PAGE = `
    <header data-h="80"><h1>Site Title</h1><a href="/home">Home</a></header>
    <nav aria-label="Main menu" data-h="60"><a href="/a">A</a><a href="/b">B</a><button>Menu</button></nav>
    <main data-h="900">
      <h2>Products</h2>
      <section data-h="400"><h3>Grid</h3><a href="/p1">P1</a></section>
      <div class="ProductCard" data-h="300"><h3>Widget</h3><button>Buy</button></div>
      <div class="card" data-h="200"><div class="card__header">CH</div><input type="text"></div>
      <div role="search" data-h="100"><input type="search"></div>
      <div data-component="Recommendations" data-h="150"><h4>Recs</h4></div>
    </main>
    <footer data-h="120">Footer text</footer>`;

  it("detects semantic tags, landmarks, data attrs, and class hints", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), PAGE);
    const roots = result.sections;
    expect(roots.map(s => s.role)).toEqual(["header", "nav", "main", "footer"]);
    expect(roots.every(s => s.source === "semantic-tag")).toBe(true);
    const main = roots[2];
    const childRoles = main.children.map(c => `${c.source}:${c.role}`);
    expect(childRoles).toEqual([
      "semantic-tag:section",
      "class-hint:ProductCard",
      "class-hint:card",
      "aria-landmark:search",
      "data-attr:component",
    ]);
    expect(result.totalDetected).toBe(9);
    expect(result.truncated).toBe(false);
  });

  it("resolves names via aria-label > data-component > first heading", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), PAGE);
    const [header, nav, main] = result.sections;
    expect(nav.name).toBe("Main menu");
    expect(header.name).toBe("Site Title");
    expect(main.name).toBe("Products");
    const recs = main.children.find(c => c.source === "data-attr");
    expect(recs!.name).toBe("Recommendations");
  });

  it("emits verified unique selectors and box/interaction stats", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), PAGE);
    const nav = result.sections[1];
    expect(nav.selector).toBe("nav");
    expect(nav.selectorVerified).toBe(true);
    expect(nav.interactiveCount).toBe(3);
    expect(nav.box.height).toBe(60);
    expect(nav.inViewport).toBe(true);
    expect(nav.selector.startsWith("[ref=")).toBe(false);
    const main = result.sections[2];
    expect(main.headings).toEqual(["Products", "Grid", "Widget", "Recs"]);
    expect(main.textLength).toBeGreaterThan(0);
  });

  it("marks ambiguous selectors as unverified", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), `
      <main>
        <section class="dup"><h3>One</h3></section>
        <section class="dup"><h3>Two</h3></section>
      </main>`);
    const dups = result.sections[0].children;
    expect(dups.length).toBe(2);
    expect(dups[0].selectorVerified).toBe(false);
    expect(dups[1].selectorVerified).toBe(false);
  });

  it("caps nesting at maxDepth", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs({ maxDepth: 1 }), PAGE);
    expect(result.sections.length).toBe(4);
    expect(result.sections.every(s => s.children.length === 0)).toBe(true);
  });

  it("truncates at maxSections", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs({ maxSections: 3 }), PAGE);
    expect(result.totalDetected).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("skips zero-size regions", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), `
      <nav data-w="0" data-h="0">hidden</nav>
      <main data-h="500"><h2>Visible</h2></main>`);
    expect(result.sections.map(s => s.role)).toEqual(["main"]);
  });

  it("reports page url and viewport", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), PAGE);
    expect(result.url).toBe("https://example.com/page");
    expect(result.viewport.width).toBeGreaterThan(0);
    expect(result.viewport.height).toBeGreaterThan(0);
  });
});

describe("hostile and degenerate pages (audit regressions)", () => {
  // Direct navigation to a .svg/.xml URL: document.body === null. A throw here
  // surfaces as a bridge rejection, which the tools.ts `?? {default}` fallback
  // never catches — the programs must degrade, not throw.
  const bodylessDom = () =>
    new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg"><g><text>chart</text></g></svg>`,
      { url: "https://example.com/chart.svg", contentType: "image/svg+xml" });

  it("detect-sections returns an empty tree on a bodyless document instead of throwing", () => {
    const result = runProgramIn<PageSections>(buildDetectSectionsJs(), bodylessDom());
    expect(result.sections).toEqual([]);
    expect(result.totalDetected).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("detect-tables returns no candidates on a bodyless document instead of throwing", () => {
    expect(runProgramIn<TableCandidate[]>(buildDetectTablesJs(), bodylessDom())).toEqual([]);
  });

  it("keeps a header literally named 'Constructor' as a clean column name", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("table"), `
      <table>
        <thead><tr><th>Driver</th><th>Constructor</th><th>Points</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td>Apex</td><td>25</td></tr>
          <tr><td>Bob</td><td>Vector</td><td>18</td></tr>
        </tbody>
      </table>`);
    expect(result.columns.map(c => c.name)).toEqual(["driver", "constructor", "points"]);
    expect(result.rows[0]["constructor"]).toBe("Apex");
    expect(result.rows[1]["points"]).toBe("18");
  });

  it("still dedupes genuinely duplicate headers", () => {
    const result = runProgram<TableExtraction>(buildExtractTableJs("table"), `
      <table>
        <thead><tr><th>Name</th><th>Name</th></tr></thead>
        <tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody>
      </table>`);
    expect(result.columns.map(c => c.name)).toEqual(["name", "name_2"]);
  });

  it("detects repeated blocks whose class is an Object.prototype member name", () => {
    const cards = Array.from({ length: 4 }, (_, i) => `<div class="constructor"><h3>Item ${i}</h3><span>$${i}.99</span></div>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `<div id="list">${cards}</div>`);
    const list = result.find(c => c.selector.includes("list"));
    expect(list).toBeTruthy();
    expect(list!.rowCount).toBe(4);
  });

  it("names div-soup columns cleanly when classes collide with Object.prototype", () => {
    const item = (n: number) => `<div class="row"><span class="constructor">C${n}</span><span class="valueOf">V${n}</span></div>`;
    const result = runProgram<TableExtraction>(buildExtractTableJs("#g"), `<div id="g">${item(1)}${item(2)}${item(3)}</div>`);
    const names = result.columns.map(c => c.name);
    expect(names).toContain("constructor");
    expect(names).toContain("valueof");
    expect(names.some(n => n.includes("NaN"))).toBe(false);
    expect(result.rows[0]["constructor"]).toBe("C1");
  });

  it("does not classify Object.prototype member roles as aria landmarks", () => {
    const result = runProgram<PageSections>(buildDetectSectionsJs(), `
      <main data-h="500">
        <div role="__proto__" data-h="200">proto text</div>
        <div role="constructor" data-h="200">ctor text</div>
        <div role="navigation" data-h="200"><a href="/x">x</a></div>
      </main>`);
    const main = result.sections[0];
    expect(main.children.map(c => c.role)).toEqual(["navigation"]);
  });

  it("skips inline SVG subtrees in the section walk", () => {
    // role="navigation" inside the SVG would classify if the walker descended;
    // the sibling <nav> proves the walk continues past the skipped subtree.
    const result = runProgram<PageSections>(buildDetectSectionsJs(), `
      <main data-h="500">
        <h2>Chart</h2>
        <svg viewBox="0 0 100 100"><g role="navigation"><text>legend</text></g></svg>
        <nav data-h="60"><a href="/a">A</a></nav>
      </main>`);
    const main = result.sections[0];
    expect(main.children.map(c => c.role)).toEqual(["nav"]);
  });

  it("emits no SVG-derived candidate and no non-finite score from detect-tables", () => {
    const ticks = Array.from({ length: 8 }, (_, i) => `<g class="tick"><text>${i}</text></g>`).join("");
    const result = runProgram<TableCandidate[]>(buildDetectTablesJs(), `
      <div id="chart" data-w="800" data-h="400"><svg>${ticks}</svg></div>
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>
        <tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr>
      </tbody></table>`);
    expect(result.length).toBeGreaterThan(0);
    for (const c of result) {
      expect(Number.isFinite(c.score)).toBe(true);
      expect(Number.isFinite(c.area)).toBe(true);
      expect(c.selector.includes("svg")).toBe(false);
      expect(c.selector.includes("tick")).toBe(false);
    }
  });

  it("returns empty results for a present but empty body", () => {
    // Distinct from the bodyless document above: <body> exists and has no children.
    expect(runProgram<TableCandidate[]>(buildDetectTablesJs(), "")).toEqual([]);
    expect(runProgram<PageSections>(buildDetectSectionsJs(), "").sections).toEqual([]);
  });
});
