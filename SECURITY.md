# Security Model

Crawlio Browser is a Chrome extension (MV3) plus a local MCP server that exposes
browser automation to AI agents over a loopback WebSocket bridge. This document
describes the trust boundaries, the authentication mechanisms, the threat model
(including what is explicitly **out of scope**), and how to report a vulnerability.

The source is authoritative. Where this document and the code disagree, the code
wins — please file a report so we can fix the doc.

## Components and where they run

| Component | Process | Page access |
|---|---|---|
| MCP server (`src/mcp-server/`) | Node, stdio or HTTP transport | none directly |
| WebSocket bridge (`websocket-bridge.ts`) | inside the MCP server | none directly |
| Extension service worker (`src/extension/background.ts`) | Chrome MV3 SW | via CDP (`chrome.debugger`) |
| Native-messaging host (`bin/native-host/`) | Node, launched by Chrome | none |

All page access happens through CDP via the `debugger` permission. The extension
ships **no** auto-injected content scripts.

## Trust boundaries

1. **The MCP client is trusted.** Claude Code, Cursor, or any other MCP client is
   the trust boundary and the prompt-injection boundary. Crawlio executes what the
   client sends, the same way a terminal runs what the user types. The client is
   responsible for prompt-injection defense and user consent. The MCP protocol
   itself carries no authentication.

2. **Web page content is untrusted.** Anything sourced from a page (DOM, network
   bodies, console, storage, evaluation results) is treated as hostile input and
   is redacted, boundary-wrapped, and reminder-stripped before it reaches agent
   context (see *Content safety* below).

3. **Local processes at equal privilege are out of scope** for the rogue-server
   defenses. A same-user process can read the bridge token from disk directly, so
   no loopback handshake can exclude it; Chrome's visible debugger infobar is the
   consent backstop for that case (see *Threat model*).

## Transport and bridge authentication

**Bind + port range.** The bridge listens on `127.0.0.1` only — never `0.0.0.0`.
It binds the first free port in **9333–9342** (`WS_PORT`..`WS_PORT_MAX` in
`src/shared/constants.ts`, 10 slots). Remote connections are impossible without
port forwarding.

**Per-process bridge token.** Each server process mints a random
`bridgeToken` (`randomUUID()`) at startup. It is written to
`~/.crawlio/bridges/<pid>.json` with the directory at mode `0700` and the file at
mode `0600` (`writeBridgeFile`), because the token *is* the handshake secret
and must not be group/world-readable. The file holds
`{ port, token, pid, cwd, startedAt, lastActivityAt }` and doubles as the bridge
discovery mechanism.

**WebSocket upgrade authentication** (`verifyClient` / `isAcceptableWsClient`):
- **Token path (strong).** A client presenting `?token=<bridgeToken>` is compared
  in constant time (`timingSafeEqual`) and accepted.
- **Extension origin (compatibility).** A no-token client is accepted **only** when
  it presents a `chrome-extension://` origin — the extension. A web page cannot forge
  that origin, and this keeps a trust-on-first-use extension working before the native
  host provisions a token.
