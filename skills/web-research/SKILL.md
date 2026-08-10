---
name: web-research
description: Structured web research, site audits, and competitive analysis. Acquire → Normalize → Analyze protocol with Evidence Mode findings.
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Web Research Protocol

## When to Use

Use this skill when the user wants to:
- Audit a website (performance, SEO, security, accessibility, tech stack)
- Compare competitors or analyze multiple sites
- Conduct structured web research with evidence
- Review site quality, trust signals, or conversion flows
- Extract structured data across multiple pages

## Protocol: Acquire → Normalize → Analyze

Every research task follows three phases:

### Phase 1: Acquire

Connect to each target page and extract comprehensive data using `smart.extractPage()`:

```js
// Connect first
await connect_tab({ url: "https://example.com", background: true })

// Extract everything in one call
const page = await smart.extractPage()
// Returns: { capture, performance, security, fonts, meta, accessibility, mobileReadiness, gaps }
```

For visual evidence, add `smart.scrollCapture()`:

```js
const visuals = await smart.scrollCapture({ maxSections: 5 })
// Returns: { sectionCount, sections: [{ index, scrollY, screenshot }] }
```

Wait for dynamic content with `smart.waitForIdle()` instead of `sleep()`:

```js
const idle = await smart.waitForIdle(5000)
// Returns: { status: 'idle' | 'timeout' }
```

### Phase 2: Normalize

Structure evidence into canonical per-page records. Each page record should include:

```js
const record = {
  url: page.capture.url,
  title: page.capture.title,
  framework: page.capture.framework,
  network: page.capture.network,        // { total, failed, byType, errors }
  console: page.capture.console,        // { total, errors, warnings }
  cookies: page.capture.cookies,        // { total, names }
  dom: page.capture.dom,                // { nodeCount, forms, links, images, inputs }
  performance: page.performance,        // LCP, CLS, FCP, Web Vitals
  security: page.security,             // TLS, cert, mixed content
  fonts: page.fonts,                   // declared + computed
  meta: page.meta,                     // OG tags, structured data, headings, nav links
  accessibility: page.accessibility,   // node count, landmarks, images without alt, heading structure
  mobileReadiness: page.mobileReadiness, // viewport meta, media queries, overflow
  gaps: page.gaps,                     // what data failed — check before trusting null fields
}
```

### Phase 3: Analyze

Compare against a fixed rubric. Produce validated findings using `smart.finding()`:

```js
smart.finding({
  claim: "Site loads 47 network requests with 2 failures",
  evidence: ["network.total: 47", "network.failed: 2"],
  sourceUrl: page.capture.url,
  confidence: "high",
  method: "extractPage",
  dimension: "performance"  // auto-caps confidence if perf data had gaps
})

// Retrieve all findings from this session
const allFindings = smart.findings()

// Reset for next research task
smart.clearFindings()
```

If `extractPage()` reported gaps (e.g., performance metrics failed), findings with matching `dimension` get confidence automatically capped one level (high → medium, medium → low). Check `page.gaps` to understand what data is missing.

## Use Existing Tools — Not Manual Equivalents

| Need | Use This | NOT This |
|------|----------|----------|
| Full page data | `smart.extractPage()` | Manual DOM scraping via evaluate |
| Performance metrics | `get_performance_metrics` (via extractPage) | `evaluate('performance.getEntriesByType(...)')` |
| Font detection | `detect_fonts` (via extractPage) | Manual CSS inspection |
| Wait for page ready | `smart.waitForIdle()` | `sleep(2000)` |
| Scroll + screenshot | `smart.scrollCapture()` | Manual scroll loops with sleep |
| Framework detection | `capture_page` (via extractPage) | Manual window.__NEXT_DATA__ checks |
| Security state | `get_security_state` (via extractPage) | Manual cert inspection |
| Compare two sites | `smart.comparePages(urlA, urlB)` | Manual navigate + extract twice |

## Evidence-First Principle

Every claim needs supporting data:

```js
// GOOD — claim backed by extracted data
{
  finding: "Site loads 47 network requests, 2 failed",
  evidence: page.capture.network,
  url: page.capture.url
}

// BAD — claim without evidence
"The site seems to have some performance issues"
```

## Comparison Schema

When comparing sites, evaluate these dimensions:

1. **Positioning** — tagline, hero copy, value proposition
2. **Target User** — who the product is for (inferred from copy, pricing, features)
3. **Product Surface** — feature set, integrations, API availability
4. **Trust Signals** — testimonials, logos, certifications, security badges
5. **Integration Story** — ecosystem, third-party connections, developer tools
6. **Documentation** — quality, searchability, examples, API reference
7. **Pricing** — model, tiers, free tier, transparency
8. **Tech Differentiation** — unique technical capabilities, architecture
9. **UI Quality** — design polish, loading speed, mobile responsiveness
10. **Conversion Friction** — signup flow, CTAs, form length, friction points
11. **Data Structure** — structured data presence, table extraction, schema.org

## Anti-Patterns

### Never do these:

- **Blind `sleep()` loops** — use `smart.waitForIdle()` or `smart.waitFor(selector)` instead
- **Manual scroll + screenshot loops** — use `smart.scrollCapture()` instead
- **`evaluate('performance.getEntriesByType(...)')`** — use `get_performance_metrics` via `smart.extractPage()`
- **Ad hoc return shapes** — always structure evidence as `{ finding, evidence, url, confidence? }`
- **Screenshot-only analysis** — screenshots are visual evidence, not data. Always pair with structured extraction
- **Guessing command names** — always `search()` first if unsure

### Prefer:

- **One `extractPage()` per page** — it runs 7 ops in parallel (capture + perf + security + fonts + meta + accessibility + mobile-readiness) with typed gaps
- **`comparePages()` for 2-site comparisons** — returns `{ siteA, siteB, scaffold }` with 11 fixed comparison dimensions
- **`smart.finding()` for validated findings** — enforces claim + evidence + sourceUrl + confidence + method schema
- **No `smart.screenshot()`** — it doesn't exist. Use `bridge.send({ type: 'take_screenshot' })` or `smart.scrollCapture()`
- **Scope large snapshots** — use `smart.snapshot({ compact: true, maxDepth: 8, selector: "#main" })`; use `{ interactive: true }` when only actionable controls matter
- **No `location.href = "..."` for navigation** — use `smart.navigate(url)`. Direct assignment breaks CDP

## Example: Competitive Audit

```js
// Phase 1: Acquire both sites
const diff = await smart.comparePages(
  "https://competitor-a.com",
  "https://competitor-b.com"
)

return diff
```

Then in a second execute call, drill into specifics:

```js
// Phase 2: Visual evidence for site A
await smart.navigate("https://competitor-a.com")
await smart.waitForIdle(3000)
const visuals = await smart.scrollCapture({ maxSections: 5 })
return { url: "https://competitor-a.com", sectionCount: visuals.sectionCount }
```

Phase 3 (analysis) happens in the LLM — compare the structured data from both sites against the comparison schema dimensions.

## Multi-Page Research Pattern

For auditing multiple pages on the same site:

```js
const pages = ["/", "/pricing", "/docs", "/about"]
const results = []

for (const path of pages) {
  await smart.navigate(`https://example.com${path}`)
  await smart.waitForIdle(3000)
  const data = await smart.extractPage()
  results.push({ path, ...data })
}

return results
```

Keep the page list short (3-5 pages per execute call) to stay within the 120s timeout.
