#!/usr/bin/env node
/**
 * Real-Chrome E2E for extension-resident training and monitoring.
 *
 *   code-mode MCP #1 starts work -> MCP process exits -> page changes + Chrome alarm fires ->
 *   code-mode MCP #2 reconnects -> queries/stops the same extension-owned jobs
 *
 * This is intentionally outside `npm test`: it needs Chrome running with the freshly built
 * unpacked extension. It refuses to grade a stale extension build.
 *
 * An always-on editor MCP would normally reconnect as soon as MCP #1 exits and make that middle
 * interval impossible to prove. The default harness therefore publishes a test-owned election
 * quarantine: a /health-validated bridge candidate that reuses MCP #1's already trusted token but
 * rejects every WebSocket upgrade. The extension has no command transport during the interval,
 * while unrelated editor processes can stay alive.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_DIR = join(homedir(), ".crawlio", "bridges");
const MANUAL_BRIDGE_CONTROL = process.env.CRAWLIO_E2E_MANUAL_BRIDGE_CONTROL === "1";
const BRIDGE_WAIT_MS = MANUAL_BRIDGE_CONTROL ? 180_000 : 60_000;
const BRIDGE_SILENCE_WAIT_MS = MANUAL_BRIDGE_CONTROL ? 180_000 : 8_000;
const ALARM_WAIT_MS = 38_000;
const SECRET = `resident-secret-${Date.now().toString(36)}`;
const REQUIRED_ARTIFACTS = [
  "manifest.json", "raw-dump.json", "recording.json", "network.json", "bodies.json",
  "state-log.json", "state.json", "causal-graph.json", "CAUSAL.md", "recipe.json",
  "REGISTRY.md", "flows.jsonl", "api.openapi.yaml",
];

const green = (value) => `\x1b[32m${value}\x1b[0m`;
const red = (value) => `\x1b[31m${value}\x1b[0m`;
const dim = (value) => `\x1b[2m${value}\x1b[0m`;

function unwrap(result) {
  if (result?.isError) {
    throw new Error(result.content?.map((item) => item.text).join("\n") || "unknown MCP error");
  }
  const text = (result?.content?.find((item) => item.type === "text")?.text ?? "")
    .replace(/---\s*(?:END_)?CRAWLIO_PAGE_CONTENT[\s\S]*?---/g, "")
    .trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function trainingHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Resident training fixture</title></head>
<body>
  <main>
    <label>Username <input id="username" name="username"></label>
    <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
    <button id="teach" type="button">Teach action</button>
    <output id="result">idle</output>
  </main>
  <script>
    localStorage.setItem("profile-theme", "dark");
    localStorage.setItem("auth-token", "fixture-token-must-not-leak");
    document.querySelector("#teach").addEventListener("click", () => {
      document.querySelector("#result").textContent = "learned";
    });
  </script>
</body></html>`;
}

function serveFixture() {
  let monitorRevision = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/learn")) {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, password: "response-secret-must-not-leak" }));
        });
        return;
      }
      if (req.url?.startsWith("/monitor")) {
        monitorRevision += 1;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><html><head><title>Resident monitor fixture</title></head><body><main><h1>Monitor revision ${monitorRevision}</h1><p>Changed on every navigation.</p></main></body></html>`);
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // The name deliberately avoids the cookie collector's legacy auth-name heuristic. The
        // resident export must redact every cookie value, including ordinary preference cookies.
        "set-cookie": `e2e-preference=${SECRET}; Path=/; SameSite=Lax`,
      });
      res.end(trainingHtml());
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        trainingUrl: `http://127.0.0.1:${address.port}/training`,
        monitorUrl: `http://127.0.0.1:${address.port}/monitor`,
      });
    });
  });
}

async function startMcp(label) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/mcp-server/index.js"],
    cwd: ROOT,
    env: { ...process.env },
  });
  const client = new Client({ name: `e2e-resident-${label}`, version: "1.0.0" });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args }).then(unwrap);
  return { client, transport, call };
}

async function waitForBridge(peer, expectedProfileId = null) {
  const started = Date.now();
  while (Date.now() - started < BRIDGE_WAIT_MS) {
    for (let port = 9333; port <= 9342; port++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
        if (!response.ok) continue;
        const health = await response.json();
        const connectedProfile = health.profiles?.connected ?? null;
        if (health.pid === peer.transport.pid && health.connected
          && (!expectedProfileId || connectedProfile === expectedProfileId)) {
          return { ok: true, port, ms: Date.now() - started };
        }
      } catch { /* port is not a live Crawlio server */ }
    }
    // Every dispatch refreshes this bridge file's activity stamp without needing browser access.
    await peer.call("search", { query: "resident observation" }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return { ok: false, ms: Date.now() - started };
}

