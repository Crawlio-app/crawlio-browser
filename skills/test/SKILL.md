---
name: test
description: "Test a page against quality assertions — accessibility, performance, security, SEO, mobile readiness"
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Test — Quality Assertions

Run pass/fail assertions across accessibility, performance, security, SEO, and mobile readiness. Every assertion becomes a finding. Confidence auto-caps when data is missing.

## When to Use

- Auditing accessibility, performance, security, SEO, or mobile readiness
- Running pass/fail assertions against quality thresholds

## Protocol

1. **search** for extraction commands: `search("extract page accessibility")`
2. **connect_tab** to the target URL
3. **execute** Code Mode: `smart.extractPage()` gathers all dimensions in one call
4. Emit one `smart.finding()` per assertion — claim states pass or fail
5. Return `smart.findings()` + `page.gaps`

## Code Example

```js
const page = await smart.extractPage();

// Accessibility
if (page.accessibility) {
  smart.finding({
    claim: page.accessibility.imagesWithoutAlt === 0
      ? "All images have alt text"
      : `${page.accessibility.imagesWithoutAlt} images missing alt text`,
    evidence: [`imagesWithoutAlt: ${page.accessibility.imagesWithoutAlt}`, `nodeCount: ${page.accessibility.nodeCount}`],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "accessibility"
  });
  smart.finding({
    claim: page.accessibility.landmarkCount > 0
      ? `${page.accessibility.landmarkCount} ARIA landmarks found`
      : "No ARIA landmarks — add banner, main, contentinfo",
    evidence: [`landmarkCount: ${page.accessibility.landmarkCount}`],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "accessibility"
  });
}

// Performance
if (page.performance) {
  const lcp = page.performance.webVitals?.lcp;
  const cls = page.performance.webVitals?.cls;
  smart.finding({
    claim: lcp && lcp < 2500 ? `LCP good (${lcp}ms)` : `LCP needs work (${lcp || "unknown"}ms)`,
    evidence: [`LCP: ${lcp}ms`, `CLS: ${cls}`, `thresholds: LCP<2500, CLS<0.1`],
    sourceUrl: page.capture.url, confidence: lcp ? "high" : "low",
    method: "extractPage", dimension: "performance"
  });
}

// Security
if (page.security) {
  smart.finding({
    claim: page.security.securityState === "secure"
      ? "TLS connection is secure" : `Security state: ${page.security.securityState || "unknown"}`,
    evidence: [`protocol: ${page.security.protocol || "unknown"}`],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "security"
  });
}

// SEO
if (page.capture?.meta) {
  const m = page.capture.meta;
  smart.finding({
    claim: m.title && m.description ? "Title + meta description present" : "SEO meta tags incomplete",
    evidence: [`title: ${m.title || "missing"} (${m.title?.length || 0} chars)`,
               `description: ${m.description || "missing"} (${m.description?.length || 0} chars)`],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "seo"
  });
}

// Mobile readiness
if (page.mobileReadiness) {
  smart.finding({
    claim: page.mobileReadiness.hasViewportMeta ? "Viewport meta tag present" : "Missing viewport meta",
    evidence: [`viewport: ${page.mobileReadiness.viewportContent || "none"}`],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "mobile-readiness"
  });
}

// Tech stack
const tech = await smart.detectTechnologies();
if (tech.technologies?.length) {
  smart.finding({
    claim: `${tech.technologies.length} technologies detected`,
    evidence: tech.technologies.map(t => t.name),
    sourceUrl: page.capture.url, confidence: "high",
    method: "detectTechnologies", dimension: "technology"
  });
}

return { findings: smart.findings(), gaps: page.gaps };
```

## Anti-Patterns

- Do NOT use `smart.screenshot()` — extractPage captures everything needed
- Do NOT use `sleep()` to wait for metrics — extractPage handles page load
- Do NOT use `location.href` — use `page.capture.url`
- Always `search()` first if unsure which fields extractPage returns

## Output

The skill produces `Finding[]` via `smart.findings()`. Dimensions: **accessibility**, **performance**, **security**, **seo**, **mobile-readiness**, **technology**. When data is missing, confidence auto-caps to "low" and the gap appears in `page.gaps`.
