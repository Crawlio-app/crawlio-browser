#!/usr/bin/env node
/**
 * E2E phase 2 — background operation, multi-session isolation, tab navigation, input depth.
 *
 * Phase 1 (e2e-stress.mjs) proved the tools work on a focused tab. This asks the harder
 * question: do they work on a tab the user is NOT looking at, without stealing their focus, and
 * can several agent sessions drive different tabs at once without colliding?
 *
 * The load-bearing assertion throughout is that the user's active tab NEVER CHANGES. A tool that
 * silently activates a tab to do its work is not usable in the background, however correct its
 * return value looks.
 *
 * Requires Chrome with the extension loaded, and `npm run build:server`.
 *   node tests/e2e-sessions.mjs [--takeover]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "tests/fixtures/stress/index.html");
const BRIDGE_WAIT_MS = 60_000;

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const findings = [];
let passed = 0, failed = 0;

function check(label, ok, detail) {
  if (ok) passed++; else { failed++; findings.push(`${label}: ${String(detail ?? "").slice(0, 170)}`); }
  console.log(`  ${ok ? green("PASS") : red("FAIL")} ${label}${detail ? ` ${dim(String(detail).slice(0, 110))}` : ""}`);
}

function serveFixture() {
  const html = readFileSync(FIXTURE, "utf-8");
  return new Promise((resolve) => {
    const server = createServer((_q, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

function unwrap(result) {
  if (result?.isError) throw new Error(result.content?.map((c) => c.text).join("\n") || "unknown error");
  const text = (result?.content?.find((c) => c.type === "text")?.text ?? "")
    .replace(/---\s*(?:END_)?CRAWLIO_PAGE_CONTENT[\s\S]*?---/g, "").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function waitForBridge(transport, evictRivals) {
  const started = Date.now();
  const evicted = new Set();
  while (Date.now() - started < BRIDGE_WAIT_MS) {
    for (let port = 9333; port <= 9342; port++) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).json();
        if (h.pid === transport.pid) { if (h.connected) return { ok: true, ms: Date.now() - started, port }; continue; }
        if (evictRivals && h.connected && !evicted.has(h.pid)) { evicted.add(h.pid); try { process.kill(h.pid); } catch { /* gone */ } }
      } catch { /* not listening */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, ms: Date.now() - started };
}

