---
name: browser-automation
description: Use this skill when the user asks to interact with a browser, take screenshots, inspect a page, capture network traffic, detect frameworks, click elements, fill forms, record browser sessions, or automate any browser task. Orchestrates Crawlio Browser's 145 browser tools via the search + execute + connect_tab interface.
allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Browser Automation with Crawlio Browser

## When to Use

Use this skill when the user wants to:
- Inspect, test, or interact with a live web page
- Take screenshots or capture accessibility snapshots
- Monitor network traffic, console logs, or errors
- Detect frameworks (React, Vue, Angular, Next.js, etc.)
- Click buttons, fill forms, type text, or navigate
- Read cookies, localStorage, sessionStorage, or IndexedDB
- Capture performance metrics, security state, or service workers
- Record browser sessions to capture interactions, navigation, network, and console as structured data
- Capture canonical RecordingBundle v1 training artifacts with `recording_start` / `recording_stop`
- Train replayable robots from human-guided demonstrations with `robot_training_*`
- Automate multi-step browser workflows

## Connection (Always First)

Before any browser operation, connect to a tab:

```
connect_tab({ url: "https://example.com" })
```

- Opens a new tab if no matching tab is found
- Attaches CDP debugger automatically
- Omit `url` to connect to the currently active tab

Check connection status anytime:
```js
return await bridge.send({ type: "get_connection_status" })
```

## Critical Rules

1. **ALWAYS `search` before `execute`** when you're unsure of a command name or its parameters. Never guess command names — they will fail.
2. **Return values are objects**, not primitives. Always destructure or access properties (see Return Value Shapes below).
3. **`close_tab` requires `tabId`** — it will error without one. Get tabId from `list_tabs` or `connect_tab`.
4. **`connect_tab` before any interaction** — most commands require an active tab connection.
5. **`smart.evaluate` returns `{ result, type }`** — NOT the raw value. Access `.result` to get the value. Never `JSON.parse()` the return directly.
6. **Keep scripts fast** — each `execute` call should complete in <15s. Split loops over many elements into separate `execute` calls. Never loop 5+ `smart.click` calls in one script.
7. **Canonical recording order matters** — start network before recording, dump state before stop, fetch bodies before `stop_network_capture`, and keep the monitor event-driven.

## Evidence Protocol

For research tasks (page analysis, comparison, auditing), follow **Acquire → Normalize → Analyze**:

1. **Acquire** — use `smart.extractPage()` for structured evidence (7 parallel ops: capture + perf + security + fonts + meta + accessibility + mobile-readiness, with typed gaps). Use `smart.scrollCapture()` for visual evidence. Use `smart.waitForIdle()` instead of `sleep()`.
2. **Normalize** — `extractPage` returns `{ capture, performance, security, fonts, meta, accessibility, mobileReadiness, gaps }`. Check `gaps[]` before trusting supplementary data — failed calls produce `null` + a gap record.
3. **Analyze** — use `smart.finding({ claim, evidence, sourceUrl, confidence, method, dimension? })` to create validated findings. Confidence auto-caps when dimension has active gap with `reducesConfidence`.

For comparisons, use `smart.comparePages(urlA, urlB)` — returns `{ siteA, siteB, scaffold }` with 11 fixed comparison dimensions.

Retrieve all findings with `smart.findings()`. Reset with `smart.clearFindings()`.

## Anti-Patterns

1. **No `smart.screenshot()`** — it does not exist. Use `bridge.send({ type: 'take_screenshot' })` or `smart.scrollCapture()` for multi-section visual evidence.
2. **No blind `sleep()` loops** — use `smart.waitForIdle()` (MutationObserver-based, 15s cap) or `smart.waitFor(selector)`.
3. **No manual scroll+screenshot loops** — use `smart.scrollCapture({ maxSections: 10 })`. It handles bottom detection, stuck scroll, and scroll reset.
4. **No raw `capture_page` + `detect_framework` combo** — `smart.extractPage()` does both plus 5 more operations in one call with graceful failure.
5. **`capture_page` returns ~1KB shaped summary** — counts and top errors, not raw arrays. For raw network data use `stop_network_capture`. For raw console logs use `get_console_logs`.
6. **No `smart.snapshot({ compact: true })`** — the `compact` option does not exist. Use `smart.snapshot()` with no options, or `{ interactive: true }` for clickable elements only.
7. **No `location.href = "..."` for navigation** — use `smart.navigate(url)`. Direct location assignment breaks CDP debugger attachment.

