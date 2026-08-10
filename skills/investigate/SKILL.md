---
name: investigate
description: "Deep-dive investigation of a single website — tech stack, tracking, data layer, performance, security, accessibility. Produces Finding[] evidence."
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Investigate

Deep-dive investigation of a single website. Produces structured findings across technology, tracking, performance, security, accessibility, and data-structure dimensions.

## When to Use

- Audit tech stack, frameworks, third-party dependencies
- Analyze tracking health (GA4, GTM, FB Pixel) and data layer state
- Measure performance, security, accessibility
- Detect structured data (tables, JSON-LD)

## Protocol

**Acquire -> Normalize -> Analyze** with Evidence Mode.

### 1. Connect

```
connect_tab({ url: "https://target.com", background: true })
```

### 2. Acquire + Normalize

```js
const page = await smart.extractPage();        // 7 parallel ops, typed gaps
const tech = await smart.detectTechnologies();  // fingerprint-based tech detection
const tracking = await smart.parseTrackingPixels();
const validation = await smart.validateTracking();
const dataLayer = await smart.inspectDataLayer();
const tables = await smart.detectTables();
// page.gaps[] tells you what failed — check before trusting supplementary data
// A gap with reducesConfidence:true auto-caps findings in that dimension
```

Use `smart.scrollCapture()` when visual evidence is needed.

### 3. Analyze — produce findings

```js
smart.finding({
  claim: `Site runs ${tech.technologies.length} detected technologies`,
  evidence: tech.technologies.map(t => `${t.name} (${t.confidence})`),
  sourceUrl: page.capture.url, confidence: "high",
  method: "detectTechnologies", dimension: "technology"
});

if (tracking.pixels?.length) {
  smart.finding({
    claim: `${tracking.pixels.length} tracking pixels detected`,
    evidence: tracking.pixels.map(p => `${p.vendor}/${p.pixelId}: ${p.eventCount} fires (${p.uniqueEventNames.join(', ')})`),
    sourceUrl: page.capture.url, confidence: "high",
    method: "parseTrackingPixels", dimension: "tracking"
  });
}

if (validation.issues?.length) {
  smart.finding({
    claim: `${validation.issues.length} tracking validation issues`,
    evidence: validation.issues.map(i => `${i.parameter || i.code}: ${i.message}`),
    sourceUrl: page.capture.url, confidence: "medium",
    method: "validateTracking", dimension: "tracking"
  });
}

if (page.performance) {
  smart.finding({
    claim: `LCP: ${page.performance.webVitals?.lcp || 'n/a'}ms`,
    evidence: [`CLS: ${page.performance.webVitals?.cls}`, `FID: ${page.performance.webVitals?.fid}`],
    sourceUrl: page.capture.url,
    confidence: page.gaps.some(g => g.dimension === "performance") ? "medium" : "high",
    method: "extractPage", dimension: "performance"
  });
}

if (page.security) {
  const protocol = page.security.certificate?.protocol || "unknown";
  smart.finding({
    claim: `Security state: ${page.security.securityState || 'unknown'} (${protocol})`,
    evidence: [
      `mixedContent: ${Boolean(page.security.mixedContent)}`,
      `certificate issuer: ${page.security.certificate?.issuer || 'unavailable'}`
    ],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "security"
  });
}

if (page.accessibility) {
  smart.finding({
    claim: `${page.accessibility.imagesWithoutAlt} images missing alt text`,
    evidence: [`Landmarks: ${page.accessibility.landmarkCount}`, `Nodes: ${page.accessibility.nodeCount}`],
    sourceUrl: page.capture.url, confidence: "high",
    method: "extractPage", dimension: "accessibility"
  });
}

if (tables.length) {
  smart.finding({
    claim: `${tables.length} table-like structures detected`,
    evidence: tables.map(t => `${t.selector}: ${t.score} score`),
    sourceUrl: page.capture.url, confidence: "medium",
    method: "detectTables", dimension: "data-structure"
  });
}

return { findings: smart.findings(), gaps: page.gaps };
```

## Anti-Patterns

- No `smart.screenshot()` -- use `bridge.send({ type: 'take_screenshot' })`
- No `sleep()` loops -- use `smart.waitForIdle()`
- No `location.href` -- use `smart.navigate()`
- Always `search()` before guessing command names
- No `capture_page` + `detect_framework` -- `smart.extractPage()` does both. See **browser-automation** for full list.

## Output

Produces `Finding[]` via `smart.findings()`. Each finding has: `claim`, `evidence[]`, `sourceUrl`, `confidence`, `method`, `dimension`. Check `page.gaps` for failed evidence collection and reduced-confidence dimensions.
