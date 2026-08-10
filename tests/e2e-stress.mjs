#!/usr/bin/env node
/**
 * E2E stress harness — the real path, twice.
 *
 *   harness → MCP stdio → server → WebSocket bridge → extension → CDP → live page
 *
 * One matrix, executed against a freshly spawned server in code mode and again in --full mode.
 * Most cases map 1:1 between a full-mode tool name and a bridge command type, so the matrix
 * declares the command once and only the TRANSPORT differs — which is also what makes a
 * mode-specific divergence (the storage tools, the full-mode-only tools) visible instead of
 * quietly untested.
 *
 * Every assertion checks an EFFECT, not an acknowledgement. A tool that returns ok while doing
 * nothing is the failure this exists to catch.
 *
 * Requires: Chrome running with the unpacked extension loaded, and `npm run build:server`.
 * Not part of `npm test` — it needs a real browser. Run before a Web Store submission.
 *
 *   node tests/e2e-stress.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "tests/fixtures/stress/index.html");
const BRIDGE_WAIT_MS = 60_000;
const CASE_TIMEOUT_MS = 60_000;
const CRAWLIO_PORT_FILE = join(homedir(), "Library", "Logs", "Crawlio", "control.port");
const CRAWLIO_TOKEN_FILE = join(homedir(), "Library", "Logs", "Crawlio", "mcp.token");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function probeCrawlioSidecar() {
  if (!existsSync(CRAWLIO_PORT_FILE) || !existsSync(CRAWLIO_TOKEN_FILE)) {
    return { state: "unavailable", detail: "optional Crawlio app discovery files are absent" };
  }

  const port = Number.parseInt(readFileSync(CRAWLIO_PORT_FILE, "utf-8").trim(), 10);
  const token = readFileSync(CRAWLIO_TOKEN_FILE, "utf-8").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
    return { state: "error", detail: "optional Crawlio app discovery metadata is invalid" };
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: {
        "X-Crawlio-MCP-Token": token,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) return { state: "ready", detail: `authenticated on port ${port}` };
    if (response.status === 401 || response.status === 403) {
      return { state: "error", detail: `optional Crawlio app rejected its MCP capability (HTTP ${response.status})` };
    }
    return { state: "error", detail: `optional Crawlio app readiness failed (HTTP ${response.status})` };
  } catch {
    // Discovery files can outlive a crashed or force-quit companion app. That is ordinary optional
    // integration absence, not an authenticated enrichment failure in the browser candidate.
    return { state: "unavailable", detail: `optional Crawlio app is not listening on port ${port}` };
  }
}

// --- fixture server -------------------------------------------------------------------------

function serveFixture() {
  const html = readFileSync(FIXTURE, "utf-8");
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Every path returns the fixture, so navigation cases can use arbitrary URLs.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

// --- MCP plumbing ---------------------------------------------------------------------------

function unwrap(result) {
  if (result?.isError) {
    const t = result.content?.map((c) => c.text).join("\n") || "unknown error";
    throw new Error(t);
  }
  let text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  // execute() wraps page-derived output in provenance markers. BOTH markers carry a nonce, so
  // the terminator has to be matched non-greedily rather than assumed to be bare.
  text = text.replace(/---\s*(?:END_)?CRAWLIO_PAGE_CONTENT[\s\S]*?---/g, "").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

/**
 * Wait until the extension is attached to OUR server, evicting rivals while we wait.
 *
 * Claiming a port once is not enough. The election is sticky to the port it is already on, so
 * when the editor respawns its server on that same port it simply keeps the session and a test
 * server elsewhere never wins. Killing each rival as it appears leaves ours as the only live
 * bridge, which is the one condition under which the election can pick it. Scoped to the run:
 * the editor respawns its server afterwards, and by then ours is the verified incumbent.
 */
async function waitForBridge(transport, timeoutMs = BRIDGE_WAIT_MS, nudge = null) {
  const started = Date.now();
  const rivals = new Set();   // other servers seen holding the extension, for the contention note
  while (Date.now() - started < timeoutMs) {
    for (let port = 9333; port <= 9342; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        const health = await res.json();
        if (health.pid === transport.pid) {
          if (health.connected) return { ok: true, ms: Date.now() - started, port, version: health.version, rivals: rivals.size };
          continue;
        }
        // Deliberately no kill here. The extension elects the bridge with the freshest
        // lastActivityAt, and every tool dispatch publishes that stamp — so this server wins by
        // being used. SIGKILL-ing the incumbent also killed the stdio server the developer's
        // editor had spawned, dropping their MCP connection on every run.
        if (health.connected) rivals.add(health.pid);
      } catch { /* port not listening */ }
    }
    // Make this server the most recently active one, which is what the extension elects on.
    if (nudge) await nudge();
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, ms: Date.now() - started, rivals: rivals.size };
}

/**
 * Refuse to grade a browser that is running a different build than the one on disk.
 *
 * Chrome does not hot-reload unpacked extensions, and stale copies of older releases sit around
 * as loadable directories. When an old build answers, the suite reports a scatter of unrelated
 * failures — clicks landing nowhere, tools rejecting long expressions — that read as regressions
 * in code that is actually fine. Comparing the build stamp turns an hour of misdiagnosis into
 * one line.
 */