## Core Patterns via `execute`

All browser commands run inside the `execute` tool. The code has access to:
- `bridge` — WebSocket bridge to the Chrome extension
- `crawlio` — HTTP client for Crawlio desktop app
- `smart` — auto-waiting wrappers with framework-aware data accessors
- `sleep(ms)` — async wait (max 30s)
- `TIMEOUTS` — per-command timeout constants

### Navigation

```js
return await smart.navigate("https://example.com")
```

### Screenshots

```js
return await bridge.send({ type: 'take_screenshot' })
```

Returns `{ screenshot: string }` (base64 PNG). For full-page: `bridge.send({ type: 'take_screenshot', fullPage: true })`.

### OCR Text Extraction (macOS only)

```
ocr_screenshot({ fullPage: true })
```

Takes a CDP screenshot, runs it through macOS Vision.framework (`VNRecognizeTextRequest`), and returns recognized text with confidence scores and bounding regions. Works on canvas elements, images rendered as pixels, anti-scraping sites, and any visual content invisible to DOM extraction.

Parameters:
- `fullPage` (bool, opt): Capture full scrollable page instead of viewport.
- `selector` (string, opt): CSS selector to screenshot a specific element.

Returns up to 20 regions (sorted by confidence), each with `text`, `confidence` (0-1), and `bounds` (x, y, width, height in normalized coordinates).

### Click an Element

```js
return await smart.click("button.submit")
```

Auto-waits for the element to be visible and actionable before clicking.

### Type Text

```js
await smart.type("input[name='email']", "user@example.com")
return await smart.snapshot()
```

### Fill a Form

```js
await bridge.send({
  type: "browser_fill_form",
  selector: "form#login",
  values: { username: "admin", password: "secret" }
})
return await smart.snapshot()
```

### Accessibility Snapshot

```js
return await smart.snapshot()
```

Returns `{ snapshot: string }` — the a11y tree text with `[ref=X]` labels on interactive elements. Use this to discover available elements when selectors fail.

Snapshot refs like `[ref=e3]` work directly with `smart.click`, `smart.type`, and `smart.waitFor`:

```js
const snap = await smart.snapshot()
// snap.snapshot contains: [ref=e3] button "Platform" ...
await smart.click('[ref=e3]')  // clicks via the snapshot ref system (not CSS)
```

These refs are resolved from the cached snapshot — they are NOT CSS selectors. They bypass `document.querySelector` and use CDP node resolution instead.

### Evaluate JavaScript

```js
const res = await smart.evaluate("document.title")
return res.result  // "My Page Title" — always access .result!
```

**`smart.evaluate` returns `{ result: <value>, type: <string> }`, NOT the raw value.** You must access `.result` to get the actual value.

For multi-statement evaluation, just use `return` — it auto-wraps in an IIFE:

```js
const res = await smart.evaluate(`
  const links = Array.from(document.querySelectorAll('a[href]'));
  return links.map(a => ({ text: a.textContent.trim(), href: a.href }));
`)
return res.result  // [{text: "Home", href: "..."}, ...]
```

**WRONG — do NOT `JSON.stringify` inside evaluate then `JSON.parse` outside:**

```js
// BAD — will cause "[object Object]" is not valid JSON
const res = await smart.evaluate(`return JSON.stringify(data)`)
return JSON.parse(res)  // WRONG: res is {result: "...", type: "string"}, not a string

// GOOD — return objects directly, CDP serializes them for you
const res = await smart.evaluate(`return data`)
return res.result  // the actual JS object/array
```

