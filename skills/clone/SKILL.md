---
name: clone
description: "Capture a site's design system — colors, typography, spacing, layout, components — as structured findings"
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Clone — Design System Extraction

Capture the visual DNA of a page: design tokens, typography scale, spacing system, component patterns, and CSS framework.

## When to Use

- Reproducing or referencing another site's design system
- Extracting CSS custom properties and design tokens
- Identifying typography, color palette, spacing conventions
- Determining what CSS framework or UI library is in use

## Protocol

1. **search** for the right commands: `search("design tokens extract CSS")` or `search("detect technologies")`
2. **connect_tab** to the target URL (or use an already-connected tab)
3. **execute** Code Mode with smart.* methods to extract evidence
4. Emit one `smart.finding()` per design dimension discovered
5. Return `smart.findings()` as the final output

## Code Example

```js
const page = await smart.extractPage();
const tech = await smart.detectTechnologies();

// Extract CSS custom properties (design tokens)
const tokens = await smart.evaluate(`(() => {
  const styles = getComputedStyle(document.documentElement);
  const props = {};
  for (const name of [...document.styleSheets].flatMap(s => {
    try { return [...s.cssRules] } catch { return [] }
  }).filter(r => r.style).flatMap(r => [...r.style]).filter(p => p.startsWith('--'))) {
    props[name] = styles.getPropertyValue(name).trim();
  }
  return { count: Object.keys(props).length, sample: Object.entries(props).slice(0, 20) };
})()`);

smart.finding({
  claim: `Site uses ${tokens.result.count} CSS custom properties`,
  evidence: tokens.result.sample.map(([k, v]) => `${k}: ${v}`),
  sourceUrl: page.capture.url,
  confidence: "high",
  method: "evaluate + extractPage",
  dimension: "design-system"
});

// Typography
if (page.fonts?.length) {
  smart.finding({
    claim: `${page.fonts.length} font families loaded`,
    evidence: page.fonts.map(f => f.name || f),
    sourceUrl: page.capture.url,
    confidence: "high",
    method: "extractPage",
    dimension: "typography"
  });
}

// Framework / UI library
const frameworks = tech.technologies?.map(t => t.name) || [];
if (frameworks.length) {
  smart.finding({
    claim: `Detected CSS/UI frameworks: ${frameworks.join(", ")}`,
    evidence: frameworks,
    sourceUrl: page.capture.url,
    confidence: "high",
    method: "detectTechnologies",
    dimension: "technology"
  });
}

// Repeating UI patterns (tables / grids)
const tables = await smart.detectTables();
if (tables.length) {
  smart.finding({
    claim: `${tables.length} repeating UI patterns detected`,
    evidence: tables.map(t => `${t.selector}: ${t.rowCount} rows, ${t.columns.length} cols`),
    sourceUrl: page.capture.url,
    confidence: "high",
    method: "detectTables",
    dimension: "layout"
  });
}

// Visual reference
await smart.scrollCapture();

return { findings: smart.findings(), fonts: page.fonts, tech: frameworks };
```

## Anti-Patterns

- Do NOT use `smart.screenshot()` — use `smart.scrollCapture()` for full-page visual reference
- Do NOT use `sleep()` loops to wait for styles — styles are available immediately after page load
- Do NOT use `location.href` — use `page.capture.url` from extractPage
- Always `search()` first if unsure which command extracts what you need

## Output

The skill produces `Finding[]` via `smart.findings()`. Each finding is tagged with a dimension:

- **design-system** — CSS custom properties, design tokens
- **typography** — font families, type scale, weights
- **layout** — grid systems, repeating patterns, spacing
- **technology** — CSS framework, UI library, build tooling
