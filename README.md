# Crawlio Browser

[![npm version](https://img.shields.io/npm/v/crawlio-browser)](https://www.npmjs.com/package/crawlio-browser)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Crawlio-app/crawlio-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/Crawlio-app/crawlio-browser/actions/workflows/ci.yml)

## [Documentation](https://docs.crawlio.app/browser-agent/overview) | [API Reference](https://docs.crawlio.app/browser-agent/tools) | [Chrome Extension](https://www.crawlio.app/browser-agent)

MCP server that gives AI full control of a live Chrome browser via CDP. <!--n:full-->145<!--/n--> tools with framework-aware intelligence, typed evidence infrastructure, tracking pixel analysis, technographic fingerprinting, SEO auditing, and confidence-tracked findings — captures what static crawlers can't see.

## When to use Crawlio Browser

Use Crawlio Browser when your AI needs to interact with a **real browser** — SPAs, authenticated pages, dynamic content, JS-rendered frameworks. Unlike headless browser tools, Crawlio Browser connects to **your actual Chrome** via a lightweight extension, giving the AI access to your logged-in sessions, cookies, and full browser state.

**Crawlio Browser vs headless browser tools:** Headless tools launch a separate browser process. Crawlio Browser connects to your existing Chrome — no separate browser, no login flows, full access to your tabs and sessions.

> [!WARNING]
> This is the trade-off, stated plainly: connecting your own Chrome is the feature, and it means
> an AI agent can act as you on every site you are logged into. It attaches Chrome's debugger to
> the tab you connect, so it can read cookies, storage, and page content for that session.
>
> Review what you connect it to. Prefer a dedicated Chrome profile for agent work. Nothing is
> captured until you connect a tab, and you can see the exact tool surface before configuring
> anything by running `npx crawlio-browser tools`. Sites can opt out with
> `<meta name="crawlio-agent" content="disable">`, which the extension honors.

## Quick Start

1. Install the [Chrome Extension](https://www.crawlio.app/browser-agent)
2. Run the init wizard:
   ```bash
   npx crawlio-browser init
   ```

That's it. Auto-detects and configures 14 MCP clients: Claude Code, Cursor, VS Code, Codex, Gemini CLI, Claude Desktop, ChatGPT Desktop, Windsurf, Cline, Zed, Goose, OpenCode, MCPorter, and Cline CLI.

### Init wizard options

```bash
npx crawlio-browser init              # Default: code mode, stdio transport
npx crawlio-browser init --full       # Full mode (every tool exposed individually)
npx crawlio-browser init --portal     # Portal mode (persistent HTTP server)
npx crawlio-browser init --cloudflare # Add Cloudflare MCP (89 tools, no wrangler)
npx crawlio-browser init --dry-run    # Show what would happen
npx crawlio-browser init --yes        # Skip prompts (CI / scripted installs)
npx crawlio-browser init -a claude    # Target specific MCP client
```

### Inspecting what it exposes

```bash
npx crawlio-browser tools          # What code mode exposes (the default)
npx crawlio-browser tools --full   # Every tool, individually
npx crawlio-browser tools --json   # Machine-readable, for diffing across versions
npx crawlio-browser doctor         # Bridge, portal, native host, client configs
```

Both are read-only and run without a browser, an extension, or a network connection — you can
see the whole surface before you configure any client. The numbers come from the same builders
the server registers, so they cannot disagree with what your client receives.

### Transport Modes

| Mode | Command / URL | Protocol | Best For |
|------|--------------|----------|----------|
| **stdio** | `npx crawlio-browser` | JSON-RPC over stdin/stdout | Claude Desktop, Cursor, Windsurf — client manages process lifecycle |
| **Portal (HTTP)** | `POST http://127.0.0.1:3001/mcp` | MCP Streamable HTTP | Claude Code, ChatGPT Desktop — server survives session restarts |
| **Portal (SSE)** | `GET /sse` + `POST /message` | Server-Sent Events | Legacy clients needing SSE transport |

Portal mode is recommended for Claude Code — the server persists across context compaction and session restarts. On macOS, `--portal` installs a launchd agent for auto-start on login.

### Manual setup (any client)

<details>
<summary><b>Per-client manual config</b></summary>

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{ "mcpServers": { "crawlio-browser": { "command": "npx", "args": ["-y", "crawlio-browser"] } } }
```

**Claude Code (Portal Mode)** — start `npx crawlio-browser --portal`, then add to `.mcp.json`:
```json
{ "mcpServers": { "crawlio-browser": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

**Claude Code (stdio):**
```bash
claude mcp add crawlio-browser -- npx -y crawlio-browser
```

**Cursor** — add to `.cursor/mcp.json`:
```json
{ "mcpServers": { "crawlio-browser": { "command": "npx", "args": ["-y", "crawlio-browser"] } } }
```

**Windsurf** — add to Windsurf Settings > MCP:
```json
{ "mcpServers": { "crawlio-browser": { "command": "npx", "args": ["-y", "crawlio-browser"] } } }
```

**Cline (VS Code)** — add to `settings.json`:
```json
{ "cline.mcpServers": { "crawlio-browser": { "command": "npx", "args": ["-y", "crawlio-browser"] } } }
```

**ChatGPT Desktop** — Settings > Integrations > MCP:
URL: `http://127.0.0.1:3001/mcp` | Type: Streamable HTTP

</details>

## How It Works

```
AI Client (stdio/http)  -->  MCP Server (Node.js)  -->  Chrome Extension (MV3)
                             crawlio-browser               WebSocket -> CDP
```

The MCP server communicates with the Chrome extension via WebSocket. The extension controls the browser through Chrome DevTools Protocol (CDP).

## Capabilities

### Framework-Aware Intelligence

Every `execute` call probes the browser for framework signatures and injects a shape-shifting `smart` object with framework-native accessors. React state, Vue reactivity, Next.js routing, Shopify cart data — 17 framework namespaces across 4 tiers, detected at runtime and rebuilt on every navigation. The AI doesn't query a generic DOM; it queries the framework's own data structures.

### Evidence-Based Analysis

Method Mode adds higher-order methods and a typed evidence system on top of Code Mode. `smart.extractPage()` runs 7 parallel operations in a single call — page capture, performance metrics, security state, font detection, meta extraction, accessibility audit, and mobile-readiness check. Failed operations produce typed `CoverageGap` records instead of silent `null`s. Findings created with `smart.finding()` get their confidence automatically adjusted when supporting data is missing. The result: structured, auditable research output with gap tracking and confidence propagation.

### Session Recording & Replay

Record browser interactions as structured data, then compile them into reusable SKILL.md automations. 12 interaction tools are automatically intercepted during recording — clicks, typing, navigation, scrolling — each capturing args, result, timing, and page URL. One `compileRecording()` call converts the session into a deterministic automation script.

### Robot Training

Capture human-guided browser demonstrations as replayable robot-training bundles. `robot_training_start` opens a fresh connected tab, starts CDP network capture and session recording, injects an event-driven state monitor, and `robot_training_stop` persists `recording.json`, `network.json`, response bodies, state snapshots, and `flows.jsonl` for API synthesis or background replay.

### Auto-Settling & Actionability

Every mutative action (`click`, `type`, `navigate`, `select_option`) runs actionability checks before acting — polling visibility, dimensions, enabled state, and overlay detection. After the action, a progressive backoff settle delay (`[0, 20, 100, 100, 500]ms`) waits for DOM mutations to quiesce. The AI doesn't need manual `sleep()` calls between actions.

## Architecture

A layered execution architecture where each layer absorbs a category of complexity that would otherwise fall on the model. The model sees three tools and a clean SDK. Everything beneath that surface is the runtime absorbing reality.

The layer worth understanding is the one that assembles itself. Detection runs against the live page on first use, and the `smart` object is built to match what that page turned out to be — `smart.react.*` exists only where React does. Nothing about the target is known at startup, so the surface is composed per tab rather than declared up front.

```
                     ┌───────────────────────────────────┐
                     │        AI Model (LLM)             │
                     │  Writes code, reads errors, loops  │
                     └───────────────┬───────────────────┘
                                     │  search, execute, connect_tab (+ 3 job tools)
                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Crawlio Browser runtime                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  METHOD MODE                                               │  │
│  │  Behavioral protocol + higher-order methods                │  │
│  │  scrollCapture · waitForIdle · extractPage · comparePages  │  │
│  │  detectTables · extractTable · waitForNetworkIdle ·        │  │
│  │  extractData                                               │  │
│  │                                                            │  │
│  │  ↳ Absorbs: behavioral variance, ad-hoc composition,      │  │
│  │    inconsistent output shapes, data extraction patterns    │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  POLYMORPHIC CONTEXT                                       │  │
│  │  17 framework namespaces, injected Just-In-Time            │  │
│  │  react · vue · angular · nextjs · shopify · ...            │  │
│  │                                                            │  │
│  │  ↳ Absorbs: framework opacity, minified code,             │  │
│  │    devtools hook complexity                                │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  ACTIONABILITY ENGINE                                      │  │
│  │  7 core smart methods with built-in resilience             │  │
│  │  click · type · navigate · waitFor · evaluate ·            │  │
│  │  snapshot · screenshot                                     │  │
│  │                                                            │  │
│  │  ↳ Absorbs: DOM timing, hydration delays, CSS animations, │  │
│  │    disabled states, overlapping elements                   │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  TETHERED IPC BRIDGE                                       │  │
│  │  WebSocket ↔ Chrome extension, message queue,              │  │
│  │  heartbeat, auto-reconnect, stale detection                │  │
│  │                                                            │  │
│  │  ↳ Absorbs: connection drops, tab refreshes,              │  │
│  │    port conflicts, extension lifecycle                     │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │  COMMAND CHANNEL                                           │  │
│  │  bridge.send → CDP browser control via the extension       │  │
│  │  crawlio.*   → Crawlio HTTP endpoints                      │  │
│  │  178 searchable across both (145 browser + 33 HTTP)        │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────────┐
                     │         Live Chrome Browser        │
                     │   Persistent session, real DOM,    │
                     │   framework runtime, user state    │
                     └───────────────────────────────────┘
```

### What Each Layer Absorbs

| Layer | Without It | With It |
|-------|-----------|---------|
| **Tethered IPC Bridge** | Script crashes on tab refresh, pending commands lost on reconnect, port conflicts on startup | Resilient WebSocket with message queue (100-msg capacity), heartbeat stale detection (15s intervals), auto-reconnect with drain |
| **Actionability Engine** | `click('#btn')` fires before the button renders, during CSS transitions, or while an overlay covers it | Progressive polling (exists → has dimensions → visible → not disabled → not obscured) with `[0, 20, 100, 100, 500]ms` backoff |
| **Polymorphic Context** | Model sees minified `<div>` elements; reading React state requires knowing exact hook paths, renderer maps, and fiber root API | Runtime probes live JS environment, recognizes <!--n:frameworks-->64<!--/n--> frameworks and attaches up to <!--n:ns-->17<!--/n--> matching namespaces (`smart.react.getVersion()`, `smart.nextjs.getData()`) |
| **Method Mode** | Model composes primitives ad-hoc — inconsistent scroll loops, missed edge cases, varying return shapes | <!--n:higher-->18<!--/n--> tested methods encode correct patterns; behavioral protocol constrains workflow |

### Execution Lifecycle

1. **Discovery** — Model calls `search("page capture performance")` and gets documentation for relevant commands
2. **Framework Detection** — Runtime probes the live DOM, detects active frameworks, constructs polymorphic `smart` object with appropriate namespaces
3. **Scope Assembly** — Model's code is compiled into an async function with injected parameters: `bridge` (the browser command channel), `crawlio` (HTTP client), `sleep`, `TIMEOUTS`, `smart` (<!--n:core-->7<!--/n--> core + <!--n:higher-->18<!--/n--> higher-order methods + up to <!--n:ns-->17<!--/n--> framework namespaces), `compileRecording`
4. **Execution** — Method Mode methods compose the lower layers: `extractPage()` fires 7 parallel `bridge.send()` calls; `click()` runs the actionability engine; `react.getVersion()` evaluates framework-specific expressions
5. **Error Recovery (Agentic REPL)** — On failure, the browser stays in the exact state that produced the error. The model reads the structured error, adjusts, and calls `execute` again. Framework cache persists — no re-detection unless URL changed

### Design Principles

1. **Absorb complexity downward** — Every category of difficulty (connection management, DOM timing, framework detection, multi-step composition) is handled by the layer best equipped for it. The model only encounters the clean interface at the top.
2. **Shape the SDK to the target** — The polymorphic context system detects what the page is and reshapes available methods to match. The model writes against a stable interface; the runtime adapts underneath.
3. **Preserve state across cycles** — The tethered architecture means the model can fail, learn, and retry against the same live environment — transforming error handling from "restart from scratch" into "adjust and continue."

### How It Compares

Code Mode is Cloudflare's idea and a good one: present tools as a typed API and let the model
write code against it, because models have seen far more code than tool calls. Crawlio Browser
applies that pattern to a target it was not built for — a live browser holding your session.
This is an MCP server, not an alternative to MCP.

| Dimension | Standard MCP | Cloudflare Code Mode | Crawlio Browser |
|-----------|-------------|---------------------|-----------------|
| **Tools in context** | 50-100+ schemas | 2 (`search`, `execute`) | <!--n:code-->6<!--/n--> (3 primary + 3 async job tools) |
| **Execution environment** | N/A (tool calls) | V8 isolate (stateless) | Local async sandbox, tethered to a live browser |
| **DOM access** | Via individual tool calls | None | Live, persistent, framework-aware |
| **Framework awareness** | None | None | up to <!--n:ns-->17<!--/n--> namespaces, attached per page |
| **Action resilience** | Model must handle timing | N/A (no DOM) | Built-in actionability polling + settle delays |
| **Error recovery** | Re-call individual tool | Re-create isolate | Re-run against the state that produced the error |
| **Multi-step patterns** | Model improvises | Model writes loops | <!--n:higher-->18<!--/n--> tested higher-order methods + behavioral protocol |

The row that matters is error recovery. An isolate is disposable by design — that is what makes
it safe to run untrusted code, and it means a failure discards the state that caused it. Here
execution is tethered to a real tab, so when code fails the browser is still sitting in exactly
the situation that broke it: same scroll position, same modal, same half-filled form. The model
reads the error and runs again against that. Neither approach is better in general; they are
answers to different problems, and the sandboxing guarantees Cloudflare gets from V8 isolates
are genuinely stronger than what a local async sandbox provides.

[Read the full architecture guide &rarr;](https://docs.crawlio.app/browser-agent/overview)

## Two Modes

### Code Mode (3 primary tools) — default

Collapses <!--n:full-->145<!--/n--> tools into three high-level tools, plus `get_job_result`,
`list_jobs`, and `cancel_job` for async execution — so `tools/list` reports
<!--n:code-->6<!--/n-->.

That makes the `tools/list` payload **<!--n:reduction-->83<!--/n-->% smaller**, measured by
serializing the result each mode actually returns rather than estimated from a tool count. Code
mode is not free: `execute` and `search` carry long descriptions, which is why the figure is 83%
and not the ~95% a naive tools-only ratio suggests. Check it yourself — `npx crawlio-browser
tools --json` prints both surfaces without connecting to anything.

| Tool | Description |
|------|-------------|
| `search` | Discover available commands by keyword |
| `execute` | Run async JS with `bridge`, `crawlio`, `smart`, `sleep`, and `compileRecording` in scope |
| `connect_tab` | Connect to a browser tab |

```javascript
// Navigate and screenshot
await bridge.send({ type: 'browser_navigate', url: 'https://example.com' }, 30000);
await sleep(2000);
const screenshot = await bridge.send({ type: 'take_screenshot' }, 10000);
return screenshot;
```

### Full Mode (<!--n:full-->145<!--/n--> tools)

Every tool exposed directly to the LLM. Enable with `--full`:

```bash
npx crawlio-browser init --full
```

## Smart Object

In Code Mode, the `smart` object provides framework-aware helpers with auto-waiting and actionability checks.

### Core Methods

| Method | Description |
|--------|-------------|
| `smart.evaluate(expression)` | Execute JS in the page via CDP |
| `smart.click(selector, opts?)` | Auto-waiting click with 500ms settle |
| `smart.type(selector, text, opts?)` | Auto-waiting type with 300ms settle |
| `smart.navigate(url, opts?)` | Navigate with 1000ms settle |
| `smart.waitFor(selector, timeout?)` | Poll until element is actionable |
| `smart.snapshot()` | Accessibility tree snapshot |
| `smart.screenshot()` | Full-page screenshot (base64 PNG) |

### Higher-Order Methods

| Method | Description |
|--------|-------------|
| `smart.scrollCapture(opts?)` | Scroll to bottom, capturing screenshots at each position. Handles stuck-scroll detection, bottom detection, section capping, and scroll reset. |
| `smart.waitForIdle(timeout?)` | MutationObserver-based idle detection — waits for 500ms quiet window. Timeout hard-capped at 15s. Replaces blind `sleep()` calls. |
| `smart.extractPage(opts?)` | 7 parallel operations in one call — page capture, performance, security, fonts, meta, accessibility, mobile-readiness. Returns typed `PageEvidence` with `CoverageGap[]` for anything that failed. |
| `smart.comparePages(urlA, urlB)` | Navigates to both URLs, runs `extractPage()` on each, returns a `ComparisonScaffold` with 11 dimensions, shared/missing fields, and comparable metrics. |

### Typed Evidence

Methods for structured analysis findings with confidence propagation:

| Method | Description |
|--------|-------------|
| `smart.finding(data)` | Create a validated `Finding` with claim, evidence, sourceUrl, confidence, and method. Rejects malformed input with specific errors. |
| `smart.findings()` | Get all session-accumulated findings (returns a copy) |
| `smart.clearFindings()` | Reset session findings and coverage gaps |

When a finding's `dimension` matches an active coverage gap, confidence is automatically capped:

| Input Confidence | Active Gap | Output |
|-----------------|------------|--------|
| `high` | `reducesConfidence: true` | `medium` + `confidenceCapped: true` |
| `medium` | `reducesConfidence: true` | `low` + `confidenceCapped: true` |
| `low` | any | `low` (floor) |
| any | no matching gap | unchanged |

### Framework Namespaces

When a framework is detected, the smart object exposes framework-specific helpers:

<details>
<summary><b>React</b> — <code>smart.react</code></summary>

| Method | Returns |
|--------|---------|
| `getVersion()` | Version string and bundle type |
| `getRootCount()` | Number of React root components |
| `hasProfiler()` | Whether profiler is available |
| `isHookInstalled()` | Whether DevTools hook is installed |

</details>

<details>
<summary><b>Vue.js</b> — <code>smart.vue</code></summary>

| Method | Returns |
|--------|---------|
| `getVersion()` | Vue version string |
| `getAppCount()` | Number of Vue app instances |
| `getConfig()` | App config object |
| `isDevMode()` | Whether DevTools is enabled |

</details>

<details>
<summary><b>Angular</b> — <code>smart.angular</code></summary>

| Method | Returns |
|--------|---------|
| `getVersion()` | ng-version attribute value |
| `isDebugMode()` | Whether debug APIs available |
| `isIvy()` | Whether Ivy compiler is active |
| `getRootCount()` | Number of Angular root elements |
| `getState()` | Full state object |

</details>

<details>
<summary><b>Svelte</b> — <code>smart.svelte</code></summary>

| Method | Returns |
|--------|---------|
| `getVersion()` | Svelte version string |
| `getMeta()` | Svelte metadata object |
| `isDetected()` | Whether Svelte is detected |

</details>

<details>
<summary><b>Redux</b> — <code>smart.redux</code></summary>

| Method | Returns |
|--------|---------|
| `isInstalled()` | Whether Redux DevTools is installed |
| `getStoreState()` | Full store state |

</details>

<details>
<summary><b>Alpine.js</b> — <code>smart.alpine</code></summary>

| Method | Returns |
|--------|---------|
| `getVersion()` | Alpine version string |
| `getStoreKeys()` | Store object keys |
| `getComponentCount()` | Count of `[x-data]` components |

</details>

<details>
<summary><b>Next.js</b> — <code>smart.nextjs</code></summary>

| Method | Returns |
|--------|---------|
| `getData()` | `__NEXT_DATA__` object |
| `getRouter()` | Router state (pathname, query, asPath) |
| `getSSRMode()` | SSR mode (hybrid, app-router, static) |
| `getRouteManifest()` | Current page data |

</details>

<details>
<summary><b>Nuxt</b> — <code>smart.nuxt</code></summary>

| Method | Returns |
|--------|---------|
| `getData()` | `__NUXT__` object |
| `getConfig()` | App config |
| `isSSR()` | Whether server-rendered |

</details>

<details>
<summary><b>Remix</b> — <code>smart.remix</code></summary>

| Method | Returns |
|--------|---------|
| `getContext()` | `__remixContext` object |
| `getRouteData()` | Loader data from state |

</details>

<details>
<summary><b>Shopify</b> — <code>smart.shopify</code></summary>

| Method | Returns |
|--------|---------|
| `getShop()` | Shop metadata (theme, locale, currency) |
| `getCart()` | Shopping cart object |

</details>

<details>
<summary><b>WordPress</b> — <code>smart.wordpress</code></summary>

| Method | Returns |
|--------|---------|
| `isWP()` | Whether WordPress is present |
| `getRestUrl()` | REST API endpoint |
| `getPlugins()` | List of active plugins |

</details>

<details>
<summary><b>More frameworks</b> — Gatsby, WooCommerce, Laravel, Django, Drupal, jQuery</summary>

| Namespace | Methods |
|-----------|---------|
| `smart.gatsby` | `getData()`, `getPageData()` |
| `smart.woocommerce` | `getParams()` |
| `smart.laravel` | `getCSRF()` |
| `smart.django` | `getCSRF()` |
| `smart.drupal` | `getSettings()` |
| `smart.jquery` | `getVersion()` |

</details>

## Method Mode

Code Mode asks the model to write code. Method Mode gives that code a tested vocabulary:
<!--n:higher-->18<!--/n--> higher-order methods that encode the multi-step patterns a model
would otherwise improvise.

```javascript
await smart.extractTable(selector)   // not a hand-rolled scrape loop
await smart.scrollCapture()          // not a guessed scroll cadence
```

It is a domain layer over Code Mode, not a replacement: the tool surface does not change, the
model still sees the same three primary tools, and the same <!--n:catalog-->178<!--/n-->-command
catalog sits underneath. What changes is what happens *inside* `execute`.

The surface is assembled per page. Detection recognizes <!--n:frameworks-->64<!--/n-->
frameworks and attaches up to <!--n:ns-->17<!--/n--> matching namespaces, so `smart.react.*`
exists only where React does — the model never has to ask what the page is built with, or guess
at hook paths and fiber internals to find out.

And because execution is tethered to a live tab rather than a disposable isolate, a failure
leaves the browser in the exact state that produced it. The model reads the structured error and
runs again against that state, rather than rebuilding the situation from scratch.

### The Maturity Ladder

| Layer | Optimizes For | Behavioral Variance | Evidence Quality |
|-------|---------------|---------------------|-----------------|
| **Raw MCP** (<!--n:full-->145<!--/n--> tools) | Completeness | High — flat tool list, no composition guidance | None — unstructured text |
| **Code Mode** (<!--n:code-->6<!--/n--> tools) | Token efficiency | Medium — right primitives, ad-hoc composition | None — model-defined shapes |
| **Method Mode** (+ <!--n:higher-->18<!--/n--> methods + protocol) | Consistency | Low — proper methods, protocol constraints | Convention — `{ finding, evidence, url }` |
| **+ typed evidence** (gaps + confidence) | Correctness | Minimal — typed schemas, tool-enforced findings | Structural — typed records, gap tracking, confidence propagation |

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                      execute sandbox                       │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Behavioral Protocol  (web-research skill)           │  │
│  │  Acquire → Normalize → Analyze                       │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  Evidence Infrastructure                             │  │
│  │  finding() · findings() · clearFindings()            │  │
│  │  Typed records · Coverage gaps · Confidence prop.    │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  Higher-Order Methods  [18]                          │  │
│  │  scrollCapture · waitForIdle · extractPage ·         │  │
│  │  comparePages · detectTables · extractTable ·        │  │
│  │  waitForNetworkIdle · extractData · detectSections · │  │
│  │  detectTechnologies · parseTrackingPixels · ...      │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  Smart Core  [7 methods]                             │  │
│  │  evaluate · click · type · navigate · waitFor ·      │  │
│  │  snapshot · rebuild                                  │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  Framework Namespaces  [up to 17, attached per page] │  │
│  │  react · vue · angular · nextjs · shopify · ...      │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │  bridge.send()  — the browser command channel        │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

Each layer up encodes more domain knowledge. `bridge.send({ type: "capture_page" })` captures a page. `smart.extractPage()` captures a page AND runs performance metrics, security state, font detection, accessibility analysis, and mobile-readiness checks in parallel — seven operations, one call, graceful failure on supplementary data, typed gaps for anything that fails.

### Evidence Infrastructure

**Coverage Gaps** — When supplementary operations in `extractPage()` fail, they don't silently return `null`. A typed gap is recorded with the dimension, reason, impact, and whether it reduces confidence on related findings:

```javascript
// Example gap from a failed performance metrics call
{ dimension: "performance", reason: "CDP domain disabled", impact: "method-failed", reducesConfidence: true }
```

**Tool-Enforced Findings** — `smart.finding()` validates every field at the tool level. The model cannot produce a finding without meeting the schema — it either returns a valid `Finding` or gets a clear error. Findings accumulate across `execute` calls within a session via `smart.findings()`.

**Session Aggregation** — Findings and coverage gaps persist across `execute` calls. A model can make findings across multiple calls, then retrieve the full set with `smart.findings()`. Reset with `smart.clearFindings()`.

### End-to-End Example: Competitive Audit

```javascript
// 1. Extract and compare both sites (scaffold + gaps included)
const comparison = await smart.comparePages(
  'https://acme.com',
  'https://rival.com'
);

// 2. Make findings — confidence auto-adjusts based on data availability
smart.finding({
  claim: 'Rival loads 2.3x faster on Largest Contentful Paint',
  evidence: [
    `Acme LCP: ${comparison.siteA.performance?.webVitals?.lcp}ms`,
    `Rival LCP: ${comparison.siteB.performance?.webVitals?.lcp}ms`,
  ],
  sourceUrl: 'https://acme.com',
  confidence: 'high',
  method: 'comparePages + extractPage performance metrics',
  dimension: 'performance',  // if perf data failed, confidence caps to "medium"
});

smart.finding({
  claim: 'Acme has 12 images without alt text; Rival has 0',
  evidence: [
    `Acme imagesWithoutAlt: ${comparison.siteA.accessibility?.imagesWithoutAlt}`,
    `Rival imagesWithoutAlt: ${comparison.siteB.accessibility?.imagesWithoutAlt}`,
  ],
  sourceUrl: 'https://acme.com',
  confidence: 'high',
  method: 'comparePages + extractPage accessibility summary',
  dimension: 'accessibility',
});

// 3. Capture visual evidence
await smart.navigate('https://acme.com');
await smart.waitForIdle();
const acmeVisuals = await smart.scrollCapture({ maxSections: 5 });

// 4. Return accumulated session findings + visual evidence
return {
  findings: smart.findings(),
  scaffold: comparison.scaffold,
  gaps: { acme: comparison.siteA.gaps, rival: comparison.siteB.gaps },
  visualEvidence: { acme: acmeVisuals.sectionCount + ' sections captured' },
};
```

## Examples

#### Navigate, extract, and analyze

```javascript
// Connect to active tab, extract structured page evidence
const page = await smart.extractPage();
const finding = smart.finding({
  claim: `Site uses ${page.capture.framework?.name || 'no detected framework'}`,
  evidence: [`Framework: ${JSON.stringify(page.capture.framework)}`],
  sourceUrl: page.meta?.canonical || 'active tab',
  confidence: 'high',
  method: 'extractPage framework detection',
});
return { page: page.meta, finding };
```

#### Mobile emulation + screenshot

```javascript
// Emulate iPhone and capture
await bridge.send({ type: 'emulate_device', device: 'iPhone 14' }, 10000);
await smart.navigate('https://example.com');
await smart.waitForIdle();
const screenshot = await smart.screenshot();
return screenshot;
```

#### Record and compile automation

```javascript
// Record a browser session, then compile to reusable skill
await bridge.send({ type: 'start_recording' }, 10000);
await smart.navigate('https://example.com');
await smart.click('button.submit');
await smart.type('#email', 'test@example.com');
const session = await bridge.send({ type: 'stop_recording' }, 10000);
return compileRecording(session.session, 'signup-flow');
```

#### Intercept and mock network

```javascript
// Block analytics, mock API response
await bridge.send({
  type: 'browser_intercept',
  pattern: '*analytics*',
  action: 'block'
}, 10000);
await bridge.send({
  type: 'browser_intercept',
  pattern: '*/api/user',
  action: 'mock',
  body: JSON.stringify({ name: 'Test User' }),
  statusCode: 200
}, 10000);
await smart.navigate('https://example.com');
return await smart.snapshot();
```

## Session Recording

Record browser sessions as structured data, then compile them into reusable automation skills. 12 interaction tools are automatically intercepted during recording (click, type, navigate, scroll, etc.), capturing args, result, timing, and page URL.

```javascript
// In code mode: record, interact, compile
await bridge.send({ type: 'start_recording' }, 10000);
// ... interact with the page ...
const session = await bridge.send({ type: 'stop_recording' }, 10000);
const skill = compileRecording(session.session, 'my-automation');
return skill;
```

In full mode, recording is available as 4 individual tools: `start_recording`, `stop_recording`, `get_recording_status`, and `compile_recording`.

## Auto-Settling

Mutative tools (`browser_click`, `browser_type`, `browser_navigate`, `browser_select_option`) use actionability checks:

1. **Pre-flight**: Polls element visibility, stability, and enabled state before acting
2. **Action**: Dispatches the CDP command
3. **Post-settle**: Waits for DOM mutations to quiesce with progressive backoff `[0, 20, 100, 100, 500]ms`

This means the AI doesn't need to manually add `sleep()` or `waitFor()` calls between actions — the tools handle SPA rendering delays automatically.

## Framework Detection

Detects **64 technologies** across 4 tiers using globals, DOM markers, meta tags, HTTP headers, and script URLs:

| Tier | Frameworks | Signal Strength |
|------|-----------|----------------|
| **Meta-frameworks** | Next.js, Nuxt, SvelteKit, Remix, Gatsby | Unique globals + parent detection |
| **Core** | React, Vue.js, Angular, Svelte, Astro, Qwik, SolidJS, Lit, Preact | Globals + DOM markers |
| **CMS & Platforms** | WordPress, Shopify, Webflow, Squarespace, Wix, Drupal, Magento, Ghost, Bubble | Meta tags + globals |
| **Libraries & Tools** | jQuery, Bootstrap, Tailwind CSS, Alpine.js, HTMX, Turbo, Stencil, Redux, Ember.js, Backbone.js | DOM + globals |

Multi-framework detection returns a **primary** framework (meta-framework takes priority) plus a `subFrameworks` array for the full stack.

## Tools Reference

The table below is a hand-written guide to the commonly used tools, not the complete set. For
the full, current surface — all <!--n:full-->145<!--/n--> of them, read from the server itself —
run `npx crawlio-browser tools --full`.

<details>
<summary><b>Tool reference</b> — Connection, Capture, Navigation, Network, Storage, Emulation, Tracking, SEO, and more</summary>

### Connection & Status

| Tool | Description |
|------|-------------|
| `connect_tab` | Connect to a browser tab by URL, tab ID, or active tab |
| `disconnect_tab` | Disconnect from the current tab |
| `list_tabs` | List all open tabs with IDs and URLs |
| `get_connection_status` | Check CDP connection state |
| `reconnect_tab` | Force reconnect to fix stale connections |
| `get_capabilities` | List all tools and their availability |

### Page Capture

| Tool | Description |
|------|-------------|
| `capture_page` | Full capture: framework + network + console + DOM |
| `detect_framework` | Detect JS framework and version |
| `start_network_capture` | Start recording network requests |
| `stop_network_capture` | Stop recording and return captured requests |
| `get_console_logs` | Get console logs (errors, warnings, info) |
| `get_cookies` | Get cookies (sensitive values redacted) |
| `get_dom_snapshot` | Simplified DOM tree with shadow DOM and iframe support |
| `take_screenshot` | Screenshot as base64 PNG |
| `get_response_body` | Get response body for a captured network request |

### Navigation & Interaction

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL (auto-settle) |
| `browser_click` | Click element by CSS selector (auto-settle, left/right/middle, modifiers) |
| `browser_double_click` | Double-click element |
| `browser_type` | Type text into element (auto-settle) |
| `browser_press_key` | Press keyboard key (Enter, Tab, Escape, shortcuts) |
| `browser_hover` | Hover over element |
| `browser_select_option` | Select `<option>` by value (auto-settle) |
| `browser_scroll` | Scroll page or element |
| `browser_drag` | Drag from one element to another |
| `browser_file_upload` | Upload files to `<input type="file">` |
| `browser_wait` | Wait N milliseconds |
| `browser_wait_for` | Wait for element state (visible, hidden, attached, detached) |

### Network

| Tool | Description |
|------|-------------|
| `browser_intercept` | Block, modify headers, or mock responses for URL patterns |
| `emulate_network` | Throttle network (offline, 3G, 4G, WiFi presets) |
| `set_cache_disabled` | Disable/enable browser cache |
| `set_extra_headers` | Add custom headers to all requests |
| `get_websocket_connections` | List active WebSocket connections |
| `get_websocket_messages` | Get WebSocket message history |

### Frames & Tabs

| Tool | Description |
|------|-------------|
| `get_frame_tree` | Get frame hierarchy (main + iframes) |
| `switch_to_frame` | Switch execution context to iframe |
| `switch_to_main_frame` | Switch back to main frame |
| `create_tab` | Create new tab with URL |
| `close_tab` | Close tab by ID |
| `switch_tab` | Focus a tab by ID |

### Cookies & Storage

| Tool | Description |
|------|-------------|
| `set_cookie` | Set cookie (supports httpOnly via CDP) |
| `delete_cookies` | Delete cookies by name/domain/path |
| `get_storage` | Read localStorage or sessionStorage |
| `set_storage` | Write storage item |
| `clear_storage` | Clear all storage items |
| `get_databases` | List IndexedDB databases |
| `query_object_store` | Query IndexedDB object store |
| `clear_database` | Clear or delete IndexedDB database |

### Dialogs

| Tool | Description |
|------|-------------|
| `get_dialog` | Get pending JS dialog (alert/confirm/prompt) |
| `handle_dialog` | Accept or dismiss dialog |

### Emulation

| Tool | Description |
|------|-------------|
| `set_viewport` | Set viewport dimensions |
| `set_user_agent` | Override User-Agent string |
| `emulate_device` | Emulate device (iPhone, iPad, Pixel, Galaxy, Desktop) |
| `set_geolocation` | Override geolocation coordinates |
| `set_stealth_mode` | Anti-detection mode (opt-in, patches webdriver fingerprint) |

### Security

| Tool | Description |
|------|-------------|
| `get_security_state` | TLS certificate details, protocol, cipher |
| `ignore_certificate_errors` | Ignore cert errors for staging environments |

### Service Workers

| Tool | Description |
|------|-------------|
| `list_service_workers` | List all service worker registrations |
| `stop_service_worker` | Stop/unregister a service worker |
| `bypass_service_worker` | Bypass service workers for network requests |

### DOM Manipulation

| Tool | Description |
|------|-------------|
| `set_outer_html` | Replace element's HTML |
| `set_attribute` | Set element attribute |
| `remove_attribute` | Remove element attribute |
| `remove_node` | Remove element from DOM |

### CSS & JS Coverage

| Tool | Description |
|------|-------------|
| `start_css_coverage` / `stop_css_coverage` | Track which CSS rules are used |
| `start_js_coverage` / `stop_js_coverage` | Track which JS code is executed |
| `get_computed_style` | Get resolved CSS properties for element |
| `force_pseudo_state` | Force :hover, :focus, :active states |

### Performance & Memory

| Tool | Description |
|------|-------------|
| `get_performance_metrics` | Chrome metrics + Web Vitals (LCP, CLS, FID) |
| `get_dom_counters` | Count DOM nodes, documents, event listeners |
| `force_gc` | Force garbage collection |
| `take_heap_snapshot` | V8 heap snapshot summary |

### PDF & Accessibility

| Tool | Description |
|------|-------------|
| `print_to_pdf` | Generate PDF (custom paper, margins, orientation) |
| `get_accessibility_tree` | Accessibility tree for screen-reader audit |

### Targets & Contexts

| Tool | Description |
|------|-------------|
| `get_targets` | List all Chrome targets (pages, workers, extensions) |
| `attach_to_target` | Attach CDP session to any target |
| `create_browser_context` | Create isolated (incognito-like) context |

### Visual Debug

| Tool | Description |
|------|-------------|
| `highlight_element` | Highlight element with colored overlay |
| `show_layout_shifts` | Visualize CLS regions |
| `show_paint_rects` | Visualize paint/repaint areas |

### Session Recording

| Tool | Description |
|------|-------------|
| `start_recording` | Begin recording browser session |
| `stop_recording` | Stop recording and return session data |
| `get_recording_status` | Check recording state |
| `compile_recording` | Compile session into SKILL.md automation |

### Robot Training

| Tool | Description |
|------|-------------|
| `robot_training_start` | Start a fresh monitored demonstration run |
| `robot_training_status` | Inspect active robot-training runs and recording state |
| `robot_training_stop` | Stop a run and persist replay/API-synthesis artifacts |
| `robot_training_artifacts` | List files in a robot-training artifact directory |

### Crawlio App Integration

> Optional — requires [Crawlio.app](https://crawlio.app) running locally.

| Tool | Description |
|------|-------------|
| `extract_site` | Start a Crawlio crawl of the active tab's URL |
| `get_crawl_status` | Get crawl progress and status |
| `get_enrichment` | Get browser enrichment data |
| `get_crawled_urls` | Get crawled URLs with status and pagination |
| `enrich_url` | Navigate + capture + submit enrichment in one call |

</details>

## Requirements

- **Node.js** >= 18
- **Chrome** (or Chromium) with the [Crawlio for Chrome extension](https://www.crawlio.app/browser-agent) installed
- **Crawlio.app** (optional) — for site crawling and enrichment

## Build from Source

```bash
git clone https://github.com/Crawlio-app/crawlio-browser.git
cd crawlio-browser
npm install
npm run build          # selectors → semantic-grounding → MCP server → extension
```

Build output lands in `dist/mcp-server/` (ESM bundle) and `dist/extension/` (the
unpacked MV3 extension).

To develop against the extension, build the dev variant and load it unpacked:

```bash
npm run build:dev      # → dist/extension-dev, with __DEV__ logging enabled
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `dist/extension-dev`. Reload the extension there after each rebuild.

```bash
npm test               # vitest
npm run typecheck      # server + extension TypeScript projects
```

## Resources

- [Documentation](https://docs.crawlio.app/browser-agent/overview)
- [API Reference](https://docs.crawlio.app/browser-agent/tools)
- [Product Page](https://www.crawlio.app/browser-agent)
- [Chrome Extension](https://www.crawlio.app/browser-agent)
- [npm Package](https://www.npmjs.com/package/crawlio-browser)
- [Source](https://github.com/Crawlio-app/crawlio-browser)
- [Changelog](CHANGELOG.md) | [Releases](https://github.com/Crawlio-app/crawlio-browser/releases)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the build
and development loop, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community
expectations. Please report security vulnerabilities privately via
[SECURITY.md](SECURITY.md) rather than in a public issue.

## License

Apache-2.0 — see [LICENSE](LICENSE).

The selector kernel in [`packages/selectors`](packages/selectors) is MIT-licensed:
it contains code ported from Selector Forge (MIT) and Chromium DevTools
(BSD-3-Clause). See [`packages/selectors/LICENSE`](packages/selectors/LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full attributions.
