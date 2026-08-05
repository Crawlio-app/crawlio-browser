# Changelog

## [1.9.2] - 2026-08-05

### Fixed

- **`--help` and `--version` started the MCP server.** Neither was handled, so both fell through
  to the transport setup: asking the CLI its version launched a stdio server and bound a
  WebSocket port, leaving a process the user had to notice and kill. Both are now answered
  before anything else runs, and `--help` documents every subcommand. `npm run check:surface`
  fails if `--version` ever stops exiting on its own again

## [1.9.1] - 2026-08-05

### Fixed

- **`mcpName` was missing from the published package**, which made the server impossible to list
  in the MCP registry. The registry proves you own an npm package by reading `mcpName` back off
  the published tarball and comparing it to the server name in `server.json`; without it,
  submission fails validation no matter how the domain is verified. npm tarballs are immutable,
  so correcting it required a release. `npm run check:surface` now fails when the two disagree
- **`server.json` would have been rejected on submission.** Its description ran 118 characters
  against a hard limit of 100, and its `$schema` pointed at the deprecated 2025-09-29 revision
  rather than 2025-12-11. `mcp-publisher validate` now reports the file valid, and both limits
  are enforced by the surface check

## [1.9.0] - 2026-08-05

The product now answers to one name, and the numbers it advertises are measured rather than
typed.

### Added

- **`crawlio-browser tools`** — prints the exact tool surface each mode exposes, without a
  browser, an extension, or a network connection. `--full` for all 145, `--json` for a
  machine-readable form you can diff across versions. Installing this server hands an agent the
  debugger permission on a browser holding live sessions, so being able to read what it exposes
  *before* configuring a client is a reasonable thing to ask for
- **`npm run check:surface`** — fails CI when a documented count disagrees with the server.
  Numbers in the README carry markers checked against `tools --json`; `--fix` rewrites them

### Fixed

- **Full mode reported the wrong tool count on startup.** The banner read
  `exposing all 114 tools` while exposing 145. It is now counted, not quoted
- **Corrected every advertised count.** The README claimed "3 tools" where a client sees 6,
  "8 higher-order methods" in three places and "17" in a fourth (there are 18), "detects 17
  frameworks" on one line and the correct 64 on another, and `bridge` "133 commands", which
  matched nothing measurable. A section titled "All 145 tools" listed 92
- **The `~95% schema token reduction` claim was an estimate, and wrong.** Measured on the
  serialized `tools/list` payload each mode returns, the reduction is **83%** — code mode is not
  free, because `execute` and `search` carry long descriptions. The README now states the
  measured figure and the method
- **Unreachable fallback in robot training.** `process.cwd() || …` could never take the fallback
  branch — `process.cwd()` throws rather than returning empty — and the dead branch hardcoded a
  developer's Desktop path. Now a real `try`/`catch` falling back to the home directory

### Changed

- **One name: Crawlio Browser.** The README's title said "Crawlio Agent" above an npm badge and
  install command that both said `crawlio-browser`. The npm package, CLI, MCP server name and
  repository already agreed; the prose now does too. The Chrome extension keeps its Web Store
  name, **Crawlio for Chrome**, and is described as the browser-side component
- The macOS process title is now `Crawlio Browser`. The `~/.crawlio/Crawlio Agent.app` bundle
  path is deliberately unchanged: `buildStdioEntry()` writes it into client config files, so
  renaming or removing it would break every install that already points there
- **Method Mode is the product's one coined term.** The runtime it sits on is described rather
  than branded; "JIT Context Runtime" is no longer used as a name
- Shipped skill documentation no longer states hand-maintained command counts, pointing at
  `crawlio-browser tools --full` and `search` instead — both read the live builders
- CI pins moved to `actions/checkout@v7`, `actions/setup-node@v7` and `codeql-action@v4`

## [1.8.0] - 2026-08-04

