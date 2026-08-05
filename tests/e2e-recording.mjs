#!/usr/bin/env node
/**
 * E2E Recording Pipeline Test
 *
 * Tests the full stack: MCP stdio → execute tool → bridge → Chrome extension → CDP → recording state machine → compiler
 * Run: node tests/e2e-recording.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BRIDGE_WAIT_MS = 45_000;
const BRIDGE_POLL_MS = 2_000;

let client;
let transport;
let step = 0;
let passed = 0;
let failed = 0;
let bridgePort = null;

// --- Helpers ---

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

async function runStep(name, fn) {
  step++;
  console.log(`\n--- Step ${step}: ${name} ---`);
  try {
    await fn();
    passed++;
    log("\x1b[32mPASS\x1b[0m", name);
  } catch (e) {
    failed++;
    log("\x1b[31mFAIL\x1b[0m", `${name}: ${e.message}`);
  }
}

/** Call an MCP tool and return parsed text content */
async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const errText = result.content?.map(c => c.text).join("\n") || "Unknown error";
    throw new Error(errText);
  }
  const text = result.content?.find(c => c.type === "text")?.text;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

/** Call the execute tool with code that runs in the smart.* sandbox */
async function execute(code) {
  return callTool("execute", { code });
}

/** Wait for the MCP server's bridge to have an extension connection */
async function waitForBridge() {
  const start = Date.now();
  while (Date.now() - start < BRIDGE_WAIT_MS) {
    for (let port = 9333; port <= 9342; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const health = await res.json();
          if (health.connected && health.pid === transport.serverProcess?.pid) {
            bridgePort = port;
            return true;
          }
        }
      } catch { /* port not listening */ }
    }
    log("  ", `Waiting for extension to connect to bridge... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise(r => setTimeout(r, BRIDGE_POLL_MS));
  }
  return false;
}

// --- Main ---

async function main() {
  console.log("=== E2E Recording Pipeline Test (MCP stdio) ===\n");

  // 1. Spawn MCP server via stdio
  console.log("Spawning MCP server (stdio mode)...");
  transport = new StdioClientTransport({
    command: "node",
    args: ["dist/mcp-server/index.js"],
    env: { ...process.env },
  });

  client = new Client({ name: "e2e-recording", version: "1.0.0" });
  await client.connect(transport);
  log("\x1b[32mOK\x1b[0m", "MCP client connected (stdio)");

  // 2. Wait for extension to discover and connect to the new bridge
  console.log("\nWaiting for extension to connect to bridge...");
  const bridgeReady = await waitForBridge();
  if (!bridgeReady) {
    log("\x1b[33mWARN\x1b[0m", "Could not confirm bridge connection by PID — proceeding anyway");
  } else {
    log("\x1b[32mOK\x1b[0m", `Bridge connected on port ${bridgePort}`);
  }

  // --- Test Steps ---

  // Step 1: Connect to test page
  await runStep("Connect to example.com", async () => {
    const result = await callTool("connect_tab", { url: "https://example.com" });
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    assert(result.tabId || result.connected, "tab connected");
  });

  // Step 2: Start recording
  let sessionId;
  await runStep("Start recording", async () => {
    const result = await execute(`
      const r = await bridge.send({ type: "start_recording", maxDurationSec: 120, maxInteractions: 50 }, 10000);
      return r;
    `);
    log("  ", JSON.stringify(result).slice(0, 200));
    sessionId = result?.sessionId ?? result?.result?.sessionId;
    assert(sessionId, "sessionId returned");
  });

  // Step 3: Check recording status (initial)
  await runStep("Recording status (initial)", async () => {
    const status = await callTool("get_recording_status");
    log("  ", `active=${status.active}, pages=${status.pageCount}, interactions=${status.interactionCount}`);
    assert(status.active === true, "still active");
    assert(status.sessionId === sessionId, "sessionId matches");
    assert(status.pageCount >= 1, "at least 1 page");
    assert(status.interactionCount === 0, "0 interactions initially");
  });

  // Step 4: Navigate to httpbin form
  await runStep("Navigate to httpbin.org/forms/post", async () => {
    await execute(`
      await smart.navigate("https://httpbin.org/forms/post");
      await sleep(2000);
    `);
  });

  // Step 5: Type into form field
  await runStep("Type into custname field", async () => {
    await execute(`
      await smart.type('input[name="custname"]', "Crawlio Test User");
    `);
  });

  // Step 6: Click a checkbox
  await runStep("Click cheese topping", async () => {
    await execute(`
      await smart.click('input[name="topping"][value="cheese"]');
    `);
  });

  // Step 7: Evaluate JS (recorded interaction)
  await runStep("Evaluate document.title", async () => {
    const result = await execute(`
      const title = await smart.evaluate("document.title");
      return title;
    `);
    log("  ", `title: ${JSON.stringify(result).slice(0, 200)}`);
  });

  // Step 8: Check recording status (mid-recording)
  await runStep("Recording status (mid-recording)", async () => {
    const status = await callTool("get_recording_status");
    log("  ", `active=${status.active}, pages=${status.pageCount}, interactions=${status.interactionCount}`);
    assert(status.active === true, "still active");
    assert(status.interactionCount >= 3, `interactions >= 3 (got ${status.interactionCount})`);
    assert(status.pageCount >= 2, `pages >= 2 (got ${status.pageCount})`);
  });

  // Step 9: Stop recording and get session
  let session;
  await runStep("Stop recording", async () => {
    session = await execute(`
      const s = await bridge.send({ type: "stop_recording" }, 10000);
      return s;
    `);
    log("  ", `id=${session?.id}`);
    log("  ", `duration=${session?.duration}ms`);
    log("  ", `pages=${session?.pages?.length}`);
    log("  ", `stopReason=${session?.metadata?.stopReason}`);

    assert(session?.id, "session.id exists");
    assert(session?.stoppedAt, "stoppedAt exists");
    assert(session?.duration > 0, `duration > 0 (got ${session?.duration})`);
    assert(session?.pages?.length === 2, `2 pages (got ${session?.pages?.length})`);
    assert(session?.metadata?.stopReason === "manual", `stopReason is manual`);
  });

  // Step 10: Compile recording via execute sandbox
  await runStep("Compile recording via compileRecording()", async () => {
    // Pass the session JSON back into execute sandbox for compilation
    const compiled = await execute(`
      const session = ${JSON.stringify(session)};
      const result = compileRecording(session, {
        name: "e2e-test-recording",
        description: "Live E2E test of recording pipeline"
      });
      return {
        name: result.name,
        pageCount: result.pageCount,
        interactionCount: result.interactionCount,
        mdLength: result.skillMarkdown.length,
        hasSmartNavigate: result.skillMarkdown.includes("smart.navigate"),
        hasSmartType: result.skillMarkdown.includes("smart.type"),
        hasSmartClick: result.skillMarkdown.includes("smart.click"),
        hasFrontmatter: result.skillMarkdown.startsWith("---"),
        hasPrerequisites: result.skillMarkdown.includes("## Prerequisites"),
      };
    `);

    log("  ", `name=${compiled?.name}`);
    log("  ", `pageCount=${compiled?.pageCount}`);
    log("  ", `interactionCount=${compiled?.interactionCount}`);
    log("  ", `mdLength=${compiled?.mdLength}`);

    assert(compiled?.name === "e2e-test-recording", "name matches");
    assert(compiled?.pageCount === 2, `pageCount === 2 (got ${compiled?.pageCount})`);
    assert(compiled?.interactionCount >= 3, `interactionCount >= 3 (got ${compiled?.interactionCount})`);
    assert(compiled?.hasSmartNavigate, "skillMd has smart.navigate");
    assert(compiled?.hasSmartType, "skillMd has smart.type");
    assert(compiled?.hasSmartClick, "skillMd has smart.click");
    assert(compiled?.hasFrontmatter, "skillMd starts with frontmatter");
    assert(compiled?.hasPrerequisites, "skillMd has Prerequisites section");
  });

  // Step 11: Edge case — stop when not recording
  await runStep("Edge case: stop when not recording", async () => {
    try {
      await execute(`return await bridge.send({ type: "stop_recording" }, 5000);`);
      log("  ", "Got result (no crash)");
    } catch (e) {
      log("  ", `Got expected error (no crash): ${e.message.slice(0, 100)}`);
    }
  });

  // Step 12: Edge case — double start
  await runStep("Edge case: double start", async () => {
    const first = await execute(`return await bridge.send({ type: "start_recording", maxDurationSec: 30 }, 10000);`);
    log("  ", `first start: sessionId=${first?.sessionId}, active=${first?.active}`);
    assert(first?.active === true || first?.sessionId, "first start has session");

    const second = await execute(`return await bridge.send({ type: "start_recording", maxDurationSec: 30 }, 10000);`);
    log("  ", `second start: sessionId=${second?.sessionId}`);
    assert(second?.sessionId, "second start returns sessionId");

    // Clean up
    await execute(`return await bridge.send({ type: "stop_recording" }, 5000);`);
    log("  ", "Cleaned up (stopped recording)");
  });

  // --- Summary ---
  console.log("\n=== Results ===");
  console.log(`  Total: ${step}  Passed: \x1b[32m${passed}\x1b[0m  Failed: \x1b[31m${failed}\x1b[0m`);

  await client.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`\x1b[31mFATAL: ${e.message}\x1b[0m`);
  try { await client?.close(); } catch { /* already exiting on a fatal error */ }
  process.exit(1);
});
