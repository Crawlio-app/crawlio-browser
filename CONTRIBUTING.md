# Contributing to Crawlio Browser

Thanks for your interest in improving Crawlio Browser.

## How this repository works

This repository is the source of truth for the published `crawlio-browser` npm
package and the Crawlio for Chrome extension. It is synced from an internal
monorepo where the product is developed alongside private tooling. Practically,
that means:

- Issues and pull requests here are read and acted on.
- A merged pull request is applied internally and appears in the next sync
  commit, so the commit that lands your change may be authored by a maintainer
  and reference your PR rather than being your commit verbatim. Attribution is
  preserved in the changelog and release notes.
- Version bumps and releases are made by maintainers. Please do not include them
  in a pull request.

## Development setup

```bash
git clone https://github.com/Crawlio-app/crawlio-browser.git
cd crawlio-browser
npm install
npm run build
```

`npm run build` runs, in order: `packages/selectors` → `packages/semantic-grounding`
→ the MCP server (`dist/mcp-server/`) → the extension (`dist/extension/`).

Run `npm run build` at least once before `npm run typecheck` or `npm test`. The two
workspace packages are consumed as `file:` dependencies whose `main`/`types` point at
their `dist/` output, and that output is not committed — nothing resolves until they are
built. (`npm install` builds `packages/selectors` for you via its `prepare` script.)

### Working on the extension

```bash
npm run build:dev      # → dist/extension-dev with __DEV__ logging on
```

Load it via `chrome://extensions` → Developer mode → **Load unpacked** →
`dist/extension-dev`. Rebuild and hit reload on the extension card to pick up
changes. The service worker log is reachable from the same card.

The extension is a Manifest V3 service worker that drives the page over the
Chrome DevTools Protocol (`chrome.debugger`). It talks to the MCP server over a
localhost WebSocket bridge.

### Working on the MCP server

```bash
npm run dev            # tsup watch build of the server bundle
```

## Before opening a pull request

```bash
npm run typecheck      # both TS projects: server and extension
npm test               # vitest
```

Both must pass. CI runs the same checks on Node 18, 20, and 22, plus the
extension build and a version-sync check.

## How changes get reviewed

Every change gets an independent review before it merges, and **the author never reviews
their own work** — not because of formality, but because the person who just wrote a diff
already believes it is correct, and that belief is exactly the bias review exists to defeat.
A green CI run is not a review either; CI proves the tests you thought to write still pass.

Review depth scales with blast radius, and blast radius is judged **by callers, not by file
count**. A one-line change to a helper with fifty importers is not a small change. Expect a
closer look when a change touches:

- the CDP command path or debugger lifecycle in `src/extension/background.ts`
- the extension↔server wire contract (`src/shared/protocol.ts`)
- permissions, the bridge handshake, or anything in the trust boundary
- the `execute` sandbox or the tool-response safety pipeline
- a shared helper with many callers

The reviewer, not the author, decides how deep to go, and may escalate unprompted.

If a change alters behavior that tests cannot prove — extension UI, a new tool's live
output, anything about the debugger banner — verify it against a real browser before opening
the PR and say in the description what you observed.

## Conventions

These are enforced by review rather than by lint rules, so please follow them:

- **TypeScript strict.** No `any` unless genuinely unavoidable.
- **Naming.** Types/interfaces `PascalCase`, functions/variables `camelCase`,
  files `kebab-case.ts`, protocol message types `UPPER_SNAKE_CASE`.
- **Chrome APIs.** Always check `chrome.runtime.lastError` in callbacks, and
  always handle `{error}` responses from `chrome.debugger.sendCommand`.
- **CDP.** Wire event listeners *before* enabling a domain, and always detach on
  disconnect.
- **Errors.** Never swallow them silently; never let an uncaught error kill the
  service worker. Prefer a structured `problem` code (see
  `src/shared/protocol.ts`) over prose the caller has to parse.
- **Tests.** `background.ts` is a browser IIFE bundle and is not directly unit
  tested. The established pattern is to extract pure decision logic into its own
  module and test that — see `src/extension/idle-release.ts`,
  `src/extension/domain-state.ts`, and `src/extension/bridge-discipline.ts` with
  their tests in `tests/unit/`.

## Extension permissions

The extension deliberately ships a minimal permission surface, and new required
permissions are a Chrome Web Store review trigger. A pull request that adds one
is unlikely to be merged as-is — please open an issue to discuss the use case
first. Runtime-optional permissions requested through the existing permission
broker are usually the right path.

## Reporting security issues

Please do **not** open a public issue for a vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).