### Framework Detection

```js
return await bridge.send({ type: "detect_framework" })
```

Returns detected framework name, version, and metadata.

### Framework-Specific Data

After connecting to a page, `smart` auto-detects the framework and exposes typed accessors:

```js
// React
const version = await smart.react?.getVersion()

// Next.js
const nextData = await smart.nextjs?.getData()
return { page: nextData?.page, buildId: nextData?.buildId }

// Vue
const config = await smart.vue?.getConfig()

// Redux store
const state = await smart.redux?.getStoreState()
```

Available framework namespaces: `react`, `vue`, `angular`, `svelte`, `nextjs`, `nuxt`, `remix`, `gatsby`, `shopify`, `wordpress`, `laravel`, `django`, `drupal`, `alpine`, `redux`, `jquery`.

### Cookies

```js
return await bridge.send({ type: "get_cookies" })
```

### Storage (localStorage / sessionStorage)

```js
return await bridge.send({ type: "get_storage", storageType: "local" })
```

## Network Capture Pattern

Capture network traffic during interactions:

```js
await bridge.send({ type: "start_network_capture" })

// ... perform interactions ...
await smart.click("button.load-data")
await sleep(2000)

return await bridge.send({ type: "stop_network_capture" })
```

## Console Logs

```js
return await bridge.send({ type: "get_console_logs" })
```

## Page Capture (All-in-One)

Capture framework, network, console, DOM, and cookies in one call:

```js
return await bridge.send({ type: "capture_page" })
```

Returns a **shaped summary** (~1KB) instead of raw arrays (~50KB+):
```json
{
  "url": "...", "title": "...", "framework": {...}, "capturedAt": "...",
  "network": { "total": 47, "failed": 2, "byType": {...}, "errors": [...] },
  "console": { "total": 23, "errors": [...], "warnings": 5, "info": 10, "debug": 8 },
  "cookies": { "total": 12, "names": ["session", "_ga", ...] },
  "dom": { "nodeCount": 342, "forms": 1, "links": 15, "images": 8, "inputs": 4 }
}
```

To drill down, call individual tools: `get_console_logs`, `get_dom_snapshot`, `get_cookies`, or `stop_network_capture`.

## Session Recording

Record a full browser session — every interaction, navigation, network request, and console log — as structured JSON.

For full robot-training captures that also persist monitor snapshots, response bodies, and `flows.jsonl`, use the **robot-training** skill and the `robot_training_start/status/stop/artifacts` MCP tools.

### Start Recording

```
start_recording({ maxDurationSec: 300, maxInteractions: 100 })
```

Returns `{ sessionId, startedAt, tabId, url }`. Both params optional (defaults: 300s / 200 interactions).
- `maxDurationSec`: 10–600 (validated by Zod)
- `maxInteractions`: 1–500 (validated by Zod)

### Check Status

```
get_recording_status({})
```

Returns `{ active, sessionId, durationSec, pageCount, interactionCount, currentPageUrl }`. Permission-exempt (safe to poll).

### Stop and Get Session

```
stop_recording({})
```

Returns the full session:
- `pages[]` — one per URL visited, each with `interactions[]`, `console[]`, `network[]`
- `metadata` — tabId, initialUrl, stopReason (`manual` | `max_duration` | `max_interactions` | `tab_closed` | `disconnect`)
- `duration` — total seconds

### Workflow via Execute

```js
// Start recording
const session = await bridge.send({ type: "start_recording", maxDurationSec: 120 })
// ... user interacts with the page ...
const status = await bridge.send({ type: "get_recording_status" })
// Stop and get full session
const result = await bridge.send({ type: "stop_recording" })
return result
```

## Tab Management

```js
// List all tabs
return await bridge.send({ type: "list_tabs" })

// Create a new tab
return await bridge.send({ type: "create_tab", url: "https://example.com" })

// Switch to a tab
return await bridge.send({ type: "switch_tab", tabId: 123 })

// Close a tab
return await bridge.send({ type: "close_tab", tabId: 123 })
```

