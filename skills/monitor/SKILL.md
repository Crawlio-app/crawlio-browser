---
name: monitor
description: "Monitor a page for changes — capture baseline, recapture, diff, report what changed"
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Monitor — Change Detection

Capture a baseline snapshot, recapture later, diff the results. Report structural, content, technology, and performance changes as structured findings.

## When to Use

- Tracking what changed on a page between two points in time
- Detecting content additions/removals, tech stack changes, performance regressions
- Verifying a deploy changed what was expected (and nothing else)

## Protocol

1. **search** for diff and snapshot commands: `search("diff snapshot")`
2. **connect_tab** to the target URL
3. **execute** Code Mode: baseline with `smart.snapshot()` + `smart.extractPage()`
4. On recapture, diff and emit one `smart.finding()` per change dimension
5. Return `smart.findings()` as the final output

## Code Example

```js
// 1. Baseline
const baselineSnap = await smart.snapshot();
const baseline = await smart.extractPage();
const baselineTech = await smart.detectTechnologies();

// ... user triggers recapture ...

// 2. Recapture + diff
const current = await smart.extractPage();
const currentTech = await smart.detectTechnologies();
const diff = await smart.diffSnapshots(baselineSnap.snapshot);

smart.finding({
  claim: `${diff.additions} elements added, ${diff.removals} removed since baseline`,
  evidence: [`additions: ${diff.additions}`, `removals: ${diff.removals}`, `unchanged: ${diff.unchanged}`],
  sourceUrl: current.capture.url,
  confidence: "high",
  method: "diffSnapshots",
  dimension: "structure"
});

if (diff.additions > 0 || diff.removals > 0) {
  smart.finding({
    claim: `Content changed: ${diff.additions + diff.removals} total mutations`,
    evidence: diff.sample || [`${diff.additions} added`, `${diff.removals} removed`],
    sourceUrl: current.capture.url, confidence: "high",
    method: "diffSnapshots", dimension: "content"
  });
}

// Technology changes
const oldTech = new Set(baselineTech.technologies?.map(t => t.name) || []);
const newTech = new Set(currentTech.technologies?.map(t => t.name) || []);
const added = [...newTech].filter(t => !oldTech.has(t));
const removed = [...oldTech].filter(t => !newTech.has(t));
if (added.length || removed.length) {
  smart.finding({
    claim: `Tech stack changed: +${added.length} -${removed.length}`,
    evidence: [...added.map(t => `added: ${t}`), ...removed.map(t => `removed: ${t}`)],
    sourceUrl: current.capture.url, confidence: "high",
    method: "detectTechnologies", dimension: "technology"
  });
}

// Performance regression check
const oldLcp = baseline.performance?.webVitals?.lcp;
const newLcp = current.performance?.webVitals?.lcp;
if (oldLcp && newLcp) {
  const delta = newLcp - oldLcp;
  smart.finding({
    claim: delta > 100 ? `LCP regressed by ${delta}ms` : `LCP stable (delta: ${delta}ms)`,
    evidence: [`baseline: ${oldLcp}ms`, `current: ${newLcp}ms`],
    sourceUrl: current.capture.url, confidence: "high",
    method: "extractPage", dimension: "performance"
  });
}

await smart.scrollCapture();
return { findings: smart.findings(), diff: { added: diff.additions, removed: diff.removals } };
```

## Anti-Patterns

- Do NOT use `sleep()` loops to poll for changes — capture baseline, wait for user signal, recapture
- Do NOT compare screenshots visually — use `smart.diffSnapshots()` for structural diff
- Do NOT use `location.href` — use `current.capture.url` from extractPage
- Always `search()` first to confirm diff commands exist

## Output

The skill produces `Finding[]` via `smart.findings()`. Dimension tags:

- **structure** — DOM elements added or removed
- **content** — text and media mutations
- **technology** — frameworks added or removed
- **performance** — LCP, CLS, timing regressions or improvements