Crawlio Browser is now **open source under Apache-2.0** at
[Crawlio-app/crawlio-browser](https://github.com/Crawlio-app/crawlio-browser) —
the full MCP server and Chrome extension source, not just distribution artifacts.
The selector kernel in `packages/selectors` remains MIT (it ports MIT and
BSD-3-Clause code); see `NOTICE` and `THIRD_PARTY_NOTICES.md`.

### Added

- **`detect_sections`** — live-DOM region perception. Returns a depth-capped tree of page
  regions (semantic tags, ARIA landmarks, `data-component`/`data-testid` attributes, and
  PascalCase/BEM class hints) with a verified selector, bounding box, interactive-element
  count, and text density per region. Regions scope perception; pair with
  `browser_snapshot({ selector })` to mint interaction refs inside a chosen one
- **Table detection upgrades** — a native `<table>` fast path that promotes `<thead>` cells
  to real column names (previously the header row was lost entirely), geometric consistency
  filters on the repeated-block path, and normalized `confidence` / `strategy` / `warnings`
  on every candidate so an agent can threshold results instead of reading a raw score
- **Semantic column naming** in `extract_table` — link-aware columns (`title`, `title_url`)
  instead of DOM-path keys
- **Structured `problem` error codes** — every failure now carries a machine-readable code
  (`disconnected`, `target_closed`, `permission_denied`, `timeout`, …) alongside the message,
  so callers branch on cause rather than parsing prose
- **Idle debugger release** (opt-in) — after a configurable quiet period the debugger detaches
  so Chrome's "being debugged" banner clears; the next command re-attaches and restores the
  session, including the injected scripts only the capture path installs. Configure with the
  new **`set_idle_release`** / **`get_idle_release`** tools (minimum 60s; `idleMs: 0`
  disables). It never fires during a recording, an active agent session, a pending dialog,
  installed request-interception rules, active coverage, or a pinned frame

### Fixed

- **`pick_element` and robot-training were broken in every shipped build** — both install
  their in-page kernel via a single `browser_evaluate`, but the extension hard-rejected any
  expression over 10,000 characters and the kernel prelude is ~17KB, so both failed 100% of
  the time. The cap is now a shared constant (32,768) with a regression test asserting the
  prelude fits
- **CDP disconnect recovery re-enabled nothing** — recovery rebuilt commands from stored
  domain names that already included `.enable`, producing `Page.enable.enable`, and dropped
  the parameters `Performance.enable` requires. Every replay failed silently, so after any
  mid-session disconnect network and console capture stopped without an error
- **Stale bridge sockets could permanently unverify their replacement** — a zombie socket's
  late `onclose` cleared the handshake state and identity timer belonging to a newer socket
  on the same port, leaving it refused-but-never-dropped in token mode
- **Domain state was last-writer-wins** — `ensureDebugger` and `startNetworkCapture` each
  overwrote the other's record, so recovery could re-enable a subset of the live domains
- **Per-port reconnects had no backoff** — a flapping server produced a fixed 3s connect/close
  loop; now exponential to a 30s cap, reset on a successful open
- **Errors thrown inside `execute()` lost their structure** — the sandbox boundary flattened
  them to a bare message, discarding permission and problem details
- **Selectors were embedded into generated page JavaScript with `JSON.stringify` alone**,
  which leaves U+2028 and U+2029 raw. Both are valid JSON but are line terminators in
  JavaScript source, so the programs were at the mercy of the parsing engine; they are now
  escaped, and the injection tests execute a hostile selector rather than grepping for it
- **Offline-queue rejections carried no problem code** — the failure a user hits whenever
  the extension is closed was indistinguishable from any other error
- **`npm ci && npm run typecheck` failed on a fresh clone**, because the two workspace
  packages are `file:` dependencies whose `main`/`types` point at uncommitted `dist/` output
  and neither had a `prepare` script. This broke CI and any new contributor's first build
- **The published npm package omitted `NOTICE`**, which Apache-2.0 §4(d) requires
  redistributions to carry — so the tarball claimed Apache-2.0 while dropping the attribution
  notice it depends on, including the Chromium BSD-3 and Selector Forge credits
- **Two declared problem codes were never emitted.** `opt_out` was dead: all twelve
  site-opt-out refusals return a response literal directly, bypassing the only place the
  classifier runs. Four bridge rejections were untagged as well — a cleared queue, a
  drain-side resend timeout, a disconnect inside the reconnect grace window, and a stopped
  bridge

### Changed

- **`export_session_raw` now writes to `~/.crawlio/<domain>-session.json`** (previously a
  different home directory). Pass `outputPath` to choose your own location; it must still be
  inside your home directory
- **Minimum `@modelcontextprotocol/sdk` raised to 1.25.0.** The server statically imports
  `@modelcontextprotocol/sdk/server/express.js`, a subpath that does not exist before 1.25 —
  the previous `^1.8.0` floor allowed an install that crashed at startup with
  `ERR_MODULE_NOT_FOUND`, in stdio mode as well as portal mode
- Relicensed from proprietary to **Apache-2.0**; `package.json`, `server.json`, and README
  repoint to the new public repository
- `persistState` failures are now logged instead of silently swallowed
- CI verifies the extension bundle builds and that versions stay in sync across
  `package.json`, both manifests, and `server.json`
- **`CRAWLIO_RAW_LANE` replaces `CRAWLIO_RE_LANE`** as the documented switch for the
  raw-capture lane, and `CRAWLIO_*_MODE=raw|traffic` replaces `=re`. The old spellings still
  work and will be removed in the next major, so no configuration breaks today
- Adds ESLint and oxlint, wired into CI as separate steps. One project-specific rule enforces
  that every debugger attach goes through `attachDebugger()`, so a tab can never end up
  attached but untracked. Prettier is deliberately absent
- Adds `.editorconfig`, `.gitattributes` (pinning LF so a Windows checkout cannot rewrite
  shell scripts), `SUPPORT.md`, issue and pull-request templates, Dependabot, and CodeQL
- CI pins every third-party action to a commit rather than a mutable tag, `.npmrc` holds new
  dependency versions for a week before they may enter the lockfile, and a version gate fails
  any pull request that changes shipped files without moving the version forward
- The public repository is produced by a scripted, allowlist-based export whose sanitation
  gate is itself covered by tests that plant each internal directory and require rejection

## [1.7.1] - 2026-08-03

`1.7.0` is unavailable: that version string was published and deprecated in a
prior cycle ("version bump was premature, extension stays at 1.6.1"), so the
registry rejects it. `1.7.1` is the first release off the 1.6.6 line.

### Added

- **`crawlio-browser doctor`** — side-effect-free health check over five surfaces (live bridges, portal, native-messaging host manifests, MCP client configs, Crawlio.app). `--json` emits `ai.crawlio.browser-doctor.v1`; the report passes through `redactSecrets` before printing
- **`audit-egress`** subcommand plus `TELEMETRY.md` documenting every outbound call
- **`telemetry rotate`** — regenerate the anonymous install id
- **`saveArtifact`** — sandbox→disk egress so bulk code-mode results stream to `~/.crawlio/artifacts` instead of returning megabytes
- **Async `execute` jobs** — fire-and-poll via `get_job_result` / `list_jobs` / `cancel_job`, with `execute` and `connect_tab` timeouts aligned

### Fixed

- **Bridge eviction livelock** — `wss.on("connection")` terminated whichever client held the bridge on *every* new connection, so two legitimate clients (several Chrome profiles, or a Web Store build alongside an unpacked dev build) evicted each other indefinitely. Observed in the field: 211,042 evictions and a 67 MB unrotated `server.err`. A live incumbent is now refused with close code 4009 instead
- **Bridge port collisions** — `listenWalkingPortRange` walks 9333–9342 past `EADDRINUSE` rather than letting the error escape to `uncaughtException` and kill the stdio server
- **`doctor` crawlio.app probe** — reads the UDS `control.sock`, not only the TCP `control.port` file, so a running app is no longer reported as absent
- **`connect_tab` from the background worker**, per-feature permission gate, and badge async-catch
- **Agent-session fleet tools** restored after the `tabGroups` permission drop
- **Test isolation** — `CRAWLIO_WS_PORT` relocates the bridge port range so the contention suite cannot race a live server on the developer's machine

### Security

- Redaction and export-path hardening, plus an honest code-mode catalog (1.6.6 live red-team follow-up)
- Publishing now runs `check:versions`, which fails the release when `package.json`, `PKG_VERSION`, both extension manifests, `server.json`, and the built `dist/extension/manifest.json` disagree

## [1.6.6] - 2026-06-30

### Changed

- Chrome Web Store re-submit build
- Dropped 4 dormant optional permissions: `history`, `downloads`, `tabGroups`, `contextMenus`

### Fixed

- **Native host staged off the Desktop** — macOS TCC silently refuses to exec a native-messaging host under `~/Desktop`, `~/Documents`, or `~/Downloads`, so the host is staged into `~/.crawlio/native-host` and the manifest points there

## [1.6.5] - 2026-06-28

### Added

- **Bridge token defense activated** — the native-messaging bootstrap delivers the real bridge token over Chrome's authenticated channel, so the server-identity handshake can refuse rogue local listeners that answer `/health` but never read the `0600` bridge file
- **Selector-forge M3** — injectable kernel plus `pick_element` / `cancel_picker` tools
- **`lastActivityAt`** published per bridge, and single-bridge election picks the most active one
- **`scripts/reap-stale-mcp.sh`** — safe cleanup of leaked MCP processes, preserving bridges that still have an extension attached
- Adoption-first onboarding with anonymous identity

### Changed

- **Relicensed to proprietary** (MIT → UNLICENSED)
- The published `mcp-server` bundle is minified (stop shipping readable JS)

### Fixed

- **Discovery storm** — single-bridge election replaces every-instance contention
- stdio idle-exit watchdog so abandoned servers self-terminate

### Security

- Pass-3 red-team hardening: bridge trust, sandbox, native-host, and data-exposure chokepoints

## [1.6.4] - 2026-03-14

### Added

- Platform thesis alignment and evidence-mode skills

## [1.6.1] - 2026-03-13

`1.6.0`, `1.6.2`, and `1.6.3` were same-cycle patch releases in the same March
window; their changes are folded into the entries above and below.

### Added

- **Detection wedge** — tracking-event validation with schema-based parameter checking and an error taxonomy, `dataLayer` inspection with duplicate-event detection, and a technology relationship graph (implies + excludes resolution)

### Changed

- Tool counts hardened across every surface: 100 → 114 tools, 133 → 147 commands

### Fixed

- `tabSerpState` migrated in `tabs.onReplaced`
- `detectNullGaps` array blind spot

## [1.5.6] - 2026-03-08

### Added

- **Typed evidence system** — 16 typed interfaces in `src/shared/evidence-types.ts` (`PageEvidence`, `Finding`, `CoverageGap`, `ComparisonScaffold`, `MethodTrace`, etc.)
- **`smart.finding()`** — synchronous validation with confidence scoring; auto-caps confidence when coverage gaps reduce reliability
- **`smart.findings()` / `smart.clearFindings()`** — session-level evidence aggregation
- **Accessibility dimension** — `get_accessibility_tree` integration returning `AccessibilitySummary` (nodeCount, landmarkCount, imagesWithoutAlt, headingStructure)
- **Mobile-readiness dimension** — viewport meta + media query evaluation returning `MobileReadiness`
- **Confidence propagation** — `reducesConfidence: true` on perf/security gaps; findings auto-tagged with `confidenceCapped` / `cappedBy`
- **`extractPage({ trace: true })`** — adds `_trace: MethodTrace` with per-step timing
- **`ComparisonEvidence`** — `comparePages()` now returns scaffold with 10 dimensions, sharedFields, missingFields, metrics
- **40+ new unit tests** for evidence types, confidence propagation, and aggregation
- **E2E test suites** — `tests/e2e-method-mode.mjs` (20 steps) and `tests/e2e-recording.mjs`

### Fixed

- **`extractMetrics` bug** — assumed `perf.metrics.LCP` but real extension returns `perf.webVitals.lcp` / `perf.timing.firstByte` / `perf.chrome.taskDuration`

## [1.5.5] - 2026-03-07

### Added

- **Smart method layer** — 4 new `smart.*` methods for browser-automation skill:
  - `smart.scrollCapture()` — scroll to bottom, capturing content along the way
  - `smart.waitForIdle()` — wait for network + DOM to settle
  - `smart.extractPage()` — structured data extraction from current page
  - `smart.comparePages()` — diff two page snapshots for changes
- **`web-research` skill** — new skill for multi-page research workflows (`skills/web-research/SKILL.md`)
- **17 new unit tests** for smart methods in `tests/unit/smart-methods.test.ts`

### Changed

- Init wizard now installs both `browser-automation` and `web-research` skills

## [1.5.4] - 2026-03-06

### Changed

- Hardened skills: evaluate return-shape documentation + script performance rules
- Bumped extension manifest for CWS submission

## [1.5.3] - 2026-03-05

### Fixed

- Snapshot ref routing fix — correct frame context for DOM snapshots
- Evaluate auto-IIFE — wraps bare expressions in immediately-invoked function for correct return

### Changed

- Hardened skills documentation and error handling

## [1.5.2] - 2026-03-04

### Changed

- npm publish with updated package metadata

## [1.5.1] - 2026-03-03

### Added

- **Response shaping layer** — 8 shaping functions that compress raw extension data before it reaches the AI's context window (up to 99.9% reduction on `capture_page`)

## [1.5.0] - 2026-03-03

### Added

- **Response shaping layer** (`src/mcp-server/response-shapers.ts`) — 8 shaping functions that compress raw extension data before it reaches the AI's context window. Every MCP tool response previously dumped unfiltered, pretty-printed JSON. Now shaped tools return compact, actionable summaries:
  - `truncateUrl(url, max=120)` — caps long URLs (Google search URLs can be 600+ chars)
  - `shapeListTabs()` — drops `windowId`, `connected`; truncates URLs; renames `tabId` → `id`
  - `shapeConnectTab()` — replaces verbose `domainState` arrays with `{ok: true}` or `{ok: false, failedDomains: [...]}`
  - `shapeCapturePage()` — replaces full network/console/cookie/DOM arrays with summary stats and error highlights
  - `shapeConsoleLogs()` — errors in full, warnings capped at 10, info/debug as counts
  - `shapeNetworkLog()` — failed requests + byStatus/byType summaries + top 5 slowest
  - `shapeCookies()` — drops value/path/expires/size; keeps name/domain/flags
  - `shapeInteraction()` — drops x/y coordinates, deltaX/Y, steps, clearFirst; keeps action/selector/ref/snapshot
- **35 new unit tests** in `tests/unit/response-shapers.test.ts` covering all shapers with realistic fixture data

### Changed

- **`toolSuccess()` compact JSON** — removed pretty-printing (`JSON.stringify(content, null, 2)` → `JSON.stringify(content)`). AI parses JSON regardless of whitespace. ~20% savings on all responses.
- **16 tool handlers** now apply response shapers: `list_tabs`, `connect_tab`, `capture_page`, `get_console_logs`, `stop_network_capture`, `get_cookies`, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_scroll`, `browser_double_click`, `browser_drag`, `browser_file_upload`, `browser_fill_form`

### E2E Token Savings (measured against github.com)

| Tool | Before | After | Reduction |
|------|--------|-------|-----------|
| `capture_page` | 841,132 B | 738 B | **99.9%** |
| `get_console_logs` | 1,558 B | 55 B | **96.5%** |
| `get_cookies` | 1,783 B | 593 B | **66.7%** |
| `list_tabs` (10 tabs) | 2,858 B | 1,190 B | **58.4%** |

The AI still has full drill-down access — `get_dom_snapshot`, `get_console_logs`, `get_cookies`, and `execute` return complete data when the AI needs to go deeper.

### Tools NOT changed (already efficient or user-controlled)

`execute`, `search`, `take_screenshot`, `detect_framework`, `get_connection_status`, `browser_snapshot`, `browser_evaluate`, recording tools, performance/coverage tools

## [1.4.0] - 2026-03-02

### Added

- **Session recording** — 3 new MCP tools (`start_recording`, `stop_recording`, `get_recording_status`) that capture a full browser session as structured data. Records all tool interactions (with args, results, timing), page navigations, network requests, and console logs — organized by page. Supports auto-stop on duration limit, interaction limit, tab closed, or tab disconnected.
  - Types: `RecordingSession`, `RecordingPage`, `RecordingInteraction`, `RecordingStatus` in `src/shared/types.ts`
  - Protocol: 3 new `ServerCommand` variants in `src/shared/protocol.ts`
  - Extension: `RECORDING_INTERACTION_TOOLS` set (12 tools intercepted), `handleCommandWithRecording()` state machine, `lastAutoStoppedSession` recovery in `src/extension/background.ts`
  - MCP tools: Zod-validated input (`maxDurationSec` 10–600, `maxInteractions` 1–500), internal try/catch with `toolError()` in `src/mcp-server/tools.ts`
- **72 new recording tests** across 3 test files:
  - `tests/unit/recording.test.ts` — tool registration, bridge protocol, Zod validation, response parsing (11 tests)
  - `tests/unit/recording-smoke.test.ts` — full lifecycle with realistic mock data (12 tests)
  - `tests/unit/recording-e2e.test.ts` — comprehensive black-box E2E: discoverability, type contracts, validation boundaries, state machine simulation, interaction interception set, permission exemption, timeout config, error propagation, session data integrity (49 tests)
- `get_recording_status` added to `PERMISSION_EXEMPT_TOOLS` (no tab required)
- `TOOL_TIMEOUTS` entries: `start_recording` 10s, `stop_recording` 10s, `get_recording_status` 5s
- Session recording documentation in `skills/browser-automation/SKILL.md` and `reference.md`

### Changed

- **`--cloudflare` flag for init wizard** — `npx crawlio-browser init --cloudflare` adds Cloudflare MCP integration with zero wrangler dependency. Prompts for a Cloudflare API token (or detects `CLOUDFLARE_API_TOKEN` env var), verifies it against the Cloudflare API, auto-detects account ID, and writes the config. Supports `--yes` for non-interactive mode, `--dry-run`, multiple accounts, and legacy entry cleanup (`cloudflare-bindings`/`cloudflare-builds` → single `cloudflare`).
  - New exports: `buildCloudflareEntry()`, `isCloudflareConfigured()`, `verifyCloudflareToken()`
  - 8 new tests in `tests/unit/init.test.ts` (parseFlags, buildCloudflareEntry, isCloudflareConfigured)
- **Cloudflare MCP: replaced `mcp-remote` with `@cloudflare/mcp-server-cloudflare`** — eliminates broken browser OAuth flow entirely. Uses `CLOUDFLARE_API_TOKEN` env var for auth (no wrangler required). Single `cloudflare` server replaces both `cloudflare-bindings` and `cloudflare-builds`, providing 89 tools (KV, Workers, R2, D1, Durable Objects, Queues, AI, Workflows, Zones, Secrets, Versions, Routes, Cron).

### Fixed

- **Recording tool error handling** — all 3 recording tool handlers now catch `bridge.send()` errors internally and return `toolError()` responses, matching the pattern used by `get_cookies`, `get_storage`, and other tool handlers. Previously, bridge errors propagated as unhandled throws.

### Technical Details

#### Session Recording Architecture

The extension's service worker (`background.ts`) manages a recording state machine:

```
idle → start_recording → recording → stop_recording → idle
                              ↓
                         auto-stop (duration/interactions/tab closed)
                              ↓
                     lastAutoStoppedSession cached
```

During recording, the 12 interaction tools in `RECORDING_INTERACTION_TOOLS` are intercepted — each tool's args, result, timing, and page URL are captured as `RecordingInteraction` entries. Page transitions create new `RecordingPage` entries with delta snapshots of console logs and network requests.

#### Cloudflare MCP Migration

| Before | After |
|--------|-------|
| `mcp-remote@0.1.38` proxy to `bindings.mcp.cloudflare.com` | `@cloudflare/mcp-server-cloudflare@0.2.0` local server |
| `mcp-remote@0.1.38` proxy to `builds.mcp.cloudflare.com` | (merged into single server above) |
| Browser OAuth flow (buggy — [cloudflare/mcp-server-cloudflare#294](https://github.com/cloudflare/mcp-server-cloudflare/issues/294)) | `CLOUDFLARE_API_TOKEN` env var — no wrangler, no browser OAuth |
| 2 MCP servers, race-prone OAuth | 1 server, 89 tools, instant startup |
| Manual config editing | `npx crawlio-browser init --cloudflare` guided setup |

Root cause of the OAuth failures:
1. `bindings.mcp.cloudflare.com/oauth/authorize` returns 500 Internal Error (upstream bug: 4xx errors misclassified as 500)
2. `builds.mcp.cloudflare.com` returns `request_forbidden` ("You are not allowed to perform this action")
3. `mcp-remote@0.1.38` has a build bug: internal version string says `"0.1.37"`, causing auth directory namespace mismatch

## [1.3.0] - 2026-03-01

### Changed

- **Renamed package** from `crawlio-agent` to `crawlio-browser`
- **Code-mode is now the default** — 3 tools (search, execute, connect_tab) with 125 searchable commands. Use `--full` to expose all 92 individual tools. `--code-mode` flag deprecated.

### Added

- **Browser automation skill** (`skills/browser-automation/SKILL.md`) — workflow patterns for connection, navigation, screenshots, clicks, network capture, framework detection
- **Command reference** (`skills/browser-automation/reference.md`) — full catalog of 92 browser + 33 desktop commands
- **Claude Code plugin** (`.claude-plugin/plugin.json`) — enables `claude plugin install`
- `--full` flag for init
- Skill auto-install during `npx crawlio-browser init`

## [1.2.0] - 2026-03-01

### Added

- `npx crawlio-agent init` — neon-inspired interactive wizard that auto-detects environment and configures the right transport:
  - **Default (stdio):** runs `npx add-mcp crawlio-agent` — clients spawn crawlio-agent as a child process, no server needed
  - **`.mcp.json` detected:** prompts to add a stdio entry directly to the config (MetaMCP / multi-engine setups)
  - **`--portal` flag:** starts persistent HTTP server on :3001 + configures clients with the HTTP URL (multi-client sharing, ChatGPT Desktop)
- New flags: `--portal`, `--yes` / `-y` (skip prompts), `-a <agent>` (target specific MCP clients)
- `setup` and `--setup` remain as backwards-compatible aliases for `init`
- `alarms` permission for WebSocket reconnect scheduling (zero install warning, invisible to users)

### Removed

- **`nativeMessaging`** from `optional_permissions` — native messaging host (`com.crawlio.agent`) is not a shipped product; no user flow triggers it; code guards with `chrome.permissions.contains()` so removal is safe; eliminates CWS reviewer question with no defensible answer

### Changed

- Extension permissions simplified to `["activeTab", "alarms", "debugger", "storage"]` + optional `["tabs"]` + optional host `["http://127.0.0.1/*"]`

### Fixed

- **Node path resolution** — `process.execPath` replaced with `resolveNodePath()` that runs `which node` / `where node`, preventing launchd plist from baking in ephemeral npm cache or Homebrew Cellar paths that break after Node upgrades
- **Windows path handling** — `new URL(import.meta.url).pathname` replaced with `fileURLToPath()` to avoid leading-slash bug on Windows (`/C:/path/...`)
- **Windows npx** — `execFileSync("npx")` replaced with platform-aware `npx.cmd` detection
- **Cross-platform skill discovery** — `find` command replaced with `readdirSync({ recursive: true })` + path filter (Windows `find` is a text search utility)
- **Port conflict detection** — when health check fails after spawn, setup now probes port 3001 and prints a clear message suggesting `--port 3002` if occupied
- **Better error categorization** — `configureClients` now distinguishes ENOENT (npx not in PATH) vs ETIMEDOUT (network) vs generic failures
- **Stale version strings** — health endpoint and MCP server constructor both hardcoded old versions; now report `1.2.0`

### Removed

- **`commander`** from dependencies — was never imported, dead weight
- **`idb`** from dependencies — only used by extension code (browser-only IndexedDB wrapper), not the MCP server

### Added

- `--dry-run` flag for `npx crawlio-agent setup --dry-run` — prints what setup would do (node path, server path, launchd method, add-mcp command) without executing
- GitHub Actions CI pipeline (`.github/workflows/ci.yml`) — runs typecheck, tests, and build on Node 18/20/22 for push to main and PRs
- `prepublishOnly` script — ensures typecheck + test + build pass before `npm publish`

### Changed

- `files` array in package.json narrowed from `bin/` (which included `crawlio-server.sh` with hardcoded paths) to `bin/crawlio-agent.js`
- `build:server` script now cleans `dist/mcp-server/` before building to prevent stale chunk accumulation (cross-platform `fs.rmSync` instead of `rm -rf`)
- `-g` flag changed to `--global` in add-mcp invocation for clarity

## [1.1.0] - 2026-02-24

### Changed

- **Replaced broad `host_permissions`** (`http://*/*`, `https://*/*`) with narrow `http://127.0.0.1/*` — eliminates Chrome Web Store "delayed in-depth review" warning while keeping CORS bypass for the local MCP server health probe
- **Removed `content_scripts`** manifest entry — content script is no longer auto-injected on every page
- **Migrated all MCP tool handlers from `chrome.scripting.executeScript` to CDP `Runtime.evaluate`** — uses the already-attached debugger session, which is independent of the `host_permissions` permission chain
- **Enrichment accumulator** now uses CDP for framework detection and DOM capture when the debugger is attached, skips silently otherwise

### Added

- `cdpExecuteFunction<T>()` helper — serializes a function + args and executes via `sendCDPCommand("Runtime.evaluate")`, bypassing the `chrome.scripting` permission gate entirely

### Technical Details

Chrome's permission check chain for `chrome.scripting.executeScript` checks tab-specific permissions (activeTab), granted host_permissions, and optional host_permissions in sequence. Without `host_permissions` and without a user gesture (no `activeTab` grant), `executeScript` fails. However, CDP operations via `chrome.debugger.sendCommand` use a completely separate authorization domain — the `debugger` permission alone is sufficient. Since all MCP tool handlers are called after `getConnectedTab()` (which guarantees the debugger is attached), CDP `Runtime.evaluate` is a drop-in replacement.

### Migration Impact

| Audience | Before | After |
|----------|--------|-------|
| AI via MCP | Full experience | Identical (CDP instead of scripting API) |
| Passive enrichment | Auto-captures framework + screenshot on every navigation | Framework captured only when debugger is attached; screenshots may fail silently |
| Chrome Web Store | Delayed in-depth review | Standard review timeline |

### Affected Tools

- `detect_framework` — now uses `cdpExecuteFunction`
- `get_dom_snapshot` — now uses `cdpExecuteFunction`
- `capture_page` (framework + DOM) — now uses `cdpExecuteFunction`
- `browser_type` (focus) — now uses `cdpExecuteFunction`
- `browser_select_option` — now uses `cdpExecuteFunction`

### Permissions After Change

```json
"permissions": ["activeTab", "scripting", "debugger", "storage", "tabs", "webNavigation"],
"host_permissions": ["http://127.0.0.1/*"]
```

`activeTab` and `scripting` retained for popup-triggered user gestures. Broad `host_permissions` (`http://*/*`, `https://*/*`) replaced with localhost-only. `content_scripts` removed entirely.

### Why `http://127.0.0.1/*` is Needed

Chrome's CORS enforcement fires when there's either no `Access-Control-Allow-Origin` header or a connection refused (no response at all). The service worker probes `http://127.0.0.1:9333/health` to check if the MCP server is running. Without `host_permissions` for localhost, Chrome enforces CORS on this fetch — and when the server isn't running, connection refused triggers a CORS error regardless of server-side headers. A narrow localhost `host_permissions` gives the extension CORS bypass for the probe without triggering CWS delayed review.
