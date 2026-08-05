---
name: compare
description: "Side-by-side comparison of two websites across 11 dimensions. Produces Finding[] evidence per dimension."
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Compare

Side-by-side comparison of two websites across 11 typed dimensions. One call captures both sites and returns a scaffold with per-dimension comparability. Produces one finding per dimension.

## When to Use

- Compare two competing sites (framework, performance, security)
- Audit staging vs production
- Benchmark a site against a competitor across all 11 dimensions
- Identify gaps where one site excels and the other falls short

## The 11 Dimensions

framework, performance, security, seo, accessibility, error-surface, third-party-load, architecture, content-delivery, mobile-readiness, data-structure.

## Protocol

**Acquire -> Normalize -> Analyze** with Evidence Mode.

### 1. Connect

```
connect_tab({ url: "https://site-a.com" })
```

`comparePages` handles navigation to both sites internally.

### 2. Acquire + Normalize

```js
const comparison = await smart.comparePages(
  "https://site-a.com",
  "https://site-b.com"
);
// comparison.siteA / siteB — full PageEvidence (capture, performance, security, etc.)
// comparison.scaffold.dimensions[] — 11 objects: { name, comparable, siteA.status, siteB.status }
// comparison.scaffold.sharedFields / missingFields
// comparison.siteA.gaps[] / siteB.gaps[] — what failed per site
```

### 3. Analyze — produce findings

Walk the scaffold. One finding per dimension.

```js
for (const dim of comparison.scaffold.dimensions) {
  if (!dim.comparable) {
    smart.finding({
      claim: `${dim.name}: not comparable — data missing`,
      evidence: [`siteA: ${dim.siteA.status}`, `siteB: ${dim.siteB.status}`],
      sourceUrl: comparison.siteA.capture?.url || "unknown",
      confidence: "low", method: "comparePages", dimension: dim.name
    });
    continue;
  }
  smart.finding({
    claim: `${dim.name}: both sites present — ready for comparison`,
    evidence: [`siteA: ${dim.siteA.status}`, `siteB: ${dim.siteB.status}`],
    sourceUrl: comparison.siteA.capture?.url || "unknown",
    confidence: "high", method: "comparePages", dimension: dim.name
  });
}
```

Drill into specific dimensions using raw PageEvidence:

```js
// Performance drill-down
if (comparison.siteA.performance && comparison.siteB.performance) {
  const lcpA = comparison.siteA.performance.webVitals?.lcp;
  const lcpB = comparison.siteB.performance.webVitals?.lcp;
  if (lcpA && lcpB) {
    const faster = lcpA < lcpB ? "A" : "B";
    smart.finding({
      claim: `Site ${faster} loads ${Math.abs(lcpA - lcpB)}ms faster (LCP)`,
      evidence: [`siteA LCP: ${lcpA}ms`, `siteB LCP: ${lcpB}ms`],
      sourceUrl: comparison.siteA.capture.url, confidence: "high",
      method: "comparePages", dimension: "performance"
    });
  }
}

return {
  findings: smart.findings(),
  scaffold: comparison.scaffold,
  gaps: { siteA: comparison.siteA.gaps, siteB: comparison.siteB.gaps }
};
```

## Anti-Patterns

- No `smart.screenshot()` -- use `bridge.send({ type: 'take_screenshot' })`
- No `sleep()` loops -- use `smart.waitForIdle()`
- No `location.href` -- use `smart.navigate()`
- Always `search()` before guessing command names
- No manual "extract A, then extract B" -- `smart.comparePages()` does both. See **browser-automation** for full list.

## Output

Produces `Finding[]` via `smart.findings()`. Each finding has: `claim`, `evidence[]`, `sourceUrl`, `confidence`, `method`, `dimension`. Dimension tags match the 11 scaffold dimensions.