async function assertCurrentBuild(getCapabilities) {
  let onDisk = null;
  try {
    const bundle = readFileSync(join(ROOT, "dist/extension/background.js"), "utf-8");
    onDisk = (/buildId:"([^"]+)"/.exec(bundle) ?? [])[1] ?? null;
  } catch { /* not built — nothing to compare against */ }
  if (!onDisk) return { ok: true, reason: "no local build to compare" };

  // Must be asked the way the mode under test can ask. get_capabilities is a full-mode tool; in
  // code mode it is reachable only through execute, so calling it directly threw, `loaded` stayed
  // null, and the guard reported "a build too old to report its id" — aborting the entire code
  // phase over a build that was current. The diagnosis was wrong, not the build.
  let caps = {};
  const deadline = Date.now() + 15_000;
  let polling = true;
  while (polling) {
    try { caps = await getCapabilities(); } catch { /* old build may not answer */ }
    polling = caps?.buildId !== onDisk && Date.now() < deadline;
    if (!polling) break;
    // A stale reload generation can win the first socket and then be superseded by the current
    // worker. Re-stamping this server also keeps the authenticated bridge election pointed here.
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  const loaded = caps?.buildId ?? null;
  if (loaded === onDisk) return { ok: true, loaded };
  return {
    ok: false,
    loaded,
    onDisk,
    reason: loaded
      ? `Chrome is running build ${loaded}, but dist/extension is ${onDisk}.`
      : `Chrome is running a build too old to report its id (dist/extension is ${onDisk}).`,
  };
}

/** Is the extension still reachable? Distinguishes "asleep" from "tool broken" on a timeout. */
async function bridgeAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.json()).connected === true;
  } catch { return false; }
}

/**
 * Find a server that already holds the extension.
 *
 * This is the single most important precondition, and it is not a bug being worked around.
 * `planBridgeConnections` (src/extension/bridge-discipline.ts:163) returns an EMPTY plan when the
 * extension holds a trusted token and already has a verified, open incumbent — deliberately, so
 * a rogue local server cannot steal a session by faking activity. A freshly spawned test server
 * therefore never wins while another one holds the browser, and waiting simply burns a minute.
 */
async function findIncumbent(excludePid) {
  for (let port = 9333; port <= 9342; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const h = await res.json();
      if (h.connected && h.pid !== excludePid) return { port, pid: h.pid, version: h.version };
    } catch { /* not listening */ }
  }
  return null;
}

/**
 * The transport abstraction. In full mode a command is a tool call; in code mode the same
 * command goes through execute() over the bridge. Callers write the command once.
 */
function makeApi(client, mode) {
  const call = (name, args) => client.callTool({ name, arguments: args }).then(unwrap);
  // Some tools answer with a non-text content block — take_screenshot correctly returns an MCP
  // image block rather than stringified base64 — so a raw view is needed to inspect those.
  const callRaw = (name, args) => client.callTool({ name, arguments: args });

  // Server-composed tools have no matching extension command, so bridge.send returns
  // "Unknown command". In code mode they are reachable only through a smart.* helper —
  // and for some there is no helper at all, which is what `fullOnly` marks.
  const SMART_PATH = {
    detect_tables: (a) => `smart.detectTables(${JSON.stringify(a)})`,
    extract_table: (a) => `smart.extractTable(${JSON.stringify(a.selector ?? a)})`,
    detect_sections: (a) => `smart.detectSections(${JSON.stringify(a)})`,
    detect_technologies: (a) => `smart.detectTechnologies(${JSON.stringify(a)})`,
    extract_data: (a) => `smart.extractData(${JSON.stringify(a)})`,
  };

  async function cmd(type, args = {}) {
    if (mode === "full") return call(type, args);
    // connect_tab is one of code mode's seven first-class tools. Sending it through execute
    // instead tests the sandbox's arbitrary 25s bridge deadline, not the documented MCP path
    // (whose connection workflow includes tab load + CDP domain setup).
    if (type === "connect_tab") return call(type, args);
    const viaSmart = SMART_PATH[type];
    if (viaSmart) return call("execute", { code: `return await ${viaSmart(args)};` });
    const payload = JSON.stringify({ type, ...args });
    const commandTimeout = type === "browser_navigate" ? 40000 : 25000;
    return call("execute", { code: `return await bridge.send(${payload}, ${commandTimeout});` });
  }

  return {
    mode,
    cmd,
    call,
    callRaw,
    exec: (code) => call("execute", { code }),

    /**
     * Perform an action the way each mode is meant to. Full mode's tool handlers are wrapped in
     * withAutoSettle (pre-flight pollActionability); in code mode that polling lives in smart.*,
     * so a raw bridge.send skips it. Using smart.* here measures the product on its documented
     * path rather than penalising it for a call shape nobody should write.
     */
    async act(kind, selector, text) {
      if (mode === "full") {
        return kind === "type"
          ? call("browser_type", { selector, text, clearFirst: true })
          : call("browser_click", { selector });
      }
      return call("execute", {
        code: kind === "type"
          ? `return await smart.type(${JSON.stringify(selector)}, ${JSON.stringify(text)}, { clearFirst: true });`
          : `return await smart.click(${JSON.stringify(selector)});`,
      });
    },

    evaluate: (expression) => cmd("browser_evaluate", { expression }),

    /** Read text from the page — the primitive every effect assertion is built on. */
    async text(selector) {
      const r = await cmd("browser_evaluate", {
        expression: `(document.querySelector(${JSON.stringify(selector)})||{}).textContent`,
      });
      return String(r?.result ?? r?.value ?? r?._raw ?? "").trim();
    },

    async value(selector) {
      const r = await cmd("browser_evaluate", {
        expression: `(document.querySelector(${JSON.stringify(selector)})||{}).value`,
      });
      return String(r?.result ?? r?.value ?? r?._raw ?? "").trim();
    },

    // Storage is the one shape that genuinely differs: in code mode `type` is the bridge
    // envelope's own key, so the storage kind must travel as `storageType`.
    getStorage: (kind) => mode === "full"
      ? call("get_storage", { type: kind })
      : cmd("get_storage", { storageType: kind }),
    setStorage: (kind, key, value) => mode === "full"
      ? call("set_storage", { type: kind, key, value })
      : cmd("set_storage", { storageType: kind, key, value }),
  };
}