async function main() {
  if (!existsSync(join(ROOT, "dist/mcp-server/index.js"))) {
    console.error("dist/mcp-server/index.js missing — run `npm run build:server`."); process.exit(2);
  }
  const { server, url } = await serveFixture();
  console.log(`fixture: ${url}\n`);

  const transport = new StdioClientTransport({
    command: "node", args: ["dist/mcp-server/index.js", "--full"], cwd: ROOT, env: { ...process.env },
  });
  const client = new Client({ name: "e2e-sessions", version: "1.0.0" });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args }).then(unwrap);
  const soft = async (name, args) => { try { return await call(name, args); } catch (e) { return { _error: e.message }; } };

  const bridge = await waitForBridge(transport, process.argv.includes("--takeover"));
  if (!bridge.ok) { console.error("extension never attached — is another server holding it? try --takeover"); process.exit(2); }
  console.log(`bridge ready in ${(bridge.ms / 1000).toFixed(1)}s on port ${bridge.port}\n`);

  /** Which tab is active right now, from the browser's own point of view. */
  const activeTab = async () => {
    const r = await soft("list_tabs", {});
    const tabs = r?.tabs ?? (Array.isArray(r) ? r : []);
    const act = tabs.find((t) => t.active);
    return { id: act?.id ?? act?.tabId ?? null, url: act?.url ?? null, count: tabs.length };
  };

  const openedTabs = [];
  const openedSessions = [];

  try {
    // ---------------------------------------------------------------- background operation
    console.log("--- background operation (no focus steal) ---");
    const before = await activeTab();
    console.log(`  ${dim(`user's active tab before: ${before.id} ${String(before.url).slice(0, 60)}`)}`);

    const conn = await soft("connect_tab", { url, background: true });
    if (conn?.tabId) openedTabs.push(conn.tabId);
    const afterConnect = await activeTab();
    check("connect_tab background:true does not change the active tab",
      afterConnect.id === before.id, `active ${before.id} -> ${afterConnect.id}`);

    const onFixture = await soft("browser_evaluate", { expression: "String(!!(window.__CRAWLIO_FIXTURE__||{}).ready)" });
    check("commands still reach the background tab",
      /true/.test(String(onFixture?.result ?? onFixture?._raw ?? "")), JSON.stringify(onFixture).slice(0, 70));

    // The full input battery, all against a tab the user is not looking at.
    const battery = [
      ["click", () => call("browser_click", { selector: "#click-btn" }), "#click-readout", "clicks=1"],
      ["double-click", () => call("browser_double_click", { selector: "#dblclick-btn" }), "#dblclick-readout", "dblclicks=1"],
      ["hover", () => call("browser_hover", { selector: "#hover-btn" }), "#hover-readout", "hover=yes"],
      ["type", () => call("browser_type", { selector: "#name-input", text: "Background", clearFirst: true }), null, null],
      ["press_key", async () => { await call("browser_click", { selector: "#key-input" }); return call("browser_press_key", { key: "Escape" }); }, "#key-readout", "lastKey=Escape"],
      ["select_option", () => call("browser_select_option", { selector: "#region-select", value: "north" }), null, null],
      ["drag", () => call("browser_drag", { from: "#drag-source", to: "#drop-target" }), null, null],
      ["scroll", () => call("browser_scroll", { y: 700 }), null, null],
    ];
    for (const [name, run, readout, expect] of battery) {
      try {
        await run();
        let detail = "no error";
        let ok = true;
        if (readout) {
          const t = await call("browser_evaluate", { expression: `document.querySelector('${readout}').textContent` });
          detail = String(t?.result ?? t?._raw ?? "").trim();
          ok = detail === expect;
        }
        check(`${name} works unfocused`, ok, detail);
      } catch (e) { check(`${name} works unfocused`, false, e.message); }
    }

    const shot = await client.callTool({ name: "take_screenshot", arguments: {} });
    const img = shot.content?.find((c) => c.type === "image");
    check("screenshot of an unfocused tab", (img?.data?.length ?? 0) > 1000, `${img?.data?.length ?? 0} bytes`);

    const stillBefore = await activeTab();
    check("focus never stolen across the whole battery",
      stillBefore.id === before.id, `active ${before.id} -> ${stillBefore.id}`);

    // ---------------------------------------------------------------- tab navigation
    console.log("\n--- tab navigation ---");
    const created = await soft("create_tab", { url });
    const newId = created?.tabId ?? created?.id;
    if (newId) openedTabs.push(newId);
    check("create_tab returns a tab id", Boolean(newId), JSON.stringify(created).slice(0, 80));

    // list_tabs filters on url.startsWith("http") to hide chrome:// and about: pages, so a tab
    // that has not committed its URL yet is invisible. Poll rather than assume it never appears
    // — the distinction between "filtered forever" and "not loaded yet" is the whole finding.
    let tabs = [], seen = false, waitedMs = 0;
    for (let i = 0; i < 10 && !seen; i++) {
      const listed = await soft("list_tabs", {});
      tabs = listed?.tabs ?? [];
      seen = tabs.some((t) => (t.id ?? t.tabId) === newId);
      if (!seen) { await new Promise((r) => setTimeout(r, 500)); waitedMs += 500; }
    }
    check("list_tabs sees the new tab", seen,
      seen ? `${tabs.length} tabs after ${waitedMs}ms` : `${tabs.length} tabs, never appeared within ${waitedMs}ms`);

    if (newId) {
      const sw = await soft("switch_tab", { tabId: newId });
      check("switch_tab succeeds", !sw?._error, JSON.stringify(sw).slice(0, 70));
      const cl = await soft("close_tab", { tabId: newId });
      check("close_tab succeeds", !cl?._error, JSON.stringify(cl).slice(0, 70));
      if (!cl?._error) openedTabs.splice(openedTabs.indexOf(newId), 1);
    }

    // ---------------------------------------------------------------- multi-session
    console.log("\n--- multi-session isolation ---");
    // Re-baseline: create_tab/close_tab above deliberately move focus, and closing a tab leaves
    // Chrome on a neighbour. Measuring session focus-steal against the ORIGINAL tab would blame
    // sessions for that churn.
    const sessionBaseline = await activeTab();
    // Needs url or tabId: the JSON schema lists nothing as required, but the validator enforces
    // one of the two — an either/or constraint `required` cannot express.
    const s1 = await soft("agent_session_create", { url, name: "stress-a" });
    const s2 = await soft("agent_session_create", { url, name: "stress-b" });
    const id1 = s1?.sessionId ?? s1?.id;
    const id2 = s2?.sessionId ?? s2?.id;
    if (id1) openedSessions.push(id1);
    if (id2) openedSessions.push(id2);
    check("two sessions create with distinct ids",
      Boolean(id1 && id2 && id1 !== id2), `${id1} / ${id2}`);

    if (id1 && id2) {
      const t1 = await soft("agent_session_create_tab", { sessionId: id1, url });
      const t2 = await soft("agent_session_create_tab", { sessionId: id2, url });
      const tab1 = t1?.tabId ?? t1?.id, tab2 = t2?.tabId ?? t2?.id;
      if (tab1) openedTabs.push(tab1);
      if (tab2) openedTabs.push(tab2);
      check("each session opens its own tab",
        Boolean(tab1 && tab2 && tab1 !== tab2), `${tab1} / ${tab2}`);

      // `action` is a string enum with selector/text as siblings, not a nested object.
      const a1 = await soft("agent_session_action", { sessionId: id1, action: "type", selector: "#name-input", text: "SESSION-A" });
      const a2 = await soft("agent_session_action", { sessionId: id2, action: "type", selector: "#name-input", text: "SESSION-B" });
      check("actions run in both sessions", !a1?._error && !a2?._error,
        `${JSON.stringify(a1).slice(0, 45)} | ${JSON.stringify(a2).slice(0, 45)}`);

      const snap1 = await soft("agent_session_snapshot", { sessionId: id1 });
      const snap2 = await soft("agent_session_snapshot", { sessionId: id2 });
      check("each session snapshots independently",
        !snap1?._error && !snap2?._error, `${JSON.stringify(snap1).length}b / ${JSON.stringify(snap2).length}b`);

      const batch = await soft("agent_session_batch", { sessionId: id1, actions: [
        { action: "click", selector: "#click-btn" },
        { action: "click", selector: "#click-btn" },
      ] });
      check("batch actions run in a session", !batch?._error, JSON.stringify(batch).slice(0, 80));

      const st = await soft("agent_session_status", { sessionId: id1 });
      check("session status reports state", !st?._error, JSON.stringify(st).slice(0, 80));

      const arts = await soft("agent_session_artifacts", { sessionId: id1 });
      check("session artifacts listable", !arts?._error, JSON.stringify(arts).slice(0, 80));

      const focusAfterSessions = await activeTab();
      check("sessions do not steal focus either",
        focusAfterSessions.id === sessionBaseline.id, `active ${sessionBaseline.id} -> ${focusAfterSessions.id}`);
    }
  } finally {
    console.log("\n--- teardown ---");
    for (const sid of openedSessions) {
      const r = await soft("agent_session_close", { sessionId: sid });
      console.log(`  ${dim(`closed session ${sid}: ${JSON.stringify(r).slice(0, 50)}`)}`);
    }
    for (const tid of openedTabs) {
      await soft("close_tab", { tabId: tid });
    }
    console.log(`  ${dim(`closed ${openedTabs.length} tab(s)`)}`);
    server.close();
    try { await client.close(); } catch { /* already gone */ }
  }

  console.log(`\n${"=".repeat(64)}\n${passed} passed · ${failed} failed`);
  if (findings.length) {
    console.log(`\nFINDINGS (${findings.length})`);
    for (const f of findings) console.log(`  • ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(`\nharness error: ${e.stack || e.message}\n`); process.exit(2); });
