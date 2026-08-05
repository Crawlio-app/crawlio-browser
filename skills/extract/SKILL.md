---
name: extract
description: "Extract structured data from a page — tables, JSON-LD, repeated patterns. Produces Finding[] evidence on data quality."
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Extract

Extract structured data from a page. Detect tables, pull JSON-LD, extract repeated DOM patterns. Produces findings on completeness, row counts, and schema consistency.

## When to Use

- Extract tabular data from a page (pricing, specs, listings)
- Pull JSON-LD or structured data from `<script>` tags
- Detect repeated DOM patterns (cards, lists, grids)
- Assess data quality (missing columns, truncation, schema gaps)
- Extract data from async-loading pages
- Read visually-rendered data invisible to DOM (canvas, images, anti-scrape)

## Protocol

**Acquire -> Normalize -> Analyze** with Evidence Mode.

### 1. Connect

```
connect_tab({ url: "https://target.com/data-page" })
```

### 2. Acquire + Normalize

```js
await smart.waitForNetworkIdle({ timeout: 10000 }); // wait for async content
const data = await smart.extractData();              // detectTables + extractTable + JSON-LD
const page = await smart.extractPage();              // meta and structured data context
// data.tables[] — selector, columns[], rows[], totalRows, truncated
// data.structuredData — JSON-LD objects from <script> tags
// page.gaps[] — what failed during extractPage
```

For deeper control, use individual methods:

```js
const candidates = await smart.detectTables();           // scored table-like structures
const table = await smart.extractTable("table.pricing"); // specific table extraction
```

For visually-rendered data (canvas, images, anti-scrape sites):

```js
const ocr = await bridge.send({ type: "ocr_screenshot", fullPage: true });
```

### 3. Analyze — produce findings

```js
for (const table of data.tables || []) {
  smart.finding({
    claim: `Found ${table.totalRows} rows in table "${table.selector}"`,
    evidence: [
      `columns: ${table.columns.map(c => c.name).join(', ')}`,
      `truncated: ${table.truncated}`
    ],
    sourceUrl: page.capture.url,
    confidence: table.truncated ? "medium" : "high",
    method: "extractData", dimension: "data-structure"
  });

  // Data quality — flag sparse columns
  const empty = table.columns.filter(c => c.emptyRate > 0.5);
  if (empty.length) {
    smart.finding({
      claim: `${empty.length} columns in "${table.selector}" are >50% empty`,
      evidence: empty.map(c => `${c.name}: ${Math.round(c.emptyRate * 100)}% empty`),
      sourceUrl: page.capture.url, confidence: "medium",
      method: "extractData", dimension: "data-quality"
    });
  }
}

if (data.structuredData?.length) {
  smart.finding({
    claim: `${data.structuredData.length} JSON-LD blocks found`,
    evidence: data.structuredData.map(s => `@type: ${s['@type'] || 'unknown'}`),
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractData", dimension: "data-structure"
  });
}

return {
  findings: smart.findings(),
  tables: data.tables?.length || 0,
  structuredData: data.structuredData?.length || 0
};
```

## Anti-Patterns

- No `smart.screenshot()` -- use `bridge.send({ type: 'take_screenshot' })`
- No `sleep()` loops -- use `smart.waitForNetworkIdle()` or `smart.waitForIdle()`
- No `location.href` -- use `smart.navigate()`
- Always `search()` before guessing command names
- No manual scroll+extract loops -- `smart.extractData()` handles both. See **browser-automation** for full list.

## Output

Produces `Finding[]` via `smart.findings()`. Each finding has: `claim`, `evidence[]`, `sourceUrl`, `confidence`, `method`, `dimension`. Dimensions used: `data-structure` (table detection, JSON-LD), `data-quality` (completeness, sparsity, truncation).