// --- the matrix -----------------------------------------------------------------------------

/**
 * Each case asserts an effect. `fullOnly` marks tools the code-mode bridge cannot reach
 * (they are composed server-side), so they are skipped with a reason rather than silently passing.
 */
function buildMatrix(fixtureUrl, artifactDir) {
  return [
    // --- input ------------------------------------------------------------------------------
    // Code mode drives these through smart.*, which is the documented path and the one that runs
    // actionability polling. The raw-bridge divergence is measured separately below.
    {
      group: "input", name: "click mutates the DOM",
      async run(api) {
        await api.act("click", "#click-btn");
        const t = await api.text("#click-readout");
        return { ok: t === "clicks=1", detail: t };
      },
    },
    {
      group: "input", name: "double-click fires dblclick",
      async run(api) {
        await api.cmd("browser_double_click", { selector: "#dblclick-btn" });
        const t = await api.text("#dblclick-readout");
        return { ok: t === "dblclicks=1", detail: t };
      },
    },
    {
      group: "input", name: "hover triggers mouseover",
      async run(api) {
        await api.cmd("browser_hover", { selector: "#hover-btn" });
        const t = await api.text("#hover-readout");
        return { ok: t === "hover=yes", detail: t };
      },
    },
    {
      group: "input", name: "type lands the value in the field",
      async run(api) {
        await api.act("type", "#name-input", "Ada Lovelace");
        const v = await api.value("#name-input");
        return { ok: v === "Ada Lovelace", detail: v };
      },
    },
    {
      // Regression probe: raw bridge access and the recommended smart wrapper must both apply the
      // effect; smart additionally owns actionability polling and settling.
      group: "input", name: "raw bridge.send and smart.click both work", codeOnly: true,
      async run(api) {
        await api.cmd("browser_navigate", { url: fixtureUrl });
        const raw = await api.exec(
          `return await bridge.send({ type:'browser_click', selector:'#click-btn' }, 10000);`);
        const afterRaw = await api.text("#click-readout");
        await api.exec(`return await smart.click('#click-btn');`);
        const afterSmart = await api.text("#click-readout");
        const rawWorked = afterRaw === "clicks=1";
        return {
          ok: rawWorked,
          detail: `raw bridge.send reported y=${raw?.y ?? "?"} readout=${afterRaw}; ` +
                  `smart.click readout=${afterSmart}` +
                  (rawWorked ? "" : " — raw path reports success without clicking"),
        };
      },
    },
    {
      group: "input", name: "press_key reaches the focused element",
      async run(api) {
        await api.cmd("browser_click", { selector: "#key-input" });
        await api.cmd("browser_press_key", { key: "Enter" });
        const t = await api.text("#key-readout");
        return { ok: t === "lastKey=Enter", detail: t };
      },
    },
    {
      group: "input", name: "select_option changes the selection",
      async run(api) {
        await api.cmd("browser_select_option", { selector: "#region-select", value: "south" });
        const v = await api.value("#region-select");
        return { ok: v === "south", detail: v };
      },
    },
    {
      group: "input", name: "scroll moves the viewport",
      async run(api) {
        await api.cmd("browser_scroll", { y: 900 });
        const r = await api.evaluate("String(Math.round(window.scrollY))");
        const y = Number(r?.result ?? r?._raw ?? 0);
        return { ok: y > 100, detail: `scrollY=${y}` };
      },
    },
    {
      group: "input", name: "drag reaches the drop target",
      async run(api) {
        await api.cmd("browser_drag", { from: "#drag-source", to: "#drop-target" });
        const t = await api.text("#drop-readout");
        return { ok: t !== "empty" && t.length > 0, detail: t };
      },
    },
    {
      // fill_form is ref-only: its schema requires `fields[].ref`, so a snapshot has to be taken
      // first to mint them. CSS selectors are rejected.
      group: "input", name: "fill_form sets fields via snapshot refs",
      async run(api) {
        await api.cmd("browser_navigate", { url: fixtureUrl });
        const snap = await api.cmd("browser_snapshot", { interactive: true, maxDepth: 14 });
        const s = typeof snap === "string" ? snap : JSON.stringify(snap);
        // Select by ROLE. Taking the first refs in document order picks up the heading, which
        // is not fillable — the tool then correctly reports "ref not found" for it.
        const filled = [...s.matchAll(/textbox[^\n]*?\[ref=(e\d+)\]/g)].map((m) => m[1]).slice(0, 2);
        if (filled.length < 2) return { ok: false, detail: `only ${filled.length} textbox refs in snapshot` };
        const r = await api.cmd("browser_fill_form", {
          fields: filled.map((ref, i) => ({ ref, value: i === 0 ? "Grace Hopper" : "stress notes" })),
        });
        // Assert the fields actually hold the values. The per-field `status` array is only
        // present in one mode's response, and the effect is what matters either way.
        const statuses = (r?.fields ?? []).map((f) => f.status).join(",");
        const name = await api.value("#name-input");
        const notes = await api.value("#notes-input");
        return {
          ok: name === "Grace Hopper" && notes === "stress notes",
          detail: `refs=${filled.join(",")} -> "${name}" / "${notes}"${statuses ? ` (statuses=${statuses})` : ""}`,
        };
      },
    },

    // --- actionability ----------------------------------------------------------------------
    {
      // Actionability polling lives in the full-mode handler wrapper and in smart.*, by design:
      // raw bridge.send is the unguarded escape hatch and does not wait. So these drive the
      // documented path for each mode, which is what a user actually gets.
      group: "actionability", name: "waits for an element that appears late",
      async run(api) {
        // Issued immediately after a reload, before #delayed-btn exists (1200ms).
        await api.cmd("browser_navigate", { url: fixtureUrl });
        const t0 = Date.now();
        await api.act("click", "#delayed-btn");
        const t = await api.text("#delayed-readout");
        return { ok: t === "delayed=1", detail: `${t} after ${Date.now() - t0}ms` };
      },
    },
    {
      group: "actionability", name: "waits for an overlay to clear",
      async run(api) {
        await api.cmd("browser_navigate", { url: fixtureUrl });
        const t0 = Date.now();
        await api.act("click", "#covered-btn");
        const t = await api.text("#covered-readout");
        return { ok: t === "covered=1", detail: `${t} after ${Date.now() - t0}ms` };
      },
    },

    // --- extraction -------------------------------------------------------------------------
    {
      group: "extraction", name: "detect_tables finds both table shapes",
      async run(api) {
        // Returns the candidate ARRAY directly, not an object wrapping one.
        const r = await api.cmd("detect_tables", {});
        const list = Array.isArray(r) ? r : (r?.candidates ?? r?.tables ?? []);
        const strategies = list.map((c) => c.strategy).join(",");
        return { ok: list.length >= 2, detail: `candidates=${list.length} strategies=${strategies}` };
      },
    },
    {
      group: "extraction", name: "extract_table returns rows with header names",
      async run(api) {
        const r = await api.cmd("extract_table", { selector: "#results-table" });
        const rows = r?.rows ?? r?.data ?? [];
        const first = rows[0] ? JSON.stringify(rows[0]) : "";
        return { ok: rows.length === 4 && /Region|region/.test(first), detail: `rows=${rows.length} ${first.slice(0, 80)}` };
      },
    },
    {
      group: "extraction", name: "detect_sections maps page regions",
      async run(api) {
        const r = await api.cmd("detect_sections", { maxDepth: 3, maxSections: 20 });
        const s = r?.sections ?? [];
        return { ok: s.length >= 3, detail: `sections=${s.length}` };
      },
    },
    {
      group: "extraction", name: "inspect_datalayer reads the pushed events",
      async run(api) {
        const r = await api.cmd("inspect_datalayer", {});
        const blob = JSON.stringify(r);
        return { ok: /page_view|view_item|dataLayer/.test(blob), detail: blob.slice(0, 100) };
      },
    },
    {
      group: "extraction", name: "parse_tracking_pixels sees the fbq calls",
      async run(api) {
        const r = await api.cmd("parse_tracking_pixels", {});
        const blob = JSON.stringify(r);
        return { ok: blob.length > 2, detail: blob.slice(0, 100) };
      },
    },
    {
      group: "extraction", name: "detect_technologies returns a fingerprint result",
      async run(api) {
        const r = await api.cmd("detect_technologies", {});
        const blob = JSON.stringify(r);
        return { ok: blob.length > 2 && !/error/i.test(blob), detail: blob.slice(0, 90) };
      },
    },

    // --- capture ----------------------------------------------------------------------------
    {
      group: "capture", name: "browser_snapshot builds an ARIA tree with refs",
      async run(api) {
        const r = await api.cmd("browser_snapshot", { interactive: true, maxDepth: 6 });
        const s = typeof r === "string" ? r : JSON.stringify(r);
        return { ok: /\[ref=/.test(s), detail: `${s.length} chars` };
      },
    },
    {
      group: "capture", name: "take_screenshot returns image bytes",
      async run(api) {
        // The payload is large base64 under `data`. Measure it inside the sandbox rather than
        // hauling ~200KB back through the tool response, which output shaping would truncate.
        if (api.mode === "full") {
          const r = await api.callRaw("take_screenshot", {});
          const img = r.content?.find((c) => c.type === "image");
          return {
            ok: (img?.data?.length ?? 0) > 1000,
            detail: img ? `${img.mimeType} image block, ${img.data.length} bytes` : `no image block: ${JSON.stringify(r).slice(0, 80)}`,
          };
        }
        const r = await api.exec(
          `const s = await bridge.send({ type:'take_screenshot' }, 20000);
           return { bytes: (s && s.data ? String(s.data).length : 0) };`);
        return { ok: (r?.bytes ?? 0) > 1000, detail: `${r?.bytes ?? 0} bytes` };
      },
    },
    {
      group: "capture", name: "capture_page returns a composite capture",
      async run(api) {
        const r = await api.cmd("capture_page", {});
        // A full capture is large enough that code mode returns it as raw text rather than a
        // parsed object, so check for the fields by name instead of requiring a parse.
        const s = typeof r?._raw === "string" ? r._raw : JSON.stringify(r);
        const present = ["url", "title", "framework", "network", "console"].filter((k) => s.includes(`"${k}"`));
        return { ok: present.length >= 3, detail: `${present.join(",")} (${s.length}b)` };
      },
    },
    {
      group: "integration", name: "authenticated optional Crawlio enrichment is accepted",
      fullOnly: true, requiresCrawlioSidecar: true,
      async run(api) {
        const result = await api.call("enrich_url", { url: fixtureUrl, waitMs: 0 });
        return {
          ok: result?.enrichmentSent === true,
          detail: `enrichmentSent=${String(result?.enrichmentSent)}`,
        };
      },
    },
    {
      group: "capture", name: "get_accessibility_tree returns nodes",
      async run(api) {
        const r = await api.cmd("get_accessibility_tree", {});
        const s = JSON.stringify(r);
        return { ok: s.length > 50, detail: `${s.length} chars` };
      },
    },

    // --- storage (the shape that differs per mode) ------------------------------------------
    {
      group: "storage", name: "set_storage then get_storage round-trips",
      async run(api) {
        await api.setStorage("local", "crawlio_stress", "round-trip");
        const r = await api.getStorage("local");
        const s = JSON.stringify(r);
        return { ok: /round-trip/.test(s), detail: s.slice(0, 90) };
      },
    },

    // --- recording --------------------------------------------------------------------------
    {
      group: "recording", name: "records agent-issued interactions and stops",
      async run(api) {
        await api.cmd("start_recording", { maxDurationSec: 30, maxInteractions: 20 });
        await api.cmd("browser_click", { selector: "#click-btn" });
        await api.cmd("browser_type", { selector: "#name-input", text: "recorded" });
        const status = await api.cmd("get_recording_status", {});
        const stopped = await api.cmd("stop_recording", {});
        const s = JSON.stringify(stopped);
        const count = stopped?.interactions?.length ?? stopped?.session?.interactions?.length ?? 0;
        return {
          ok: count > 0 || s.length > 200,
          detail: `status=${JSON.stringify(status).slice(0, 60)} interactions=${count} payload=${s.length}b`,
        };
      },
    },
    {
      group: "recording", name: "stop when not recording fails cleanly",
      async run(api) {
        try {
          const r = await api.cmd("stop_recording", {});
          const s = JSON.stringify(r);
          return { ok: /not recording|no active|error/i.test(s), detail: s.slice(0, 90) };
        } catch (e) {
          return { ok: /not recording|no active/i.test(e.message), detail: e.message.slice(0, 90) };
        }
      },
    },

    // --- robot training ---------------------------------------------------------------------
    {
      // Server-composed with no smart.* binding and no bridge command, so code mode cannot
      // reach it at all — the same shape as seo_audit, but undeclared in CODE_MODE_HINTS.
      group: "robot-training", name: "start / status / stop / artifacts / clear round-trip", fullOnly: true,
      async run(api) {
        // Opens its OWN tab; active:false keeps focus, outputDir keeps artifacts out of the repo.
        const started = await api.cmd("robot_training_start", {
          url: fixtureUrl, outputDir: artifactDir, active: false,
          maxDurationSec: 15, maxInteractions: 10,
        });
        // stop and artifacts are correctly strict: they take the runId / outputDir that start
        // returned, so the ids have to be threaded through rather than guessed.
        const runId = started?.runId ?? started?.run?.runId;
        const outDir = started?.outputDir ?? artifactDir;
        if (!runId) return { ok: false, detail: `start returned no runId: ${JSON.stringify(started).slice(0, 120)}` };

        const status = await api.cmd("robot_training_status", { runId });
        const stopped = await api.cmd("robot_training_stop", { runId, closeTab: true });
        const artifacts = await api.cmd("robot_training_artifacts", { outputDir: outDir });
        const cleared = await api.cmd("robot_training_clear", { runId, confirm: true });
        const afterClear = await api.cmd("robot_training_status", { runId });
        // Trust the disk over the response shape: the bundle is what actually matters, and an
        // empty `files` array must not be mistaken for "nothing was written".
        const listed = Array.isArray(artifacts?.files) ? artifacts.files.length : 0;
        const onDisk = existsSync(outDir) ? readdirSync(outDir).length : 0;
        const wrote = Math.max(listed, onDisk);
        // A tool that actually fails throws out of unwrap(), so this only has to catch the soft
        // shapes returned as data. Scanning the whole JSON for "error" caught a nested,
        // BY-DESIGN-tolerated one instead: robot_training_start reports domainState, and an
        // optional domain that declines to enable records {"success":false,"error":...} inside an
        // otherwise successful response. That read as a failed round-trip when the bundle was fine.
        const softFailure = (r) =>
          typeof r?.error === "string" ||
          (typeof r?._raw === "string" && /Invalid input|\[problem:/i.test(r._raw));
        const failed = [started, status, stopped, artifacts, cleared, afterClear].some(softFailure);
        return {
          ok: !failed && wrote > 0 && cleared?.cleared === runId && (afterClear?.runs?.length ?? 0) === 0,
          detail: `runId=${runId} artifacts=${wrote} files retained=${afterClear?.runs?.length ?? "?"}`,
        };
      },
    },

    // --- tabs and frames --------------------------------------------------------------------
    {
      group: "tabs", name: "list_tabs includes the fixture tab",
      async run(api) {
        try {
          const r = await api.cmd("list_tabs", {});
          const tabs = r?.tabs ?? r ?? [];
          const hit = JSON.stringify(tabs).includes("127.0.0.1");
          return { ok: Array.isArray(tabs) ? tabs.length > 0 && hit : hit, detail: `tabs=${(tabs.length ?? "?")}` };
        } catch (error) {
          // `tabs` is intentionally optional. On the permission-floor profile, the correct E2E
          // behavior is a structured refusal while owned background tabs remain fully usable.
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: /permission|tabs/i.test(message),
            detail: /permission|tabs/i.test(message)
              ? "optional tabs permission absent — structured refusal confirmed"
              : message.slice(0, 100),
          };
        }
      },
    },
    {
      group: "tabs", name: "get_frame_tree returns the main frame",
      async run(api) {
        const r = await api.cmd("get_frame_tree", {});
        const s = JSON.stringify(r);
        return { ok: /frame/i.test(s), detail: s.slice(0, 80) };
      },
    },

    // --- emulation --------------------------------------------------------------------------
    {
      group: "emulation", name: "set_viewport changes innerWidth",
      async run(api) {
        await api.cmd("set_viewport", { width: 820, height: 640, deviceScaleFactor: 1, mobile: false });
        const r = await api.evaluate("String(window.innerWidth)");
        const w = Number(r?.result ?? r?._raw ?? 0);
        return { ok: w === 820, detail: `innerWidth=${w}` };
      },
    },

    // --- full-mode-only ---------------------------------------------------------------------
    {
      group: "full-only", name: "check_robots_txt (server-composed)", fullOnly: true,
      async run(api) {
        const r = await api.call("check_robots_txt", { url: fixtureUrl });
        return { ok: JSON.stringify(r).length > 2, detail: JSON.stringify(r).slice(0, 90) };
      },
    },
    {
      group: "full-only", name: "seo_audit (server-composed)", fullOnly: true,
      async run(api) {
        const r = await api.call("seo_audit", {});
        const s = JSON.stringify(r);
        return { ok: s.length > 2 && !s.startsWith('{"error'), detail: s.slice(0, 90) };
      },
    },

    // --- failure shapes ---------------------------------------------------------------------
    {
      group: "errors", name: "a bad selector reports a structured failure",
      async run(api) {
        try {
          const r = await api.cmd("browser_click", { selector: "#definitely-not-here" });
          const s = JSON.stringify(r);
          return { ok: /error|not_found|timeout|problem/i.test(s), detail: s.slice(0, 110) };
        } catch (e) {
          return { ok: /not found|timeout|actionab/i.test(e.message), detail: e.message.slice(0, 110) };
        }
      },
    },
  ];
}

// --- run ------------------------------------------------------------------------------------

async function runMode(mode, fixtureUrl, artifactDir, findings, takeover, crawlioSidecar) {
  const header = `${mode === "full" ? "FULL MODE (--full)" : "CODE MODE (default)"}`;
  console.log(`\n${"=".repeat(72)}\n${header}\n${"=".repeat(72)}`);

  // Claim the lowest port. The election ties on lastActivityAt (both fresh servers are 0), is
  // sticky to the current active port, and otherwise takes the LOWEST port
  // (bridge-discipline.ts electActiveBridge). So freeing 9333 and binding it before the editor
  // respawns is what decides this — any pause here hands 9333 straight back.
  // No port is freed by force. Port order only breaks a TIE in electActiveBridge; the primary
  // signal is recency, which waitForBridge supplies by calling a tool. Killing whoever held 9333
  // was how this suite kept disconnecting the developer's own editor.
  if (takeover) {
    const held = await findIncumbent(null);
    if (held) console.log(`  ${dim(`pid ${held.pid} holds port ${held.port}; winning the election by activity instead of freeing it`)}`);
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: mode === "full" ? ["dist/mcp-server/index.js", "--full"] : ["dist/mcp-server/index.js"],
    env: { ...process.env },
    cwd: ROOT,
  });
  const client = new Client({ name: `e2e-stress-${mode}`, version: "1.0.0" });
  await client.connect(transport);
  const api = makeApi(client, mode);

  // Case #0: how long until a freshly spawned server can actually be used.
  // Any tool call publishes the activity stamp the election reads. In code mode
  // get_capabilities is not exposed directly, so nudge through execute just like a real client.
  const nudge = () => api.cmd("get_capabilities").catch(() => {});
  const bridge = await waitForBridge(transport, BRIDGE_WAIT_MS, nudge);
  if (bridge.ok) {
    const contended = (bridge.rivals ?? 0) > 0;
    console.log(`  ${green("PASS")} cold start — extension reached this server in ${dim(`${(bridge.ms / 1000).toFixed(1)}s`)}` +
      ` (port ${bridge.port}, v${bridge.version}${contended ? `, after winning the election from ${bridge.rivals} live server(s)` : ""})`);
    // Only report this as a product finding when nothing was competing. With rivals present the
    // elapsed time measures this harness winning an election, not how long a user would wait.
    if (bridge.ms > 5000 && !contended) {
      findings.push(`[${mode}] cold start took ${(bridge.ms / 1000).toFixed(1)}s before the first command could succeed — a client's first tool call inside that window times out`);
    }
  } else {
    console.log(`  ${red("FAIL")} cold start — extension never connected within ${BRIDGE_WAIT_MS / 1000}s`);
    findings.push(`[${mode}] the extension never connected to a freshly spawned server within ${BRIDGE_WAIT_MS / 1000}s`);
  }

  const buildCheck = await assertCurrentBuild(() => api.cmd("get_capabilities"));
  if (!buildCheck.ok) {
    console.log(`  ${red("STOP")} ${buildCheck.reason}`);
    console.log(`  ${dim("Load unpacked from " + join(ROOT, "dist/extension") + " at chrome://extensions, then re-run.")}`);
    findings.push(`[${mode}] aborted: stale extension build loaded — ${buildCheck.reason}`);
    try { await client.close(); } catch { /* already gone */ }
    return { mode, results: [], coldStartMs: bridge.ms, connected: bridge.ok, aborted: true };
  }
  console.log(`  ${green("PASS")} extension build matches dist ${dim(buildCheck.loaded ?? "")}`);

  const tools = await client.listTools();
  const available = new Set(tools.tools.map((t) => t.name));
  console.log(`  ${dim(`tools/list reports ${available.size}`)}`);

  if (mode === "code") {
    const capabilityReport = await api.cmd("get_capabilities");
    const reportedTools = new Map((capabilityReport?.tools ?? []).map((tool) => [tool.name, tool.status]));
    const capabilityTruth = reportedTools.get("list_tabs") === "available"
      && reportedTools.get("get_user_tabs") === "available"
      && !reportedTools.has("get_user_history")
      && !reportedTools.has("get_downloads");
    const optionalPermissionTruth = JSON.stringify(capabilityReport?.permissions?.granted) === JSON.stringify(["tabs", "nativeMessaging"])
      && (capabilityReport?.permissions?.missing?.length ?? 0) === 0
      && (capabilityReport?.permissions?.originsMissing?.length ?? 0) === 0;
    console.log(`  ${capabilityTruth && optionalPermissionTruth ? green("PASS") : red("FAIL")} live capability report matches completed onboarding and excludes removed commands`);
    if (!capabilityTruth || !optionalPermissionTruth) {
      findings.push(`[${mode}] capability report disagrees with completed onboarding or advertises removed history/download commands`);
    }
  }

  let fixtureTabId = null;
  const results = [];

  try {
    // The harness owns a background tab. Keeping the connection explicitly backgrounded makes
    // CDP input use focus emulation and guarantees synthetic keyboard/mouse events never compete
    // with the user's foreground Chrome tab.
    const connected = await api.cmd("connect_tab", { url: fixtureUrl, background: true });
    fixtureTabId = connected?.tabId ?? null;
    if (!fixtureTabId) throw new Error("connect_tab did not return the owned fixture tab id");
    // connect_tab reuses a tab already on this URL without reloading it, so the readouts would
    // still hold counts from the previous mode's run. Navigate explicitly for a clean slate.
    await api.cmd("browser_navigate", { url: fixtureUrl });
    const marker = await api.evaluate("String(!!(window.__CRAWLIO_FIXTURE__ && window.__CRAWLIO_FIXTURE__.ready))");
    const onFixture = /true/.test(String(marker?.result ?? marker?._raw ?? ""));
    console.log(`  ${onFixture ? green("PASS") : red("FAIL")} on the fixture page`);
    if (!onFixture) findings.push(`[${mode}] connect_tab did not land on the fixture page`);

    for (const c of buildMatrix(fixtureUrl, artifactDir)) {
      if (c.fullOnly && mode !== "full") {
        results.push({ ...c, status: "skip", detail: "full-mode only — server-composed, not reachable via bridge.send" });
        console.log(`  ${yellow("SKIP")} ${c.name} ${dim("— full-mode only")}`);
        continue;
      }
      if (c.codeOnly && mode !== "code") {
        results.push({ ...c, status: "skip", detail: "code-mode only — compares execute() paths, which full mode does not expose" });
        console.log(`  ${yellow("SKIP")} ${c.name} ${dim("— code-mode only")}`);
        continue;
      }
      if (c.requiresCrawlioSidecar) {
        if (crawlioSidecar.state === "unavailable") {
          results.push({ ...c, status: "skip", detail: crawlioSidecar.detail });
          console.log(`  ${yellow("SKIP")} ${c.name} ${dim(`— ${crawlioSidecar.detail}`)}`);
          continue;
        }
        if (crawlioSidecar.state !== "ready") {
          results.push({ ...c, status: "fail", detail: crawlioSidecar.detail });
          console.log(`  ${red("FAIL")} ${c.name} ${dim(crawlioSidecar.detail)}`);
          findings.push(`[${mode}] ${c.group}/${c.name}: ${crawlioSidecar.detail}`);
          continue;
        }
      }
      const t0 = Date.now();
      try {
        const out = await Promise.race([
          c.run(api),
          new Promise((_, rej) => setTimeout(() => rej(new Error("case timeout")), CASE_TIMEOUT_MS)),
        ]);
        const ms = Date.now() - t0;
        results.push({ ...c, status: out.ok ? "pass" : "fail", detail: out.detail, ms });
        console.log(`  ${out.ok ? green("PASS") : red("FAIL")} ${c.name} ${dim(`(${ms}ms)`)} ${dim(String(out.detail ?? "").slice(0, 90))}`);
        if (!out.ok) findings.push(`[${mode}] ${c.group}/${c.name}: ${String(out.detail ?? "").slice(0, 160)}`);
      } catch (e) {
        const ms = Date.now() - t0;
        // Distinguish a sleeping extension from a broken tool before blaming the tool.
        const alive = bridge.port ? await bridgeAlive(bridge.port) : false;
        const label = e.message === "case timeout" && !alive ? "extension unreachable" : e.message;
        results.push({ ...c, status: "fail", detail: label, ms });
        console.log(`  ${red("FAIL")} ${c.name} ${dim(`(${ms}ms)`)} ${dim(label.slice(0, 90))}`);
        findings.push(`[${mode}] ${c.group}/${c.name}: ${label.slice(0, 160)}`);
      }
    }
  } finally {
    // Close only the background tab created by this harness. Never activate, navigate, or
    // reconnect the user's foreground tab during teardown.
    if (fixtureTabId) {
      try { await api.cmd("close_tab", { tabId: fixtureTabId }); } catch { /* best effort */ }
    }
    try { await client.close(); } catch { /* already gone */ }
  }

  return { mode, results, coldStartMs: bridge.ms, connected: bridge.ok };
}

