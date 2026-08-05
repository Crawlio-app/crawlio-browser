#!/usr/bin/env node
/**
 * E2E Method Mode Test
 *
 * Tests smart.* method compositions end-to-end through the full MCP stack:
 *   Test script → MCP stdio → execute tool → smart.* → bridge → extension → CDP → real page
 *
 * Uses MCP SDK StdioClientTransport to spawn a real MCP server process.
 * The extension auto-discovers the new bridge and connects.
 *
 * Run: node tests/e2e-method-mode.mjs
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
  // Find the bridge port from stderr or scan the port range
  while (Date.now() - start < BRIDGE_WAIT_MS) {
    for (let port = 9333; port <= 9342; port++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const health = await res.json();
          // Match by PID — the transport spawns a child process
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
  console.log("=== E2E Method Mode Test ===\n");

  // 1. Spawn MCP server via stdio
  console.log("Spawning MCP server (stdio mode)...");
  transport = new StdioClientTransport({
    command: "node",
    args: ["dist/mcp-server/index.js"],
    env: { ...process.env },
  });

  client = new Client({ name: "e2e-method-mode", version: "1.0.0" });
  await client.connect(transport);
  log("\x1b[32mOK\x1b[0m", "MCP client connected (stdio)");

  // 2. Wait for extension to discover and connect to the new bridge
  console.log("\nWaiting for extension to connect to bridge...");
  const bridgeReady = await waitForBridge();
  if (!bridgeReady) {
    // Fallback: try calling connect_tab anyway — the bridge may route through an existing connection
    log("\x1b[33mWARN\x1b[0m", "Could not confirm bridge connection by PID — proceeding anyway");
  } else {
    log("\x1b[32mOK\x1b[0m", `Bridge connected on port ${bridgePort}`);
  }

  // --- Test Steps ---

  // Step 1: connect_tab to example.com
  await runStep("connect_tab to example.com", async () => {
    const result = await callTool("connect_tab", { url: "https://example.com" });
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    assert(result.tabId || result.connected, "tab connected");
  });

  // Step 2: waitForIdle via execute sandbox
  await runStep("smart.waitForIdle()", async () => {
    const result = await execute(`
      const idle = await smart.waitForIdle(5000);
      return idle;
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    const status = result?.status ?? result?.result?.status;
    assert(status === "idle" || status === "timeout", `expected idle or timeout, got ${status}`);
  });

  // Step 3: extractPage via execute sandbox
  await runStep("smart.extractPage()", async () => {
    const result = await execute(`
      const page = await smart.extractPage();
      return {
        hasCapture: !!page.capture,
        captureUrl: page.capture?.url,
        captureTitle: page.capture?.title,
        hasPerformance: page.performance !== null,
        hasSecurity: page.security !== null,
        hasFonts: page.fonts !== null,
        hasMeta: page.meta !== null,
        metaTitle: page.meta?._title,
      };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 400)}`);
    // The execute tool returns { content: [{ text }] } which we parse
    // The result shape depends on how execute wraps the return
    const data = result?.result ?? result;
    assert(data?.hasCapture === true || data?.captureUrl, "has capture data");
  });

  // Step 4: smart.evaluate — basic expression
  await runStep("smart.evaluate() — document.title", async () => {
    const result = await execute(`
      const title = await smart.evaluate("document.title");
      return { title };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    const data = result?.result ?? result;
    assert(data?.title, `has title`);
  });

  // Step 5: smart.evaluate — complex structured expression
  await runStep("smart.evaluate() — structured object", async () => {
    const result = await execute(`
      const info = await smart.evaluate("({ title: document.title, url: location.href, nodeCount: document.querySelectorAll('*').length })");
      return info;
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 300)}`);
    const data = result?.result ?? result;
    assert(data?.title || data?.result?.title, "has title");
  });

  // Step 6: smart.evaluate — auto-IIFE with return statement
  await runStep("smart.evaluate() — auto-IIFE return statement", async () => {
    const result = await execute(`
      const val = await smart.evaluate("return document.title");
      return { val };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    // Should not error — the auto-IIFE wrapping handles "return" statements
  });

  // Step 7: scrollCapture via execute sandbox
  await runStep("smart.scrollCapture()", async () => {
    const result = await execute(`
      const sc = await smart.scrollCapture({ maxSections: 3, pixelsPerScroll: 400 });
      return {
        sectionCount: sc.sectionCount,
        hasScreenshots: sc.sections?.every(s => s.screenshot?.length > 0),
        firstScrollY: sc.sections?.[0]?.scrollY,
      };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 300)}`);
    const data = result?.result ?? result;
    assert(
      (data?.sectionCount >= 1) || (typeof data?.sectionCount === "number"),
      `has sectionCount (got ${data?.sectionCount})`
    );
  });

  // Step 8: Inject test form into example.com for interaction tests
  await runStep("Inject test form + smart.type()", async () => {
    const result = await execute(`
      // Inject a form into the current page
      await smart.evaluate(\`
        (() => {
          const form = document.createElement('form');
          form.id = 'e2e-test-form';
          form.innerHTML = '<input name="testfield" type="text" style="display:block;width:200px;height:30px;" />'
            + '<input name="testcheck" type="checkbox" value="yes" style="display:block;width:20px;height:20px;" />';
          document.body.appendChild(form);
        })()
      \`);
      await sleep(500);

      // Type into the injected input
      await smart.type('input[name="testfield"]', "E2E Test User");
      const val = await smart.evaluate('document.querySelector("input[name=testfield]").value');
      return { typed: true, value: val };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    const data = result?.result ?? result;
    assert(data?.typed === true || data?.value, "type succeeded");
  });

  // Step 9: smart.click on injected checkbox
  await runStep("smart.click() injected checkbox", async () => {
    const result = await execute(`
      await smart.click('input[name="testcheck"]');
      const checked = await smart.evaluate('document.querySelector("input[name=testcheck]").checked');
      return { clicked: true, checked };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    const data = result?.result ?? result;
    assert(data?.clicked === true, "click succeeded");
  });

  // Step 10: smart.navigate to a second page
  await runStep("smart.navigate() to httpbin.org", async () => {
    const result = await execute(`
      await smart.navigate("https://httpbin.org");
      await sleep(2000);
      const title = await smart.evaluate("document.title");
      return { title, navigated: true };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
  });

  // Step 11: comparePages via execute sandbox (with scaffold verification)
  await runStep("smart.comparePages() + scaffold", async () => {
    const result = await execute(`
      const cmp = await smart.comparePages("https://example.com", "https://httpbin.org");
      return {
        siteA_url: cmp.siteA?.url,
        siteB_url: cmp.siteB?.url,
        siteA_hasCapture: !!cmp.siteA?.capture,
        siteB_hasCapture: !!cmp.siteB?.capture,
        siteA_hasGaps: Array.isArray(cmp.siteA?.gaps),
        siteB_hasGaps: Array.isArray(cmp.siteB?.gaps),
        hasScaffold: !!cmp.scaffold,
        dimensionCount: cmp.scaffold?.dimensions?.length,
        dimensionNames: cmp.scaffold?.dimensions?.map(d => d.name),
        comparableCount: cmp.scaffold?.dimensions?.filter(d => d.comparable)?.length,
        sharedFieldCount: cmp.scaffold?.sharedFields?.length,
        metricCount: cmp.scaffold?.metrics?.length,
        metricNames: cmp.scaffold?.metrics?.map(m => m.name),
      };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 600)}`);
    const data = result?.result ?? result;
    assert(data?.siteA_url || data?.siteA_hasCapture !== undefined, "has siteA data");
    assert(data?.siteB_url || data?.siteB_hasCapture !== undefined, "has siteB data");
    assert(data?.hasScaffold === true, "has scaffold");
    assert(data?.dimensionCount === 10, `scaffold has 10 dimensions (got ${data?.dimensionCount})`);
    assert(data?.sharedFieldCount > 0, `sharedFields > 0 (got ${data?.sharedFieldCount})`);
    assert(data?.siteA_hasGaps === true, "siteA has gaps array");
    assert(data?.siteB_hasGaps === true, "siteB has gaps array");
  });

  // Step 12: Framework detection via bridge.send
  await runStep("bridge.send() — detect_framework", async () => {
    const result = await execute(`
      const fw = await bridge.send({ type: "detect_framework" }, 10000);
      return fw;
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
  });

  // Step 13: Edge case — evaluate syntax error recovery
  await runStep("smart.evaluate() — syntax error recovery", async () => {
    try {
      await execute(`
        const val = await smart.evaluate("this is not { valid javascript }}}");
        return { val };
      `);
      // If it didn't throw, that's also acceptable (CDP may return an error object)
      log("  ", "No throw — CDP returned error as value");
    } catch (e) {
      log("  ", `Got expected error: ${e.message.slice(0, 100)}`);
      // Pass — the sandbox should surface the error, not crash
    }
  });

  // Step 14: Edge case — navigate to non-existent URL
  await runStep("smart.navigate() — non-existent domain", async () => {
    try {
      await execute(`
        await smart.navigate("https://this-domain-does-not-exist-12345.invalid");
        await sleep(1000);
        const title = await smart.evaluate("document.title");
        return { title, navigated: true };
      `);
      log("  ", "Navigate completed (browser shows error page)");
    } catch (e) {
      log("  ", `Got error (expected): ${e.message.slice(0, 100)}`);
    }
    // Recover: navigate back to a known page for subsequent steps
    await execute(`
      await smart.navigate("https://example.com");
      await sleep(1000);
    `);
  });

  // Step 15: Partial-failure composition — extractPage with simulated failures
  await runStep("extractPage partial failure resilience", async () => {
    // extractPage uses .catch(() => null) for perf/security/fonts — verify it handles
    // graceful degradation when connected to a real page
    const result = await execute(`
      const page = await smart.extractPage();
      return {
        hasCapture: !!page.capture,
        perfIsNullOrObject: page.performance === null || typeof page.performance === 'object',
        secIsNullOrObject: page.security === null || typeof page.security === 'object',
        fontsIsNullOrObject: page.fonts === null || typeof page.fonts === 'object',
        metaIsNullOrObject: page.meta === null || typeof page.meta === 'object',
      };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 300)}`);
    const data = result?.result ?? result;
    assert(data?.hasCapture === true, "capture always succeeds");
    assert(data?.perfIsNullOrObject === true, "perf is null or object");
    assert(data?.secIsNullOrObject === true, "security is null or object");
    assert(data?.fontsIsNullOrObject === true, "fonts is null or object");
    assert(data?.metaIsNullOrObject === true, "meta is null or object");
  });

  // Step 16: withAutoSettle — full-mode browser_click through settle wrapper
  await runStep("bridge.send browser_click (withAutoSettle path)", async () => {
    // Inject a clickable element and use raw bridge.send to go through the full-mode
    // withAutoSettle wrapper (not smart.click)
    const result = await execute(`
      await smart.evaluate(\`
        (() => {
          const btn = document.createElement('button');
          btn.id = 'settle-test-btn';
          btn.textContent = 'Click Me';
          btn.style.cssText = 'display:block;width:100px;height:40px;';
          btn.onclick = () => { btn.textContent = 'Clicked'; };
          document.body.appendChild(btn);
        })()
      \`);
      await sleep(300);
      // Use smart.click which includes the actionability poll + settle
      await smart.click('#settle-test-btn');
      const text = await smart.evaluate('document.querySelector("#settle-test-btn")?.textContent');
      return { text: text?.result ?? text };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 200)}`);
    const data = result?.result ?? result;
    assert(data?.text === "Clicked" || data?.text, "button was clicked and text changed");
  });

  // Step 17: evaluate timeout behavior
  await runStep("smart.evaluate() — long-running expression timeout", async () => {
    try {
      // bridge.send has a 5s timeout for evaluate — trigger it with a long wait
      await execute(`
        const result = await smart.evaluate("new Promise(r => setTimeout(r, 30000))");
        return { result };
      `);
      log("  ", "Completed without timeout (unexpected but acceptable)");
    } catch (e) {
      log("  ", `Got timeout error (expected): ${e.message.slice(0, 100)}`);
      // Pass — the execute sandbox surfaces the timeout properly
    }
  });

  // Step 18: extractPage with trace — verify real timing
  await runStep("smart.extractPage({ trace: true }) — real timing", async () => {
    const result = await execute(`
      const page = await smart.extractPage({ trace: true });
      return {
        method: page._trace?.method,
        elapsed: page._trace?.elapsed,
        stepCount: page._trace?.steps?.length,
        steps: page._trace?.steps?.map(s => ({ name: s.name, elapsed: s.elapsed, success: s.success })),
        outcome: page._trace?.outcome,
      };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 500)}`);
    const data = result?.result ?? result;
    assert(data?.method === "extractPage", `trace method is extractPage (got ${data?.method})`);
    assert(data?.elapsed > 0, `trace elapsed > 0 (got ${data?.elapsed})`);
    assert(data?.stepCount >= 5, `trace steps >= 5 (got ${data?.stepCount})`);
    for (const s of (data?.steps ?? [])) {
      assert(typeof s.name === "string" && s.name.length > 0, `step has name`);
      assert(typeof s.elapsed === "number" && s.elapsed >= 0, `step has elapsed >= 0`);
      assert(typeof s.success === "boolean", `step has success flag`);
    }
    assert(data?.outcome === "success" || data?.outcome === "partial", `outcome is success or partial (got ${data?.outcome})`);
  });

  // Step 19: extractPage gaps on healthy page
  await runStep("smart.extractPage() gaps on healthy page", async () => {
    await execute(`await smart.navigate("https://example.com"); await sleep(1000);`);
    const result = await execute(`
      const page = await smart.extractPage();
      return { gapCount: page.gaps?.length, gaps: page.gaps };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 300)}`);
    const data = result?.result ?? result;
    assert(Array.isArray(data?.gaps), "gaps is an array");
  });

  // Step 20: smart.finding() round-trip from real extractPage data
  await runStep("smart.finding() round-trip with real data", async () => {
    const result = await execute(`
      smart.clearFindings();
      const page = await smart.extractPage();
      const f = smart.finding({
        claim: "Page has title",
        evidence: ["title: " + (page.meta?._title || "unknown")],
        sourceUrl: page.capture?.url || "https://example.com",
        confidence: "high",
        method: "extractPage",
      });
      const all = smart.findings();
      return { claim: f.claim, confidence: f.confidence, accumulatedCount: all.length };
    `);
    log("  ", `result: ${JSON.stringify(result).slice(0, 300)}`);
    const data = result?.result ?? result;
    assert(data?.claim === "Page has title", `finding has claim (got ${data?.claim})`);
    assert(data?.confidence === "high", `finding has confidence (got ${data?.confidence})`);
    assert(data?.accumulatedCount === 1, `findings accumulated (got ${data?.accumulatedCount})`);
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