## Discovery via Search

When you don't know the exact command, search first:

```
search({ query: "cookies" })
```

This returns matching command names, descriptions, and parameter schemas from the full catalog of 178 commands (145 browser + 33 desktop).

## Desktop Integration (Crawlio App)

If the Crawlio desktop app is running, use the HTTP client:

```js
// Check status
return await crawlio.api("GET", "/status")

// Start a crawl
return await crawlio.api("POST", "/start", { url: "https://example.com" })

// Get settings
return await crawlio.api("GET", "/settings")

// Export site
return await crawlio.api("POST", "/export", { format: "zip", destinationPath: "/tmp/site.zip" })
```

## Return Value Shapes

Commands return **objects**, not primitives. Always access the correct property.

### smart methods

```js
// smart.snapshot() → { snapshot: string }
const snap = await smart.snapshot();
const tree = snap.snapshot;  // the a11y tree text
// WRONG: snap.split('\n')  — snap is an object, not a string

// smart.evaluate(expr) → { result: any, type: string }
const res = await smart.evaluate("document.title");
const title = res.result;  // the actual value — "My Page"
const type = res.type;     // "string", "number", "object", etc.
// WRONG: res.substring()      — res is {result, type}, not the raw value
// WRONG: JSON.parse(res)      — will get "[object Object]" is not valid JSON
// WRONG: JSON.stringify inside + JSON.parse outside — just return objects directly
```

### bridge.send commands

```js
// list_tabs → { tabs: Tab[], connectedTabId: number|null }
const result = await bridge.send({ type: 'list_tabs' });
const tabs = result.tabs;           // array of tab objects
const connected = result.connectedTabId;

// connect_tab → { action, tabId, url, title, windowId, capturing, domainState }
const tab = await bridge.send({ type: 'connect_tab', tabId: 123 });

// capture_page → { url, title, framework, network, console, cookies, dom, capturedAt }
const page = await bridge.send({ type: 'capture_page' });

// take_screenshot → { screenshot: string }  (base64 PNG)
const ss = await bridge.send({ type: 'take_screenshot' });

// get_cookies → { cookies: Cookie[] }
const result = await bridge.send({ type: 'get_cookies' });
const cookies = result.cookies;

// get_console_logs → { logs: LogEntry[] }
const result = await bridge.send({ type: 'get_console_logs' });
const logs = result.logs;

// close_tab → requires tabId!
await bridge.send({ type: 'close_tab', tabId: 123 });  // REQUIRED
// WRONG: bridge.send({ type: 'close_tab' })  — will error
```

### Network capture (start/stop pattern — no `get_network_entries`)

```js
await bridge.send({ type: 'start_network_capture' });
// ... interactions ...
const result = await bridge.send({ type: 'stop_network_capture' });
const entries = result.entries;  // array of network entries
// WRONG: bridge.send({ type: 'get_network_entries' })  — does NOT exist
```

## Error Handling

| Error | Solution |
|-------|----------|
| "No tab connected" | Call `connect_tab` first |
| "Element not found" | Use `smart.snapshot()` to see available elements, then adjust selector |
| "Extension disconnected" | Check that the Chrome extension is installed and the popup shows "Connected" |
| "timed out after 30000ms" | Script too slow — reduce interactions per call, use evaluate instead of click loops |
| "[object Object]" not valid JSON | You called `JSON.parse` on a `{result, type}` object — use `.result` first |
| "Permission required" | Click the Crawlio extension icon and grant permissions |

## Script Performance Rules

Each `execute` call has a 120s internal timeout, but **MCP clients may impose shorter timeouts** (30s is common). Keep scripts fast:

- **Max 3-4 interactions per script** — each `smart.click`/`smart.type` costs ~1-2s (actionability polling + settle time)
- **Never loop 5+ clicks** — split into multiple `execute` calls instead
- **Minimize `sleep()` calls** — use `smart.waitFor(selector)` instead of `sleep(2000)`
- **Avoid `JSON.stringify` in evaluate** — return objects directly, CDP serializes automatically