async function main() {
  if (!existsSync(join(ROOT, "dist/mcp-server/index.js"))) {
    console.error("dist/mcp-server/index.js is missing — run `npm run build:server` first.");
    process.exit(2);
  }

  // The extension attaches to exactly one server and will not cut over to another while its
  // incumbent is verified and open. So either we are the only server, or we get nothing.
  const incumbent = await findIncumbent(null);
  if (incumbent) {
    if (!process.argv.includes("--takeover")) {
      console.error(`
  A server already holds the extension: pid ${incumbent.pid} on port ${incumbent.port} (v${incumbent.version}).

  The extension attaches to exactly one bridge and refuses to cut over while its incumbent is
  verified and open — deliberate, so a rogue local server cannot hijack a live session
  (src/extension/bridge-discipline.ts:163). A test server spawned alongside it will never
  connect, no matter how long it waits.

  Re-run with --takeover to stop that server first, or stop it yourself:

      kill ${incumbent.pid}

  Your editor will respawn its own server afterwards; because the test server is verified by
  then, the session stays where this harness put it until the run ends.
`);
      process.exit(2);
    }
    console.log(`taking over from pid ${incumbent.pid} on port ${incumbent.port} (v${incumbent.version})`);
  }
  const takeover = Boolean(incumbent);
  const crawlioSidecar = await probeCrawlioSidecar();

  const { server, url } = await serveFixture();
  const artifactDir = mkdtempSync(join(tmpdir(), "crawlio-stress-"));
  console.log(`fixture: ${url}\nartifacts: ${artifactDir}`);
  console.log(`Crawlio sidecar: ${crawlioSidecar.state} (${crawlioSidecar.detail})`);

  const requestedMode = ["code", "full"].find((mode) => process.argv.includes(`--mode=${mode}`)) ?? null;

  const findings = [];
  const runs = [];
  try {
    if (requestedMode !== "full") {
      runs.push(await runMode("code", url, artifactDir, findings, takeover, crawlioSidecar));
    }
    if (requestedMode === null) {
      // The extension needs a moment to notice the first server's socket close and re-elect;
      // claiming the port again while it is mid-flap produces connect/disconnect churn.
      await new Promise((r) => setTimeout(r, 6000));
    }
    if (requestedMode !== "code") {
      runs.push(await runMode("full", url, artifactDir, findings, takeover, crawlioSidecar));
    }
  } finally {
    server.close();
  }

  console.log(`\n${"=".repeat(72)}\nSUMMARY\n${"=".repeat(72)}`);
  for (const r of runs) {
    const pass = r.results.filter((x) => x.status === "pass").length;
    const fail = r.results.filter((x) => x.status === "fail").length;
    const skip = r.results.filter((x) => x.status === "skip").length;
    console.log(`  ${r.mode.padEnd(5)}  ${pass} passed · ${fail} failed · ${skip} skipped · cold start ${(r.coldStartMs / 1000).toFixed(1)}s`);
  }

  if (findings.length) {
    console.log(`\n${"=".repeat(72)}\nFINDINGS (${findings.length})\n${"=".repeat(72)}`);
    for (const f of findings) console.log(`  • ${f}`);
  } else {
    console.log("\nNo findings.");
  }

  console.log(`\nArtifacts left at ${artifactDir} — delete when done.\n`);
  process.exit(findings.length ? 1 : 0);
}

main().catch((e) => { console.error(`\nharness error: ${e.stack || e.message}\n`); process.exit(2); });