- **Rejected.** A bare **no-`Origin`** or **`127.0.0.1`/`localhost`**
  connection is **no longer accepted** — those let any unauthenticated local process
  connect, evict the real extension, and receive/forge the session's command traffic.
  Everything not matched above is rejected with `403` (not `401`, which would trigger
  Chrome's auth-failed UI).

**DNS-rebind guard.** Every HTTP request and every WS upgrade must carry a
`Host` header naming loopback (`127.0.0.1`, `localhost`, or `[::1]`, port
ignored) via `isAllowedHostHeader`; otherwise it is rejected with `403`. This
defeats a rebinding page (served from `evil.com`, DNS rebound to `127.0.0.1`) that
reaches loopback but still sends `Host: evil.com`.

**`/health` is liveness-only.** It returns
`{ service, pid, port, connected, latencyMs, uptime, reconnects, queueDepth,
lastActivityAt, version }` and **does not disclose the bridge token**. Legitimate
local clients read the token from the `0600` bridge file; the extension
authenticates by its `chrome-extension://` origin. CORS `Access-Control-Allow-Origin`
is echoed only for `http://127.0.0.1` / `http://localhost` origins.

**Resource limits.** Inbound WS payloads are capped at 10 MB (`maxPayload`) with a
secondary 5 MB per-message guard, and commands are rate-limited to 60/sec
(`SlidingWindowRateLimiter`, `WS_RATE_LIMIT`).

## Server-identity handshake

**The problem.** A rogue local listener can answer `/health` with
`{ service: "crawlio-mcp" }` and lure the extension into connecting and executing
its pushed CDP commands. The handshake raises the bar so the extension can refuse a
server that cannot prove it holds the real bridge token.

**The handshake** (`src/shared/bridge-handshake.ts`):
1. On connect, the extension sends a challenge with a fresh 16-byte random nonce
   (`{ type: "__crawlio_challenge__", nonce }`).
2. The server replies with `proof = base64(HMAC-SHA256(token, "${nonce}:${port}"))`,
   where `port` is the server's **own listening port**
   (`{ type: "__crawlio_handshake__", proof }`).
3. The extension verifies the proof against the token it learned from a trusted
   channel and **the port it actually dialed**, using a constant-time comparison
   (`verifyHandshakeProof`).

**The proof is port-bound, not just nonce-bound** (a proof captured from one port cannot be replayed against another).
A rogue on port Y cannot relay the extension's nonce to the real server on port X
and pass back its answer: the real server signs `…:X`, but the extension dialed Y
and verifies against `…:Y`, so the relayed proof mismatches. This is sound because
on loopback a port maps to exactly one listening process. Without port-binding, a
listener that cannot read the `0600` file but can still open a loopback socket to
the real server could relay the challenge; binding the port closes that path.

**Trust decision** (`evaluateServerTrust(hasTrustedToken, handshakeVerified)`):

| Has trusted token? | Proof verified? | Decision | Effect |
|---|---|---|---|
| — | yes | `trusted` | commands accepted |
| yes | no | `refuse` | commands dropped (rogue closed out) |
| no | — | `tofu-allow` | trust-on-first-use (legacy behavior) |

The `refuse` branch — the one that actually closes the rogue-server hole — only
engages once the extension has been handed the **real** token. That delivery is
the native host's job.

**Single active bridge / no rogue cutover.** When a trusted token is
held and a live bridge is already active, a newly-connected bridge does **not** take
over immediately — it stays a *candidate* and only promotes (becoming the command
sink and closing the incumbent) **after** it passes the identity handshake
(`promoteVerifiedBridge`). A rogue therefore cannot knock the real bridge offline by
merely connecting. In trust-on-first-use (no token) there is nothing to verify, so
the elected most-active bridge promotes immediately (unchanged behavior).

## Native-messaging host

The host (`bin/native-host/`, named `com.crawlio.agent`) is launched by Chrome when
the extension calls `connectNative()`. Chrome only runs the binary named in a
manifest placed in a protected directory, and only routes messages to the extension
IDs in the manifest's `allowed_origins`, so a rogue process cannot impersonate it.
Over this authenticated channel the host pushes `set_crawlio_token` and
`set_crawlio_port` to the extension.

`allowed_origins` is locked to our extension's IDs: the dev/unpacked id
(`hcjdiacihjiilndbaeligceompemdcmp`) **and** the Chrome Web Store id
(`amkgjkmjjihbaigdebmphghodhblmopg`) from `ext-key.json`. Both are required —
without the store id, every Web Store install would be refused and the whole fleet
would fall back to trust-on-first-use.

**Which bridge gets the token (election).** With several servers running, the host
must hand the token to the one the user is actively driving
(`selectProvisionableBridge`):
- It lists bridge files whose `pid` is still alive, then cross-checks each against
  its `/health` (`service` + `pid` + `port` must match). A file-only forgery, or a
  pid/port mismatch, never validates and can never be provisioned.
- 0 validate → provision nothing (degrade to TOFU). 1 validates → that one. 2+
  validate → elect the **most-recently-active** (`max lastActivityAt`, the bridge
  file field stamped on each tool dispatch).
- `lastActivityAt` is attacker-forgeable, so it is consulted **only** to break ties
  among already-`/health`-validated bridges, never to admit one. Future timestamps
  (`> now + 5s`) are rejected so a forged far-future stamp cannot always win


**Without the host installed**, the extension never receives a trusted token and
runs trust-on-first-use. See *Residual risks*.

## The `execute` sandbox (`src/mcp-server/execute-sandbox.ts`)

Code mode's `execute` tool runs agent-supplied orchestration JavaScript. It does
**not** run in the page and does **not** run in the MCP server's own realm — it runs
in a dedicated **worker thread** inside a **`node:vm` context**:

- `vm.createContext` is created with `codeGeneration: { strings: false, wasm: false }`,
  so `eval` / `new Function` / WASM compilation are disabled inside the realm.
- The bootstrap deletes `Function`, `eval`, `require`, `process`, `module`,
  `exports`, `Buffer`, `fetch`, `SharedArrayBuffer`, and `WebAssembly` from the
  sandbox global, and clears `Error.prepareStackTrace`.
- The only host-callables exposed (`bridge.send`, `crawlio.*`, `smart.*`, `sleep`,
  `console`, `compileRecording`, `ocrScreenshot`) are prototype-stripped and frozen
  (`hardenHostCallable`: null prototype, `constructor` removed). Calls cross the
  worker boundary as JSON envelopes only — no live host object is ever handed into
  the sandbox.
- `TIMEOUTS` is rebuilt as a **context-realm**, null-prototype, frozen object.
  Exposing the worker-realm object directly would let sandbox code reach
  `TIMEOUTS.constructor.constructor` — the worker realm's `Function`, which is not
  bound by this context's `codeGeneration` rule — and achieve host RCE.
- Limits: 50 KB max code, 10 MB max output, 30 s max `sleep`, 1 s sync / 120 s async
  execution timeouts.

Every `bridge.send` from the sandbox is action-policy-checked and constrained to an
allowlisted command type (`assertBridgeCommand`); `crawlio.api` destinations are
allowlisted and `FORBIDDEN_CRAWLIO_PATH` blocks reaching the hosted
inference/model endpoints.

## Action policy and the policy chokepoint

**The chokepoint** (`src/mcp-server/policy-sender.ts`). Tool code may hold only a
branded `PolicyEnforcedSender`, never a raw `WebSocketBridge`. Its `send()` is
action-policy-checked at a single mint site (`makePolicyEnforcingBridge`). The brand
is a module-private `unique symbol`, so a raw bridge is **not** structurally
assignable to a policy-enforced slot; a compile-time guard (`RawBridgeIsBlocked`)
fails `npm run typecheck` if the brand is ever dropped, surfacing the bypass before
it can ship.

**The policy** (`src/mcp-server/action-policy.ts`) is an optional JSON file pointed
to by `CRAWLIO_ACTION_POLICY`: `{ default: "allow" | "deny", allow?: [...],
deny?: [...] }` with glob-suffix patterns (`get_*`). Precedence is **deny > allow >
default**. When a policy is loaded it both gates `bridge.send` and filters which
tools are advertised. The file hot-reloads on `mtime` change (checked every 5 s).
Default behavior with no policy file is unchanged (everything allowed).

## Content safety

All of the following are applied to tool output before it reaches agent context and
are **enabled by default**. The explicit raw-capture lane (`CRAWLIO_RAW_LANE=1`, or
`CRAWLIO_*_MODE=raw|traffic`) disables them, because that lane exists to preserve
page and traffic data byte for byte. `CRAWLIO_RE_LANE` and `…_MODE=re` are earlier
names for the same switch, still honored and slated for removal in the next major.

- **Secret redaction** (`src/mcp-server/redact.ts`). Redacts by sensitive key name,
  JWTs, `Bearer` tokens, recognizable provider secrets (`sk_live_…`, `ghp_…`,
  `AKIA…`, `AIza…`, …), cookie pairs, URL-encoded assignments, and high-entropy
  opaque values. Toggle: `CRAWLIO_REDACT_SECRETS`.
- **Content boundary** (`src/mcp-server/content-boundary.ts`). Page-sourced output
  is wrapped in nonce-delimited `CRAWLIO_PAGE_CONTENT` markers to contain prompt
  injection, and any `<system-reminder>` tags are stripped so a page cannot forge
  harness control messages. Toggle: `CRAWLIO_CONTENT_BOUNDARIES`.
- **Forge-resistant binary handling.** A genuine, CDP-sourced binary body
  (`base64Encoded` from `get_response_body` / `print_to_pdf`, the only
  binary-capable tools) is preserved verbatim — but the flag is honored **only** at
  the top level of those tools. A page-forged `{ content, base64Encoded: true }`
  returned from `browser_evaluate` (or nested inside a real binary body) is still
  redacted, truncated, and boundary-wrapped.

## Extension permissions

From `src/extension/manifest.prod.json`:

| Permission | Type | Rationale |
|---|---|---|
| `debugger` | required | CDP access — core functionality |
| `storage` | required | session state across SW restarts |
| `alarms` | required | reconnect intervals, scheduled captures |
| `tabs`, `tabGroups`, `history`, `downloads`, `contextMenus` | optional | requested at runtime with a user gesture |
| `nativeMessaging` | optional | enables the trusted-token channel |
| `http://127.0.0.1/*` | optional host | MCP-server health-probe CORS bypass only |

There are no broad host permissions and no auto-injected content scripts; the
`"key"` field pins a stable extension id.

## Site opt-out

A site can opt out of capture:

```html
<meta name="crawlio-agent" content="disable">
```

When present, CDP operations on that tab return an error asking the client to
respect the site's preference. The result is cached per `tabId:url` with FIFO
eviction at 500 entries (`checkSiteOptOut` in `background.ts`).

## Threat model

**In scope (defended):**
- Remote network attackers — loopback-only bind, no remote listener.
- Cross-origin / DNS-rebinding web pages — `Host`-header guard, origin checks, token.
- Untrusted page content reaching the agent — redaction, content boundary, reminder
  stripping.
- A rogue local server that cannot read the `0600` bridge file (drops a forged
  bridge file, answers `/health`, on any port) — defeated by the identity handshake once
  the native host is installed: it cannot produce a proof for the port the extension
  dialed, the **port-binding** prevents relaying the real server's proof (red-team
  #3), `/health`-validated election won't provision it the token, and the
  single-active-bridge rule keeps it from cutting over the real bridge.
- Sandbox escape from `execute` — `node:vm` realm with codegen disabled,
  prototype-stripped host callables, realm-normalized `TIMEOUTS`.

**Out of scope (by design):**
- **Same-user, equal-privilege processes.** Such a process can read the `0600`
  bridge file directly, so no loopback handshake can exclude it. The residual is
  covered by Chrome's **visible debugger infobar**, which is shown whenever a tab is
  attached and serves as the user-consent backstop (`bridge-handshake.ts:12-15`).
- **A compromised or malicious MCP client.** It is the trust boundary; it can ask
  for anything a user-driven session could.
- **OS- or browser-level compromise**, malicious extensions with their own
  `debugger` grant, and physical access.

## Residual risks (known and accepted)

We document these honestly rather than imply they are closed:

1. **Trust-on-first-use without the native host.** If the native-messaging host is
   not installed, the extension never receives a trusted token, so
   `evaluateServerTrust` always returns `tofu-allow` and the rogue-server refusal
   never engages. Install the host (`node bin/native-host/install.mjs`) to activate
   the rogue-server refusal path.
2. **Same-user origin forgery.** A no-token client is admitted on the bridge only by a
   `chrome-extension://` origin — the no-`Origin`/`localhost` admission was removed. A web page cannot forge that origin, but a same-user *local* process
   can set an arbitrary `Origin` header on a raw socket and so still be admitted. That
   residual is equal-privilege (the same process can read the `0600` bridge token
   anyway) and is out of scope. A connected client still cannot drive the extension
   without passing the port-bound identity handshake when a trusted token is held, and
   the visible debugger infobar is the consent backstop.
3. **Election tiebreak among validated same-user servers.** When two or more real,
   `/health`-validated servers run, election uses the forgeable `lastActivityAt`
   field. A same-user process running a real validating server could win the
   tiebreak — but same-user is out of scope regardless.

## Reporting a vulnerability

Please email **security@crawlio.app** with a description, affected version, and a
proof of concept if available. We aim to acknowledge reports promptly and will
coordinate disclosure. Please do not open public issues for security-sensitive
findings.