async function listLiveBridges() {
  const results = await Promise.all(Array.from({ length: 10 }, async (_, offset) => {
    const port = 9333 + offset;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) return null;
      const health = await response.json();
      return health?.service === "crawlio-mcp" && Number.isInteger(health.pid)
        ? { ...health, port }
        : null;
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function listenOnAvailableBridgePort(server, preferredPort = null) {
  const ports = preferredPort === null
    ? Array.from({ length: 10 }, (_, offset) => 9333 + offset)
    : [preferredPort];
  const deadline = Date.now() + (preferredPort === null ? 0 : 5_000);

  do {
    for (const port of ports) {
      const listening = await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          if (error?.code === "EADDRINUSE") resolve(false);
          else reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve(true);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      if (listening) return port;
    }
    if (preferredPort !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } while (preferredPort !== null && Date.now() < deadline);

  throw new Error(preferredPort === null
    ? "no free Crawlio bridge port for the E2E election quarantine"
    : `departing MCP port ${preferredPort} did not become available for the E2E election quarantine`);
}

function readDepartingBridgeIdentity(sourceBridgePid) {
  const sourceFile = join(BRIDGE_DIR, `${sourceBridgePid}.json`);
  const source = JSON.parse(readFileSync(sourceFile, "utf-8"));
  if (source?.pid !== sourceBridgePid || typeof source?.token !== "string" || !source.token) {
    throw new Error(`cannot read the departing MCP token from ${sourceFile}`);
  }
  return { token: source.token };
}

/**
 * Hold native bridge election on a test-owned endpoint with NO WebSocket command transport.
 *
 * Reusing the departing MCP's token matters: all enabled Chrome profiles already received that
 * token while MCP #1 was active, so this does not rotate their trust merely to run a test. Once
 * the real server exits, every other server fails the existing HMAC check and this endpoint rejects
 * upgrades, leaving the selected extension genuinely disconnected until stop() removes the file.
 */
async function startBridgeElectionQuarantine(source, preferredPort = null) {
  let lastActivityAt = Date.now();
  let port = null;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        service: "crawlio-mcp",
        pid: process.pid,
        port,
        connected: false,
        lastActivityAt,
        e2eQuarantine: true,
      }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  // This endpoint exists only to keep native election deterministic. It must never become a
  // bridge accidentally, even if the production client's WebSocket URL reaches it.
  server.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  port = await listenOnAvailableBridgePort(server, preferredPort);
  mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(BRIDGE_DIR, 0o700); } catch { /* best-effort parity with production */ }
  const bridgeFile = join(BRIDGE_DIR, `${process.pid}.json`);
  const publish = () => {
    lastActivityAt = Date.now();
    writeFileSync(bridgeFile, JSON.stringify({
      port,
      token: source.token,
      pid: process.pid,
      cwd: ROOT,
      startedAt: new Date().toISOString(),
      lastActivityAt,
      e2eQuarantine: true,
    }), { mode: 0o600 });
    try { chmodSync(bridgeFile, 0o600); } catch { /* best effort */ }
  };
  publish();
  const activityTimer = setInterval(publish, 500);

  return {
    port,
    async stop() {
      clearInterval(activityTimer);
      await new Promise((resolve) => server.close(resolve));
      try {
        const current = JSON.parse(readFileSync(bridgeFile, "utf-8"));
        if (current?.pid === process.pid && current?.port === port && current?.token === source.token) {
          unlinkSync(bridgeFile);
        }
      } catch { /* already removed or replaced — never delete an unverified target */ }
    },
  };
}

async function inspectE2eEnvironment(peer) {
  // Give every enabled profile one reconnect interval to identify itself. A first-wins snapshot
  // taken immediately after `connected` can miss a second profile that is about to contend.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await peer.call("search", { query: "resident observation" }).catch(() => {});

  const bridges = await listLiveBridges();
  const own = bridges.find((health) => health.pid === peer.transport.pid);
  const rivals = bridges.filter((health) => health.pid !== peer.transport.pid);
  const profiles = own?.profiles?.seen ?? [];
  const profileId = profiles[0]?.profileId;
  const bundle = readFileSync(join(ROOT, "dist/extension/background.js"), "utf-8");
  const onDisk = (/buildId:"([^"]+)"/.exec(bundle) ?? [])[1] ?? null;
  const capabilities = await peer.call("execute", {
    code: 'return await bridge.send({ type: "get_capabilities" }, 10000);',
  });

  const problems = [];
  if (!own) problems.push("the E2E server disappeared before preflight completed");
  if (profiles.length !== 1 || typeof profileId !== "string") {
    const ids = profiles.map((profile) => profile.profileId).filter(Boolean);
    problems.push(
      `${profiles.length} Chrome profiles connected to this run${ids.length ? ` (${ids.join(", ")})` : ""}; `
      + "disable Crawlio in all but the profile under test",
    );
  }
  if (!onDisk) {
    problems.push("dist/extension/background.js does not expose its build ID; rebuild before E2E");
  } else if (capabilities.buildId !== onDisk) {
    problems.push(
      `Chrome is running ${capabilities.buildId || "an extension too old to report buildId"}, `
      + `but dist/extension is ${onDisk}; reload ${join(ROOT, "dist/extension")}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`E2E preflight failed:\n- ${problems.join("\n- ")}\nRetry after correcting every item.`);
  }
  return { buildId: capabilities.buildId, profileId, otherBridgeCount: rivals.length };
}

function bridgesHoldingProfile(bridges, profileId) {
  return bridges.filter((health) => {
    if (!health.connected) return false;
    const connectedProfile = health.profiles?.connected;
    // Older servers do not report profile identity. A connected legacy bridge is ambiguous and
    // therefore cannot be treated as evidence that the profile under test is disconnected.
    return typeof connectedProfile !== "string" || connectedProfile === profileId;
  });
}

async function waitForProfileBridgeSilence(profileId, departedPid, timeoutMs = BRIDGE_SILENCE_WAIT_MS) {
  const started = Date.now();
  const requiredStableMs = MANUAL_BRIDGE_CONTROL ? 3_000 : 1_000;
  let silentSince = null;
  let bridges = await listLiveBridges();
  let holders = bridgesHoldingProfile(bridges, profileId);
  while (Date.now() - started < timeoutMs) {
    const silent = holders.length === 0 && !bridges.some((health) => health.pid === departedPid);
    if (silent) {
      silentSince ??= Date.now();
      if (Date.now() - silentSince >= requiredStableMs) break;
    } else {
      silentSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    bridges = await listLiveBridges();
    holders = bridgesHoldingProfile(bridges, profileId);
  }
  return {
    silent: holders.length === 0
      && !bridges.some((health) => health.pid === departedPid)
      && silentSince !== null
      && Date.now() - silentSince >= requiredStableMs,
    holders,
    departedStillAlive: bridges.some((health) => health.pid === departedPid),
    ms: Date.now() - started,
  };
}

async function cleanupStaleE2eObservation(peer) {
  const training = await peer.call("observe", { action: "training_status" });
  const staleRuns = (training.runs ?? []).filter((run) =>
    typeof run?.runId === "string" && run.runId.startsWith("rt_e2e_"));
  for (const run of staleRuns) {
    if (run.status === "recording") {
      await peer.call("observe", {
        action: "training_stop",
        runId: run.runId,
        fetchBodies: false,
        closeTab: true,
      });
    }
    await peer.call("observe", { action: "training_clear", runId: run.runId, confirm: true });
  }

  const monitoring = await peer.call("observe", { action: "monitor_status" });
  const staleMonitors = (monitoring.monitors ?? []).filter((monitor) =>
    typeof monitor?.monitorId === "string" && monitor.monitorId.startsWith("mon_e2e_"));
  for (const monitor of staleMonitors) {
    await peer.call("observe", {
      action: "monitor_clear",
      monitorId: monitor.monitorId,
      closeTab: true,
    });
  }

  if (staleRuns.length > 0 || staleMonitors.length > 0) {
    console.log(`cleaned ${staleRuns.length} stale E2E training run(s) and ${staleMonitors.length} monitor(s)`);
  }
}

async function cleanupOnly() {
  let peer = null;
  try {
    peer = await startMcp("cleanup-only");
    const bridge = await waitForBridge(peer);
    if (!bridge.ok) throw new Error("extension never attached to the cleanup MCP server");
    const environment = await inspectE2eEnvironment(peer);
    await cleanupStaleE2eObservation(peer);
    console.log(`E2E cleanup complete for profile ${environment.profileId}.`);
  } finally {
    await closePeer(peer);
  }
}

async function closePeer(peer) {
  if (!peer) return;
  await peer.client.close().catch(() => {});
}

function check(label, condition, detail = "") {
  console.log(`  ${condition ? green("PASS") : red("FAIL")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  if (!existsSync(join(ROOT, "dist/mcp-server/index.js")) || !existsSync(join(ROOT, "dist/extension/background.js"))) {
    console.error("Build output missing — run `npm run build` before this harness.");
    process.exitCode = 2;
    return;
  }

  const fixture = await serveFixture();
  const outputDir = mkdtempSync(join(tmpdir(), "crawlio-resident-e2e-"));
  const runId = `rt_e2e_${Date.now().toString(36)}`;
  const monitorId = `mon_e2e_${Date.now().toString(36)}`;
  let first = null;
  let second = null;
  let quarantine = null;
  let passed = false;
  let collectionStarted = false;

  console.log(`fixture: ${fixture.trainingUrl}`);
  console.log(`artifacts: ${outputDir}\n`);

  try {
    first = await startMcp("before");
    const firstBridge = await waitForBridge(first);
    if (!firstBridge.ok) throw new Error("extension never attached to the first MCP server");
    console.log(`first bridge ready in ${(firstBridge.ms / 1_000).toFixed(1)}s on port ${firstBridge.port}`);
    const environment = await inspectE2eEnvironment(first);
    console.log(
      `isolated profile ${environment.profileId} is running extension build ${environment.buildId}`
      + `${environment.otherBridgeCount ? ` (${environment.otherBridgeCount} unrelated bridge server(s) ignored)` : ""}`,
    );
    await cleanupStaleE2eObservation(first);

    const training = await first.call("observe", {
      action: "training_start",
      url: `${fixture.trainingUrl}?token=${encodeURIComponent(SECRET)}`,
      runId,
      outputDir,
      active: false,
      captureStorageValues: false,
    });
    check("training is extension-resident", training.resident !== false && training.runId === runId, JSON.stringify(training).slice(0, 120));
    collectionStarted = true;

    const monitor = await first.call("observe", {
      action: "monitor_start",
      url: fixture.monitorUrl,
      monitorId,
      intervalMinutes: 0.5,
      label: "resident-e2e",
    });
    check("monitor captured a baseline", monitor.monitor?.monitorId === monitorId && monitor.baseline?.snapshot?.includes("Monitor revision 1"));

    await new Promise((resolve) => setTimeout(resolve, 800));
    const before = await first.call("observe", { action: "training_status", runId });
    const initialEvents = before.runs?.[0]?.stateEvents ?? 0;

    let activeClearRejected = false;
    try {
      await first.call("observe", { action: "training_clear", runId, confirm: true });
    } catch (error) {
      activeClearRejected = /active|recording|stop it before clearing/i.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    check("active training cannot be cleared before stop", activeClearRejected);

    const scheduled = await first.call("execute", {
      code: `return await bridge.send({
        type: "browser_evaluate",
        expression: ${JSON.stringify(`(() => {
          setTimeout(() => {
            const username = document.querySelector("#username");
            const password = document.querySelector("#password");
            username.value = "resident-user";
            username.dispatchEvent(new Event("input", { bubbles: true }));
            password.value = ${JSON.stringify(SECRET)};
            password.dispatchEvent(new Event("input", { bubbles: true }));
            document.querySelector("#teach").click();
            fetch("/api/learn", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "learn", password: ${JSON.stringify(SECRET)} })
            }).catch(() => {});
          }, 1500);
          return { scheduled: true };
        })()`)}
      }, 10000);`,
    });
    check("post-disconnect page action scheduled", scheduled.result?.scheduled === true);

    const firstPid = first.transport.pid;
    // Capture the trusted identity while MCP #1's 0600 bridge file still exists, then reuse the
    // same port only after that process exits. This works even when all ten bridge ports are
    // occupied and avoids killing or mutating any unrelated editor-owned server.
    const quarantineSource = MANUAL_BRIDGE_CONTROL ? null : readDepartingBridgeIdentity(firstPid);
    await closePeer(first);
    first = null;
    if (quarantineSource) {
      quarantine = await startBridgeElectionQuarantine(quarantineSource, firstBridge.port);
      console.log(`election quarantine ready on departed port ${quarantine.port} (WebSocket commands refused)`);
    }
    if (MANUAL_BRIDGE_CONTROL) {
      console.log("\nACTION REQUIRED: click the Crawlio extension icon, then Disconnect. Do not reconnect until prompted.");
    }
    const silence = await waitForProfileBridgeSilence(environment.profileId, firstPid);
    check(
      "training profile has no MCP bridge after MCP #1 exits",
      silence.silent,
      silence.departedStillAlive
        ? `departed pid ${firstPid} still serves /health`
        : silence.holders.map((health) => `pid ${health.pid} @ :${health.port}`).join(", "),
    );
    console.log(`\nMCP #1 stopped; waiting ${(ALARM_WAIT_MS / 1_000).toFixed(0)}s with the training profile disconnected from every MCP bridge...`);
    const disconnectedStarted = Date.now();
    let nextProgressAt = 10_000;
    while (Date.now() - disconnectedStarted < ALARM_WAIT_MS) {
      const unexpected = bridgesHoldingProfile(await listLiveBridges(), environment.profileId);
      if (unexpected.length > 0) {
        throw new Error(
          `the training profile reconnected during the bridge-absent interval: `
          + unexpected.map((health) => `pid ${health.pid} @ :${health.port}`).join(", "),
        );
      }
      const elapsed = Date.now() - disconnectedStarted;
      if (elapsed >= nextProgressAt || elapsed >= ALARM_WAIT_MS) {
        console.log(`  ${dim(`${Math.min(Math.round(elapsed / 1_000), ALARM_WAIT_MS / 1_000)}s`)}`);
        nextProgressAt += 10_000;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(500, ALARM_WAIT_MS - elapsed))));
    }

    if (quarantine) {
      await quarantine.stop();
      quarantine = null;
    }
    second = await startMcp("after");
    if (MANUAL_BRIDGE_CONTROL) {
      console.log("\nACTION REQUIRED: click the Crawlio extension icon, then Reconnect.");
    }
    const secondBridge = await waitForBridge(second, environment.profileId);
    if (!secondBridge.ok) throw new Error("extension never attached to the replacement MCP server");
    console.log(`replacement bridge ready in ${(secondBridge.ms / 1_000).toFixed(1)}s on port ${secondBridge.port}\n`);
    const replacementEnvironment = await inspectE2eEnvironment(second);
    check("replacement MCP reached the same Chrome profile", replacementEnvironment.profileId === environment.profileId);

    const after = await second.call("observe", { action: "training_status", runId });
    const retainedRun = after.runs?.[0];
    check("same training run survived MCP restart", retainedRun?.runId === runId && retainedRun?.status === "recording");
    check("extension captured events while MCP was absent", (retainedRun?.stateEvents ?? 0) > initialEvents, `${initialEvents} -> ${retainedRun?.stateEvents ?? 0}`);

    const monitorResults = await second.call("observe", {
      action: "monitor_results",
      monitorId,
      limit: 10,
      includeSnapshot: true,
    });
    check("Chrome alarm captured another monitor snapshot", (monitorResults.snapshots?.length ?? 0) >= 2, `${monitorResults.snapshots?.length ?? 0} snapshots`);
    check("resident diff reports the fixture change", monitorResults.snapshots?.some((snapshot) => snapshot.changed && /Monitor revision/.test(snapshot.diff)) === true);

    const stopped = await second.call("observe", {
      action: "training_stop",
      runId,
      fetchBodies: true,
      closeTab: true,
    });
    check("replacement MCP materialized the retained run", stopped.runId === runId && stopped.status === "stopped");

    const names = new Set(readdirSync(outputDir));
    const missing = REQUIRED_ARTIFACTS.filter((name) => !names.has(name));
    check("all canonical artifacts exist", missing.length === 0, missing.join(", "));

    const artifactText = REQUIRED_ARTIFACTS
      .map((name) => readFileSync(join(outputDir, name), "utf-8"))
      .join("\n");
    check("password/request/response secrets are absent from disk",
      !artifactText.includes(SECRET)
      && !artifactText.includes("fixture-token-must-not-leak")
      && !artifactText.includes("response-secret-must-not-leak"));
    check("redaction is represented explicitly", artifactText.includes("[REDACTED]") || artifactText.includes("%5BREDACTED%5D"));

    const openapi = JSON.parse(readFileSync(join(outputDir, "api.openapi.yaml"), "utf-8"));
    check("OpenAPI draft contains the learned endpoint", Boolean(openapi.paths?.["/api/learn"]?.post));

    await second.call("observe", { action: "monitor_clear", monitorId, closeTab: true });
    const clearedTraining = await second.call("observe", { action: "training_clear", runId, confirm: true });
    check("confirmed MCP clear removed only the retained training record",
      clearedTraining.cleared === runId && clearedTraining.artifactsPreserved === true);
    check("confirmed clear preserves materialized artifact files",
      existsSync(join(outputDir, "manifest.json")) && existsSync(join(outputDir, "recording.json")));
    const afterClear = await second.call("observe", { action: "training_status", runId });
    check("cleared training record is no longer retained", (afterClear.runs?.length ?? 0) === 0);
    passed = true;
    console.log(`\n${green("Resident observation E2E passed.")}`);
  } finally {
    const cleanup = second ?? first;
    if (cleanup) {
      await cleanup.call("observe", { action: "training_stop", runId, fetchBodies: false, closeTab: true }).catch(() => {});
      await cleanup.call("observe", { action: "training_clear", runId, confirm: true }).catch(() => {});
      await cleanup.call("observe", { action: "monitor_clear", monitorId, closeTab: true }).catch(() => {});
    }
    await closePeer(first);
    await closePeer(second);
    if (quarantine) await quarantine.stop().catch(() => {});
    await new Promise((resolve) => fixture.server.close(resolve));
    if (passed || !collectionStarted) rmSync(outputDir, { recursive: true, force: true });
    else console.error(`\nArtifacts retained for diagnosis: ${outputDir}`);
  }
}

const entrypoint = process.argv.includes("--cleanup-only") ? cleanupOnly : main;

entrypoint().catch((error) => {
  console.error(`\n${red("Resident observation E2E failed:")} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = /stale|reload|never attached|build output|preflight/i.test(String(error)) ? 2 : 1;
});
