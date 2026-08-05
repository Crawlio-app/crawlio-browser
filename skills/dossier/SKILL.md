---
name: dossier
description: "Competitive intelligence dossier — compare a target against 2-4 competitors across all dimensions"
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Dossier — Competitive Intelligence

Compare a target site against 2-4 competitors across all 11 comparison dimensions. Aggregate strengths, weaknesses, and opportunities as structured findings.

## When to Use

- Building a competitive analysis across multiple sites
- Comparing tech stacks, performance, accessibility, SEO head-to-head
- Identifying where a target leads or lags vs competitors
- Producing a structured strengths/weaknesses/opportunities report

## Protocol

1. **search** for comparison commands: `search("compare pages")` or `search("extract page")`
2. **connect_tab** to the target URL
3. **execute** Code Mode to run `smart.comparePages()` for each target-vs-competitor pair
4. Emit one `smart.finding()` per dimension per pair
5. After all pairs, return `smart.findings()` grouped by dimension

## Code Example

```js
const target = "https://target.com";
const competitors = ["https://comp-a.com", "https://comp-b.com"];

// Compare target vs each competitor
for (const comp of competitors) {
  const comparison = await smart.comparePages(target, comp);

  for (const dim of comparison.scaffold.dimensions) {
    if (!dim.comparable) continue;
    smart.finding({
      claim: `${dim.name}: ${target} vs ${comp}`,
      evidence: [`target: ${dim.siteA.status}`, `competitor: ${dim.siteB.status}`],
      sourceUrl: target,
      confidence: "high",
      method: "comparePages",
      dimension: dim.name
    });
  }

  // Tech stack comparison
  if (comparison.siteA.technologies || comparison.siteB.technologies) {
    const targetTech = comparison.siteA.technologies?.map(t => t.name) || [];
    const compTech = comparison.siteB.technologies?.map(t => t.name) || [];
    smart.finding({
      claim: `Tech stacks differ: target [${targetTech.join(", ")}] vs ${comp} [${compTech.join(", ")}]`,
      evidence: [`target: ${targetTech.join(", ")}`, `competitor: ${compTech.join(", ")}`],
      sourceUrl: target,
      confidence: "high",
      method: "comparePages + detectTechnologies",
      dimension: "technology"
    });
  }
}

// Visual reference of target
await smart.scrollCapture();

return { findings: smart.findings(), totalComparisons: competitors.length };
```

## Anti-Patterns

- Do NOT capture each site manually with extractPage then diff by hand — use `smart.comparePages()`
- Do NOT use `sleep()` between comparisons — comparePages handles navigation internally
- Do NOT use `location.href` — URLs are passed as arguments to comparePages
- Always `search()` first to confirm command availability

## Output

The skill produces `Finding[]` via `smart.findings()`. Findings span all 11 scaffold dimensions:

- **technology** — framework, libraries, build tools
- **performance** — LCP, CLS, load timing
- **accessibility** — landmark count, alt text, ARIA
- **security** — TLS state, headers, mixed content
- **seo** — meta tags, structured data, headings
- **mobile-readiness** — viewport, media queries, overflow
- **content** — text density, media count
- **navigation** — link structure, menus
- **data-structure** — tables, structured data
- **design** — visual patterns, layout
- **network** — request count, third parties

Patterns across competitors emerge when findings are grouped by dimension.
