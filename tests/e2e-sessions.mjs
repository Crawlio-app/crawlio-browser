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
let passed = 0, failed = 0, skipped = 0;

function check(label, ok, detail) {
  if (ok) passed++; else { failed++; findings.push(`${label}: ${String(detail ?? "").slice(0, 500)}`); }
  console.log(`  ${ok ? green("PASS") : red("FAIL")} ${label}${detail ? ` ${dim(String(detail).slice(0, 300))}` : ""}`);
}

function skip(label, detail) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${label}${detail ? ` ${dim(String(detail).slice(0, 110))}` : ""}`);
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
  const text = (result?.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "")
    .replace(/---\s*(?:END_)?CRAWLIO_PAGE_CONTENT[\s\S]*?---/g, "").trim();
  if (result?.isError) throw new Error(text || "unknown error");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

/**
 * Wait for the extension to attach to OUR server, by winning the election rather than killing
 * whoever currently holds it.
 *
 * The old `--takeover` sent SIGKILL to any server whose bridge was connected. That included the
 * stdio server the developer's own editor had spawned, so every run of this suite dropped their
 * MCP connection and needed a manual reconnect — the harness breaking the environment it was
 * measuring.
 *
 * It never needed to. The extension elects the bridge with the freshest `lastActivityAt`
 * (electActiveBridge in src/extension/bridge-discipline.ts), and every MCP tool dispatch
 * publishes that stamp to the bridge file. So calling a tool here makes this server the most
 * recently active one, and the extension migrates on its next discovery pass. The incumbent stays
 * alive and simply stops being elected; when this process exits, the developer's server is still
 * there to be re-elected.
 *
 * `nudge` is any cheap tool call. It is the whole mechanism.
 */
async function waitForBridge(transport, nudge) {
  const started = Date.now();
  while (Date.now() - started < BRIDGE_WAIT_MS) {
    for (let port = 9333; port <= 9342; port++) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).json();
        if (h.pid === transport.pid && h.connected) return { ok: true, ms: Date.now() - started, port };
      } catch { /* not listening */ }
    }
    // Re-stamp: the incumbent may also be seeing traffic, and the election is on recency.
    await nudge();
    await new Promise((r) => setTimeout(r, 700));
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

  // Any tool call stamps activity. Use the permission-exempt capability probe so election never
  // depends on a functional command whose missing grant would route the user to onboarding.
  const bridge = await waitForBridge(transport, () => soft("get_capabilities", {}));
  if (!bridge.ok) { console.error("extension never attached — is Chrome running with the extension enabled?"); process.exit(2); }
  console.log(`bridge ready in ${(bridge.ms / 1000).toFixed(1)}s on port ${bridge.port}\n`);

  // Refuse to grade a stale browser. Chrome does not hot-reload unpacked extensions, and older
  // copies linger as loadable directories; when one answers, the suite reports a scatter of
  // unrelated failures in code that is fine.
  const onDisk = (/buildId:"([^"]+)"/.exec(readFileSync(join(ROOT, "dist/extension/background.js"), "utf-8")) ?? [])[1] ?? null;
  // A Chrome reload can briefly leave the previous service-worker generation answering while
  // the authenticated native channel re-elects this freshly spawned server. Keep the server
  // active long enough for the current generation to receive the new token and take ownership;
  // otherwise the guard races the handoff and reports a manual-reload failure that is already
  // resolving in the background.
  let caps = await soft("get_capabilities", {});
  const buildHandoffDeadline = Date.now() + 15_000;
  while (onDisk && caps?.buildId !== onDisk && Date.now() < buildHandoffDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    caps = await soft("get_capabilities", {});
  }
  if (onDisk && caps?.buildId !== onDisk) {
    console.error(`\n  STOP: Chrome is running ${caps?.buildId ? `build ${caps.buildId}` : "a build too old to report its id"}, but dist/extension is ${onDisk}.`);
    console.error(`  Load unpacked from ${join(ROOT, "dist/extension")} at chrome://extensions, then re-run.\n`);
    process.exit(2);
  }
  console.log(`extension build matches dist (${onDisk})\n`);

  const health = await (await fetch(`http://127.0.0.1:${bridge.port}/health`)).json();
  const hasTabsPermission = health?.extensionPermissions?.permissions?.tabs === true;
  const allowForeground = process.argv.includes("--foreground");
  console.log(`optional tabs permission: ${hasTabsPermission ? "granted" : "not granted"}`);
  if (!allowForeground) console.log("foreground-changing checks disabled (pass --foreground to opt in)\n");


  /** Which tab is active right now, from the browser's own point of view. */
  const activeTab = async () => {
    if (!hasTabsPermission) return { id: null, url: null, count: 0 };
    // list_tabs intentionally hides chrome:// pages. The user is commonly looking at
    // chrome://extensions while reloading an unpacked build, so using it here turned the focus
    // invariant into null === null. get_user_tabs includes that active tab and proves identity.
    const r = await soft("get_user_tabs", {});
    const tabs = r?.tabs ?? (Array.isArray(r) ? r : []);
    const act = tabs.find((t) => t.active);
    return { id: act?.id ?? act?.tabId ?? null, url: act?.url ?? null, count: tabs.length };
  };

  const openedTabs = [];
  const openedSessions = [];

  // A previous timed-out run may have completed session creation after its caller gave up. Clean
  // only this harness's stable names so a retry starts from a known state without touching user
  // sessions or tabs.
  const priorSessions = await soft("agent_session_list", { includeClosed: false });
  for (const session of priorSessions?.sessions ?? []) {
    if (session?.name === "stress-a" || session?.name === "stress-b") {
      await soft("agent_session_close", { sessionId: session.sessionId ?? session.id, closeTab: true });
    }
  }

  try {
    // ---------------------------------------------------------------- background operation
    console.log("--- background operation (no focus steal) ---");
    const before = await activeTab();
    if (hasTabsPermission) {
      console.log(`  ${dim(`user's active tab before: ${before.id} ${String(before.url).slice(0, 60)}`)}`);
    }

    const conn = await soft("connect_tab", { url, background: true });
    if (conn?.tabId) openedTabs.push(conn.tabId);
    if (hasTabsPermission) {
      const afterConnect = await activeTab();
      check("connect_tab background:true does not change the active tab",
        afterConnect.id === before.id, `active ${before.id} -> ${afterConnect.id}`);
    } else {
      const backgroundStatus = await soft("get_connection_status", {});
      check("connect_tab persists background ownership without the tabs grant",
        backgroundStatus?.connectedTab?.tabId === conn?.tabId && backgroundStatus?.connectedTab?.background === true,
        JSON.stringify(backgroundStatus?.connectedTab).slice(0, 90));
      skip("direct active-tab identity check", "optional tabs permission not granted");
    }

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

    if (hasTabsPermission) {
      const stillBefore = await activeTab();
      check("focus never stolen across the whole battery",
        stillBefore.id === before.id, `active ${before.id} -> ${stillBefore.id}`);
    } else {
      skip("direct focus identity across the input battery", "optional tabs permission not granted");
    }

    // ---------------------------------------------------------------- tab navigation
    console.log("\n--- tab navigation ---");
    const created = await soft("create_tab", { url, active: false });
    const newId = created?.tabId ?? created?.id;
    if (newId) openedTabs.push(newId);
    check("create_tab returns a tab id", Boolean(newId), JSON.stringify(created).slice(0, 80));

    // list_tabs filters on url.startsWith("http") to hide chrome:// and about: pages, so a tab
    // that has not committed its URL yet is invisible. Poll rather than assume it never appears
    // — the distinction between "filtered forever" and "not loaded yet" is the whole finding.
    if (hasTabsPermission) {
      let tabs = [], seen = false, waitedMs = 0;
      for (let i = 0; i < 10 && !seen; i++) {
        const listed = await soft("list_tabs", {});
        tabs = listed?.tabs ?? [];
        seen = tabs.some((t) => (t.id ?? t.tabId) === newId);
        if (!seen) { await new Promise((r) => setTimeout(r, 500)); waitedMs += 500; }
      }
      check("list_tabs sees the new tab", seen,
        seen ? `${tabs.length} tabs after ${waitedMs}ms` : `${tabs.length} tabs, never appeared within ${waitedMs}ms`);
    } else {
      skip("list_tabs sees the new tab", "optional tabs permission not granted");
    }

    if (newId) {
      if (allowForeground) {
        const sw = await soft("switch_tab", { tabId: newId });
        check("switch_tab succeeds", !sw?._error, JSON.stringify(sw).slice(0, 70));
      } else {
        skip("switch_tab succeeds", "foreground mutation requires explicit --foreground opt-in");
      }
      const cl = await soft("close_tab", { tabId: newId });
      check("close_tab succeeds", !cl?._error, JSON.stringify(cl).slice(0, 70));
      if (!cl?._error) openedTabs.splice(openedTabs.indexOf(newId), 1);
    }

    // ---------------------------------------------------------------- multi-session
    console.log("\n--- multi-session isolation ---");
    // Re-baseline: create_tab/close_tab above deliberately move focus, and closing a tab leaves
    // Chrome on a neighbour. Measuring session focus-steal against the ORIGINAL tab would blame
    // sessions for that churn.
    //
    // Chrome picks that neighbour asynchronously, so sample until the active tab stops moving.
    // Baselining mid-settle blamed sessions for the close above them — the reported "steal" was
    // always to a LOWER tab id, i.e. an older tab, which no session ever creates.
    const settledActiveTab = async () => {
      let prev = await activeTab();
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const now = await activeTab();
        if (now.id === prev.id) return now;
        prev = now;
      }
      return prev;
    };
    const sessionBaseline = hasTabsPermission ? await settledActiveTab() : null;
    // Needs url or tabId: the JSON schema lists nothing as required, but the validator enforces
    // one of the two — an either/or constraint `required` cannot express.
    const s1 = await soft("agent_session_create", { url, name: "stress-a" });
    const s2 = await soft("agent_session_create", { url, name: "stress-b" });
    const id1 = s1?.sessionId ?? s1?.id;
    const id2 = s2?.sessionId ?? s2?.id;
    if (id1) openedSessions.push(id1);
    if (id2) openedSessions.push(id2);
    check("two sessions create with distinct ids",
      Boolean(id1 && id2 && id1 !== id2),
      id1 || id2
        ? `${id1} / ${id2}`
        : `${JSON.stringify(s1).slice(0, 100)} | ${JSON.stringify(s2).slice(0, 100)}`);

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

      if (hasTabsPermission && sessionBaseline) {
        const focusAfterSessions = await activeTab();
        check("sessions do not steal focus either",
          focusAfterSessions.id === sessionBaseline.id, `active ${sessionBaseline.id} -> ${focusAfterSessions.id}`);
      } else {
        skip("direct session focus identity check", "optional tabs permission not granted");
      }
    }

    // ---------------------------------------------------------------- parallel tab targeting
    console.log("\n--- parallel tab targeting (tabId) ---");
    // Sessions above prove several tabs can be driven through ~13 semantic actions. This proves
    // the same with the FULL command surface, by naming a tab on ordinary commands.
    //
    // Everything here asserts effects rather than acknowledgements: a targeting bug that resolved
    // to the connected tab would return success for every call while writing to one page.
    if (!hasTabsPermission) {
      skip("parallel arbitrary-tab targeting", "adopting caller-supplied tab IDs requires the optional tabs permission");
    } else {
      const pinnedBefore = await soft("get_connection_status", {});
      const pinnedTabId = pinnedBefore?.connectedTab?.tabId ?? null;

      const pa = await soft("create_tab", { url, active: false });
      const pb = await soft("create_tab", { url, active: false });
      const tabA = pa?.tabId ?? pa?.id, tabB = pb?.tabId ?? pb?.id;
      if (tabA) openedTabs.push(tabA);
      if (tabB) openedTabs.push(tabB);
      check("two target tabs open", Boolean(tabA && tabB && tabA !== tabB), `${tabA} / ${tabB}`);

      if (tabA && tabB) {
      // Presence in list_tabs only proves Chrome assigned the id; it does not prove the background
      // document committed. Wait through the public tab-scoped tool before grading interactions.
      const [readyA, readyB] = await Promise.all([
        soft("browser_wait_for", { tabId: tabA, selector: "#name-input", state: "visible", timeout: 30000 }),
        soft("browser_wait_for", { tabId: tabB, selector: "#name-input", state: "visible", timeout: 30000 }),
      ]);
      check("both target tabs become interaction-ready",
        !readyA?._error && !readyB?._error && readyA?.found !== false && readyB?.found !== false,
        `${JSON.stringify(readyA).slice(0, 240)} | ${JSON.stringify(readyB).slice(0, 240)}`);

      // The real question: two tabs, driven at the same time, each writing its own value.
      const [wa, wb] = await Promise.all([
        soft("browser_type", { tabId: tabA, selector: "#name-input", text: "TAB-A", clearFirst: true }),
        soft("browser_type", { tabId: tabB, selector: "#name-input", text: "TAB-B", clearFirst: true }),
      ]);
      check("concurrent typing into two tabs reports success",
        !wa?._error && !wb?._error, `${JSON.stringify(wa).slice(0, 40)} | ${JSON.stringify(wb).slice(0, 40)}`);

      const readValue = async (tabId) => {
        const r = await soft("browser_evaluate", { tabId, expression: "document.querySelector('#name-input').value" });
        return String(r?.result ?? r?._raw ?? "").trim().replace(/^"|"$/g, "");
      };
      const [va, vb] = await Promise.all([readValue(tabA), readValue(tabB)]);
      check("each tab holds its own value", va === "TAB-A" && vb === "TAB-B", `A="${va}" B="${vb}"`);

      // Independent click counters — proves the two tabs are not one tab clicked twice.
      await Promise.all([
        soft("browser_click", { tabId: tabA, selector: "#click-btn" }),
        soft("browser_click", { tabId: tabB, selector: "#click-btn" }),
        soft("browser_click", { tabId: tabB, selector: "#click-btn" }),
      ]);
      const readClicks = async (tabId) => {
        const r = await soft("browser_evaluate", { tabId, expression: "document.querySelector('#click-readout').textContent" });
        return String(r?.result ?? r?._raw ?? "").trim().replace(/^"|"$/g, "");
      };
      // A dispatched click returns once CDP has delivered the events, which is not the same
      // moment the page's own handler has run — so read until the count settles rather than
      // once. Reading once turned a landed click into a phantom "lost action".
      const readClicksUntil = async (tabId, want) => {
        let seen = "";
        for (let i = 0; i < 20; i++) {
          seen = await readClicks(tabId);
          if (seen === want) return seen;
          await new Promise((r) => setTimeout(r, 150));
        }
        return seen;
      };
      const [ca, cb] = await Promise.all([readClicksUntil(tabA, "clicks=1"), readClicksUntil(tabB, "clicks=2")]);
      check("click counts are per-tab", ca === "clicks=1" && cb === "clicks=2", `A=${ca} B=${cb}`);

      // activeFrameId was a module global, so switching frames on one tab retargeted evaluation on
      // every other. The fixture's child frame declares a different marker from the top document,
      // which is what distinguishes "evaluated in the frame" from "returned something plausible".
      const whichFrame = async (tabId) => {
        const r = await soft("browser_evaluate", { tabId, expression: "String(window.__CRAWLIO_FRAME__ || (window.__CRAWLIO_FIXTURE__||{}).frame)" });
        return String(r?.result ?? r?._raw ?? "").trim().replace(/^"|"$/g, "");
      };
      const framesA = await soft("get_frame_tree", { tabId: tabA });
      const childFrame = (framesA?.frames ?? []).find((f) => f.parentFrameId);
      if (childFrame) {
        await soft("switch_to_frame", { tabId: tabA, frameId: childFrame.frameId });

        const [inA, inB] = await Promise.all([whichFrame(tabA), whichFrame(tabB)]);
        check("the switched tab evaluates inside its child frame", inA === "child", `A frame="${inA}"`);
        check("the other tab still evaluates in its top document", inB === "top", `B frame="${inB}"`);

        const framesB = await soft("get_frame_tree", { tabId: tabB });
        check("switch_to_frame on one tab leaves the other on its main frame",
          framesB?.activeFrameId == null, `B activeFrameId=${framesB?.activeFrameId}`);

        await soft("switch_to_main_frame", { tabId: tabA });
        check("switch_to_main_frame returns the tab to its top document",
          (await whichFrame(tabA)) === "top", "A back on top");
      } else {
        check("fixture exposes a child frame for frame targeting", false,
          `frames=${JSON.stringify(framesA?.frames ?? []).slice(0, 80)}`);
      }

      // Targeting must not move the pin: an agent driving three tabs cannot be allowed to
      // reassign the one a human connected.
      const pinnedAfter = await soft("get_connection_status", {});
      check("targeting another tab does not move the connected tab",
        (pinnedAfter?.connectedTab?.tabId ?? null) === pinnedTabId,
        `pinned ${pinnedTabId} -> ${pinnedAfter?.connectedTab?.tabId ?? null}`);

      // A closed tab must fail loudly rather than silently acting on the pinned tab. Two separate
      // things to prove: the call errors, AND nothing happened to the connected tab.
      const pinnedBefore2 = await soft("browser_evaluate", { expression: "document.querySelector('#click-readout').textContent" });
      const ghost = await soft("browser_click", { tabId: 999999, selector: "#click-btn" });
      check("an unknown tabId is an error, not a silent fallback",
        Boolean(ghost?._error) && /not found|closed/i.test(ghost._error), String(ghost?._error ?? ghost).slice(0, 90));
      const pinnedAfter2 = await soft("browser_evaluate", { expression: "document.querySelector('#click-readout').textContent" });
      check("a rejected target leaves the connected tab untouched",
        String(pinnedAfter2?.result) === String(pinnedBefore2?.result),
        `${pinnedBefore2?.result} -> ${pinnedAfter2?.result}`);

      // Two actions fired at ONE tab must both land. A click is three CDP events, so without
      // per-tab serialization they interleave into press,press,release,release — one click, two
      // success responses. An agent told it can work tabs in parallel will do this.
      // Asserted as a DELTA from a measured baseline, not an absolute total. The invariant is
      // "two concurrent clicks add exactly two" — pinning the running total made this depend on
      // everything earlier in the suite, and it failed intermittently reporting 5 where 4 was
      // expected while the product was dispatching correctly (verified separately: N concurrent
      // clicks produce exactly N for N=2,3,5).
      const clicksBefore = Number(/clicks=(\d+)/.exec(await readClicks(tabB))?.[1] ?? NaN);
      await Promise.all([
        soft("browser_click", { tabId: tabB, selector: "#click-btn" }),
        soft("browser_click", { tabId: tabB, selector: "#click-btn" }),
      ]);
      const want = `clicks=${clicksBefore + 2}`;
        const cbAfter = await readClicksUntil(tabB, want);
        check("concurrent actions on a single tab all register", cbAfter === want, `${clicksBefore} + 2 -> ${cbAfter}`);
      }
    }

    // ---------------------------------------------------------------- profiles
    console.log("\n--- chrome profiles ---");
    const profs = await soft("list_profiles", {});
    const seenProfiles = profs?.profiles ?? [];
    check("list_profiles reports the connected profile",
      Boolean(profs?.connected), `connected=${profs?.connected} seen=${seenProfiles.length}`);
    check("the connected profile is marked active",
      seenProfiles.some((p) => p.active && p.profileId === profs?.connected),
      JSON.stringify(seenProfiles).slice(0, 90));

    // Switching to a profile that never connected must refuse rather than strand the bridge.
    const bogus = await soft("switch_profile", { profileId: "00000000-0000-4000-8000-000000000000" });
    check("switch_profile refuses an unknown profile",
      Boolean(bogus?._error) && /has not connected/.test(bogus._error), String(bogus?._error ?? bogus).slice(0, 80));

    const stillConnected = await soft("get_connection_status", {});
    check("a refused switch leaves the connection intact",
      stillConnected?.connected === true, JSON.stringify(stillConnected?.connected));

    if (seenProfiles.length < 2) {
      console.log(`  ${dim("only one profile has connected — switching between profiles needs a second Chrome profile with the extension loaded (manual)")}`);
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

  // ------------------------------------------------------------------ cold start after reconnect
  // Runs last, and only once the client above has released the bridge — it needs to be the one
  // asking for the browser.
  //
  // This is what "MCP fails every time" actually was: every `/mcp` reconnect spawns a fresh server,
  // and its FIRST browser call was the one that died. Three separate defects fed it — a bridge-file
  // write throttle that discarded a new server's first activity stamp (so the native host never
  // elected it and the extension never attached), a queue drained ahead of the identity proof (so
  // the extension refused the command), and a silent refusal (so nothing failed loudly enough to
  // retry). Each is unit-tested; only a real browser proves they compose.
  console.log("\n--- cold start after reconnect ---");
  for (const round of [1, 2]) {
    const cold = new StdioClientTransport({
      command: "node", args: ["dist/mcp-server/index.js"], cwd: ROOT, env: { ...process.env },
    });
    const coldClient = new Client({ name: `e2e-cold-${round}`, version: "1.0.0" });
    await coldClient.connect(cold);
    const started = Date.now();
    let tabs;
    try {
      const r = await coldClient.callTool({
        name: "execute",
        arguments: { code: `const s = await bridge.send({ type: "get_connection_status" }); return { connected: !!s.connected };` },
      });
      tabs = unwrap(r);
    } catch (e) {
      tabs = { _error: e.message };
    }
    const ms = Date.now() - started;
    check(`round ${round}: a freshly spawned server's first call reaches the browser`,
      typeof tabs?.connected === "boolean", `${ms}ms ${JSON.stringify(tabs).slice(0, 80)}`);
    // The failure mode was a 30-45s timeout, so the budget is what distinguishes "worked" from
    // "eventually gave up"; election + attach measured ~1.2-3s.
    check(`round ${round}: it gets there without waiting out a timeout`,
      ms < 15_000, `${ms}ms`);
    try { await coldClient.close(); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 5000)); // let the extension settle before the next round
  }

  console.log(`\n${"=".repeat(64)}\n${passed} passed · ${failed} failed · ${skipped} skipped`);
  if (findings.length) {
    console.log(`\nFINDINGS (${findings.length})`);
    for (const f of findings) console.log(`  • ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(`\nharness error: ${e.stack || e.message}\n`); process.exit(2); });
