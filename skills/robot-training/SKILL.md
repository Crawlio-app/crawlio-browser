---
name: robot-training
description: Use this skill when the user wants to train an agent or robot from a real browser demonstration, record a full human-guided web flow, infer button-to-API contracts, build replay recipes, synthesize OpenAPI from captured traffic, or prepare timed automation runs.
allowed-tools: mcp__crawlio-browser__robot_training_start, mcp__crawlio-browser__robot_training_status, mcp__crawlio-browser__robot_training_stop, mcp__crawlio-browser__robot_training_artifacts, mcp__crawlio-browser__agent_session_create, mcp__crawlio-browser__agent_session_action, mcp__crawlio-browser__agent_session_batch, mcp__crawlio-browser__agent_session_snapshot, mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab
---

# Robot Training

Robot training turns one real browser demonstration into durable artifacts:

- interaction timeline from Crawlio session recording
- DOM/storage state snapshots from the in-page monitor
- CDP network entries and response bodies
- `flows.jsonl` compatible with `mentu-intercept synthesize`
- replay inputs for `agent_session_*` background sessions

Use this when speed and repeatability matter. The human can teach the flow once; agents later replay by API contract or semantic browser actions instead of primary mouse events.

## Capture Protocol

Start with a fresh run:

```json
{
  "url": "https://target.example/",
  "outputDir": "/absolute/path/to/runs/target-take-1",
  "maxDurationSec": 600,
  "maxInteractions": 500,
  "active": true
}
```

Call `robot_training_start` before the user begins. It opens a fresh connected tab, starts network capture, starts session recording, injects the event-driven state monitor, and writes `manifest.json`.

During the demonstration, poll with:

```json
{ "runId": "rt_..." }
```

Call `robot_training_stop` immediately after the successful demonstration. It must fetch response bodies before stopping network capture, then writes:

- `raw-dump.json`
- `recording.json`
- `network.json`
- `bodies.json`
- `state-log.json`
- `state.json`
- `flows.jsonl`
- `manifest.json`

## Analysis Protocol

After capture:

1. Read `state-log.json` to identify what changed after each click.
2. Read `recording.json` to align user interactions with page URLs and timestamps.
3. Read `network.json` and `bodies.json` to map each button to its request/response contract.
4. Use `flows.jsonl` with `mentu-intercept synthesize` when an OpenAPI draft is needed.
5. Produce a button registry: label, selector, endpoint, method, request shape, response shape, and success signal.

## Replay Protocol

Prefer API replay when the contract is known. Use `agent_session_*` when browser state, cookies, or client-side signing must be preserved:

1. `agent_session_create` with `active: false`.
2. `agent_session_action` with `evaluate` to call `fetch()` inside the page context using existing cookies/session.
3. Verify every response body or page state transition.
4. Use `agent_session_batch` for timed multi-step runs.
5. Avoid primary mouse actions. Only use DOM/contract actions or semantic background-session actions.

## Timing Strategy

For timed tasks, split the run into:

- **sync phase**: create session, read current task, capture session tokens
- **fast path**: call discovered endpoints directly
- **verification phase**: check state every N tasks or after mismatched responses
- **recovery phase**: snapshot page, infer current task, resume from the nearest known state

For 60 tasks in 240 seconds, target sub-second contract calls and keep visual/DOM snapshots off the hot path unless recovery is needed.
