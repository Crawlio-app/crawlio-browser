---
name: robot-training
description: Use this skill when the user wants to train an agent or robot from a real browser demonstration, record a full human-guided web flow, infer button-to-API contracts, build replay recipes, synthesize OpenAPI from captured traffic, or prepare timed automation runs.
allowed-tools: mcp__crawlio-browser__observe, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Robot Training

Robot training turns one real browser demonstration into durable artifacts:

- interaction timeline from Crawlio session recording
- DOM/storage state snapshots streamed into extension-owned IndexedDB
- CDP network entries and response bodies
- portable request/response traces in `flows.jsonl`
- replay inputs for `agent_session_*` background sessions

Use this when speed and repeatability matter. The human can teach the flow once; agents later replay by API contract or semantic browser actions instead of primary mouse events.

## Capture Protocol

Start with a fresh run:

```json
{
  "action": "training_start",
  "url": "https://target.example/",
  "outputDir": "/absolute/path/to/runs/target-take-1",
  "maxDurationSec": 600,
  "maxInteractions": 500,
  "active": true,
  "captureStorageValues": false
}
```

Call `observe` with `action: "training_start"` before the user begins. The extension opens a
fresh tab, starts network capture and recording, installs an event-driven monitor for the current
and future documents, and retains the run locally. The MCP server writes `manifest.json`, but it
does not own collection.

During the demonstration, poll with:

```json
{ "action": "training_status", "runId": "rt_..." }
```

Call `observe` with `action: "training_stop"` and the same `runId` after the demonstration. The
extension fetches bounded/redacted response bodies before stopping Network, returns its resident
export, and the server materializes:

- `raw-dump.json`
- `recording.json`
- `network.json`
- `bodies.json`
- `state-log.json`
- `state.json`
- `flows.jsonl`
- `causal-graph.json`
- `CAUSAL.md`
- `recipe.json`
- `REGISTRY.md`
- `api.openapi.yaml`
- `manifest.json`

If MCP disconnects during the demonstration, do nothing in the page. The extension continues
collecting. Reconnect, query `training_status`, and stop with the original `runId`.

After the canonical files have been verified, delete the extension-retained record only when the
user asks to remove it:

```json
{ "action": "training_clear", "runId": "rt_...", "confirm": true }
```

`training_clear` rejects active runs and never deletes files under `outputDir`; call
`training_stop` first. The confirmation and exact run id make retention deletion deliberate.

Storage keys are retained by default, not values. Only set `captureStorageValues: true` when the
user explicitly requests it; password-, token-, and secret-shaped fields remain redacted.

## Analysis Protocol

After capture:

1. Read `state-log.json` to identify what changed after each click.
2. Read `recording.json` to align user interactions with page URLs and timestamps.
3. Read `network.json` and `bodies.json` to map each button to its request/response contract.
4. Read `api.openapi.yaml` as a captured-endpoint draft and validate it against `network.json`
   before promotion; keep `flows.jsonl` as the replay/synthesis input.
5. Produce a button registry: label, selector, endpoint, method, request shape, response shape, and success signal.

## Replay Protocol

Prefer API replay when the contract is known. Use `agent_session_*` when browser state, cookies, or client-side signing must be preserved:

1. In `execute`, send `bridge.send({ type: "agent_session_create", url: targetURL, active: false })`.
2. Use `bridge.send({ type: "agent_session_action", action: "evaluate", ... })` to call `fetch()` inside the page context using existing cookies/session.
3. Verify every response body or page state transition.
4. Use `bridge.send({ type: "agent_session_batch", ... })` for timed multi-step runs.
5. Avoid primary mouse actions. Only use DOM/contract actions or semantic background-session actions.

## Timing Strategy

For timed tasks, split the run into:

- **sync phase**: create session, read current task, capture session tokens
- **fast path**: call discovered endpoints directly
- **verification phase**: check state every N tasks or after mismatched responses
- **recovery phase**: snapshot page, infer current task, resume from the nearest known state

For 60 tasks in 240 seconds, target sub-second contract calls and keep visual/DOM snapshots off the hot path unless recovery is needed.
