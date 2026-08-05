# Telemetry

Crawlio Browser collects **anonymous usage analytics** so we can understand how many
people use it and what to improve. It is designed to tell us nothing about *you* or the
sites you browse.

## Opt out

Set the environment variable in the MCP server's environment:

```bash
CRAWLIO_TELEMETRY=0
```

Any of `0`, `false`, `off`, `no` disables it completely. When disabled, **nothing is sent.**

## What is collected

A random, anonymous **install id** (a UUID stored at `~/.crawlio/install-id`) plus:

| Field | Example | Why |
|---|---|---|
| `installId` | `3f9a…` (random UUID) | de-duplicate installs / count active servers |
| `pkgVersion` | `1.6.5` | adoption of versions |
| `platform` | `darwin` / `linux` / `win32` | platform mix |
| `nodeVersion` | `20.11.0` | supported runtimes |
| `event` | `install` / `session_start` / `heartbeat` | install vs. active usage |
| `toolCalls` | `42` (a count) | aggregate usage volume |
| `uptimeMs` | `1800000` (a number) | session length |

That's the complete list.

## What is NEVER collected

- ❌ Page content, DOM, screenshots, or any captured data
- ❌ URLs, hostnames, or which sites you visit
- ❌ Cookies, storage, tokens, credentials, or network request/response bodies
- ❌ File paths, file contents, or your code
- ❌ Names, emails, or any PII **in the payload**

There is no account and no login — the install id is a random number, and we hold nothing that
maps it to a person.

## What the endpoint sees anyway

The list above describes the **payload**. That is not the whole exposure, and an earlier version of
this document overclaimed by listing "IP-derived identity" as never collected. Correcting that:

**Every ping is an HTTP request, so `worker.crawlio.app` necessarily observes your source IP address
and the time it arrives.** We do not put your IP in the payload and we do not store it as an
identity — but the connection carries it regardless. That is how HTTP works, not a policy we can
opt out of on your behalf.

The consequence is worth stating plainly: a stable `installId`, plus a source IP, plus a heartbeat
every 30 minutes is correlatable **at the receiving end**, even though each field is individually
anonymous. Together they describe when a machine is switched on and which networks it moves
between. An identifier being random does not make the pattern it traces anonymous.

If that matters for your threat model, **turn it off** — `CRAWLIO_TELEMETRY=0` sends nothing at
all. Rotating the id breaks continuity going forward; it does not change what the next ping reveals.

## Seeing and rotating your install id

```bash
crawlio-browser audit-egress        # read-only: your id, telemetry state, every host we can reach
crawlio-browser telemetry rotate    # replace the id with a fresh random one
```

`audit-egress` changes nothing. It exists so you can see the situation before deciding anything.

Deleting `~/.crawlio/install-id` — or rotating — produces a genuinely **new** identifier. That is
worth being explicit about, because the best-known counter-example does not behave this way:
Windows' GDID is anchored on Microsoft's servers, so clearing the local copy simply makes the
machine re-download *the same number*. Ours is minted on your machine and held by no account, so
once you rotate it we cannot map the new id back to the old one even if we were asked to.

## How it works

- **Fire-and-forget:** a single short-timeout POST that swallows all errors. Telemetry can
  never block, slow, or fail an `init` step or a tool call.
- **Low volume:** one ping at install, one at server start, then an aggregate heartbeat at
  most every 30 minutes. There is **no per-tool-call network traffic** — only an in-memory
  counter that the periodic heartbeat reports.
- **Endpoint:** a Cloudflare Worker at `worker.crawlio.app` (override with
  `CRAWLIO_TELEMETRY_URL` for self-hosting/testing).

Implementation: [`src/mcp-server/telemetry.ts`](src/mcp-server/telemetry.ts).