### BAD — will timeout (8 clicks × ~1.5s + sleeps = ~16s minimum)

```js
for (let i = 18; i <= 25; i++) {
  await smart.click(`[ref=e${i}]`)
  await sleep(300)
}
```

### GOOD — one evaluate call reads all the data at once

```js
const res = await smart.evaluate(`
  const items = document.querySelectorAll('.faq-item');
  return Array.from(items).map(el => ({
    question: el.querySelector('h3')?.textContent?.trim(),
    answer: el.querySelector('.answer')?.textContent?.trim()
  }));
`)
return res.result
```

## Multi-Step Workflow Example

```js
// 1. Navigate to login page
await smart.navigate("https://app.example.com/login")

// 2. Fill credentials
await smart.type("#email", "user@example.com")
await smart.type("#password", "secret123")

// 3. Click login
await smart.click("button[type='submit']")
await smart.waitFor(".dashboard")  // prefer waitFor over sleep

// 4. Verify navigation
const title = (await smart.evaluate("document.title")).result
return { title, url: (await smart.evaluate("location.href")).result }
```

## Higher-Order Methods (17)

These methods compose existing bridge commands into common workflows. The `smart` object exposes 7 core methods + 17 higher-order methods + up to 17 framework namespaces.

### Evidence Extraction

```js
// Full page extraction — 7 parallel ops: capture + perf + security + fonts + meta + a11y + mobile
// Returns PageEvidence with gaps[] tracking what failed
const page = await smart.extractPage()

// Compare two pages — navigates to each, runs extractPage(), returns ComparisonEvidence + scaffold
const diff = await smart.comparePages("https://a.com", "https://b.com")

// Scroll through page with screenshots — stops at page bottom, handles stuck scroll
const result = await smart.scrollCapture({ maxSections: 10, pixelsPerScroll: 800, settleMs: 1000 })

// Wait for DOM to settle (500ms quiet window) — use instead of sleep()
const idle = await smart.waitForIdle(5000)  // returns { status: 'idle' | 'timeout' }

// Diff accessibility snapshots before/after an interaction
const diff = await smart.diffSnapshots(beforeSnapshot)
```

### Findings (Evidence Mode)

```js
// Create a validated finding — confidence auto-caps if dimension has active gap
smart.finding({
  claim: "Site loads 2x faster",
  evidence: ["LCP: 1200ms vs 2400ms"],
  sourceUrl: "https://example.com",
  confidence: "high",
  method: "extractPage",
  dimension: "performance"  // optional — triggers confidence propagation
})

// Get all accumulated findings from this session
const allFindings = smart.findings()

// Reset session findings and gaps
smart.clearFindings()
```

### Data Extraction

```js
// Detect table-like structures in the DOM — returns scored candidates
const tables = await smart.detectTables()

// Extract data from a specific table element
const data = await smart.extractTable("table.pricing")

// Wait for network to become idle (no pending requests)
const idle = await smart.waitForNetworkIdle(5000)

// Compound extraction — detect tables + extract + network idle
const extracted = await smart.extractData()
```

### Tracking & Technology Detection

```js
// Parse tracking pixels from captured network requests (GA, FB, etc.)
const pixels = await smart.parseTrackingPixels()

// Schema-validate tracking parameters, detect typos
const issues = await smart.validateTracking()

// Read runtime tracker state (GTM dataLayer, etc.)
const dataLayer = await smart.inspectDataLayer()

// Find duplicate tracking events
const dupes = await smart.detectDuplicates()

// Fingerprint-based technology detection
const tech = await smart.detectTechnologies()
```

For multi-page research protocols (competitive analysis, site audits), see the **web-research** skill.

## Reference

See [reference.md](./reference.md) for a curated reference with parameters. For the complete, current surface run `crawlio-browser tools --full`, or `search` it from inside `execute` — both read the live builders, so neither can go stale.
