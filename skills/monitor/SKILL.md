---
name: monitor
description: "Monitor a page for structural/content changes with extension-resident, bounded local snapshots that continue without MCP"
allowed-tools: mcp__crawlio-browser__observe, mcp__crawlio-browser__execute
---

# Monitor — Resident Change Detection

Use this skill to watch an HTTP/HTTPS page across time. Crawlio creates a background tab, captures
a compact ARIA baseline, and schedules recaptures with `chrome.alarms`. Collection lives in the
extension: an MCP disconnect or server restart does not erase the baseline or skip scheduled work.

## Start

Call the default-mode `observe` tool:

```json
{
  "action": "monitor_start",
  "url": "https://target.example/page",
  "label": "pricing page",
  "intervalMinutes": 5
}
```

Retain the returned `monitorId`. The response includes the initial baseline. Chrome alarms have a
30-second minimum and can run late under browser load; do not promise wall-clock precision.

## Query

Status does not touch the page:

```json
{ "action": "monitor_status", "monitorId": "mon_..." }
```

Read recent diffs without returning the full snapshots:

```json
{
  "action": "monitor_results",
  "monitorId": "mon_...",
  "limit": 10,
  "includeSnapshot": false
}
```

Each result carries `changed`, `additions`, `removals`, `unchanged`, and `diff`. Cite changed diff
lines as evidence; there is no `sample` field. If technology or performance evidence is required,
use `execute` after a change is detected and call `smart.detectTechnologies()` or
`smart.extractPage()` explicitly. The resident monitor itself claims structural/content change
only.

## Stop or Delete

Stop future captures but retain history:

```json
{ "action": "monitor_stop", "monitorId": "mon_...", "closeTab": true }
```

Delete a monitor and its retained snapshots:

```json
{ "action": "monitor_clear", "monitorId": "mon_...", "closeTab": true }
```

Use `monitor_status` and `monitor_results` to inspect retained work, `monitor_stop` to end future
captures, and `monitor_clear` to delete a monitor and its snapshots. The extension popup is
status-only and does not manage resident work. Storage is bounded to 25 MiB with oldest completed
runs/snapshots evicted first; no `unlimitedStorage` or new Chrome permission is used. Compact ARIA
snapshots intentionally retain visible page text in local extension storage, so monitor only pages
whose displayed content the user agrees to retain; the snapshots are not sent to Crawlio by this
lifecycle.

## Reporting

Report the URL, capture times, exact additions/removals, and whether a gap was caused by a failed
capture. Do not turn an alarm delay into a content finding, compare screenshots by eye, or use a
page-side polling loop.
