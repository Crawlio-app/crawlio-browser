#!/usr/bin/env node
// Consistency gate for every number this project advertises.
//
// The README once carried four different tool counts at the same time, claimed 8 higher-order
// methods in three places and 17 in a fourth, said the detector knew 17 frameworks on one line
// and 64 on another, and quoted a token reduction that nothing measured. None of that was
// dishonesty — it was arithmetic maintained by hand across 900 lines.
//
// So the numbers are marked in the prose and checked against the server:
//
//     ... collapses <!--n:full-->145<!--/n--> tools ...
//
// Truth comes from `crawlio-browser tools --json`, which reads the same builders the server
// registers, so a marker cannot disagree with what a client receives.
//
//   node scripts/check-surface.mjs          # verify (CI)
//   node scripts/check-surface.mjs --fix    # rewrite markers to the measured values

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const SERVER = join(ROOT, "dist/mcp-server/index.js");
const SKILLS = join(ROOT, "skills");
const DETECTOR = join(ROOT, "src/extension/injected/framework-detector.ts");
const FIX = process.argv.includes("--fix");

// A bare integer in README prose that looks like it is describing the tool surface but is not
// inside a marker. Catches a new claim added without a guard, which is how the last set drifted.
const SUSPICIOUS = /\b(\d{2,3})\s+(?:individual\s+)?(?:tools|commands|methods|frameworks|namespaces)\b/gi;

function die(lines) {
  console.error(`\nSurface check FAILED — ${lines.length} problem(s):\n`);
  for (const l of lines) console.error(`  ✗ ${l}`);
  console.error("\n  The numbers live in the code, not the prose. Re-run with --fix to sync,");
  console.error("  or correct the claim if the surface genuinely changed.\n");
  process.exit(1);
}

/** Ask the built server what it exposes, over the same JSON-RPC a client uses. */
function listTools(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`timed out asking the server for tools/list ${args.join(" ")}`));
    }, 30000);
    p.on("error", reject);
    p.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          p.kill();
          resolve(msg.result.tools);
        }
      }
    });
    p.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-surface", version: "0" } },
    })}\n`);
  });
}

function runToolsJson() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER, "tools", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.on("error", reject);
    p.stdout.on("data", (c) => { out += c.toString(); });
    // Keep stderr: when the server fails to start, its stack trace is the only useful thing
    // here, and discarding it turns a one-line diagnosis into a CI archaeology session.
    p.stderr.on("data", (c) => { err += c.toString(); });
    p.on("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        const detail = err.trim() || `no output, exit code ${code}`;
        reject(new Error(`\`tools --json\` did not return JSON.\n\n${detail}`));
      }
    });
  });
}

/**
 * `--version` must answer and exit, not start a server.
 *
 * It used to fall through to the transport setup, so asking the CLI its version started a stdio
 * MCP server and bound a WebSocket port, leaving a process the user had to notice and kill. A
 * short timeout is the assertion: a server that starts instead of answering will hang here.
 */
function checkVersionFlagExits(expected) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      p.kill();
      resolve(`\`--version\` did not exit within 10s — it is starting the server instead of answering`);
    }, 10000);
    p.stdout.on("data", (c) => { out += c.toString(); });
    p.on("error", (e) => { clearTimeout(timer); resolve(`\`--version\` failed to run: ${e.message}`); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const printed = out.trim();
      if (code !== 0) return resolve(`\`--version\` exited ${code}, expected 0`);
      if (printed !== expected) return resolve(`\`--version\` printed "${printed}", expected "${expected}"`);
      resolve(null);
    });
  });
}

/**
 * The detector runs inside the page and cannot be executed here, so its vocabulary is read
 * from source. Deduplicated because several checks push the same framework by different means.
 */
function frameworkCount() {
  const src = readFileSync(DETECTOR, "utf-8");
  const names = new Set();
  for (const m of src.matchAll(/detections\.push\(\s*\{\s*name:\s*"([^"]+)"/g)) names.add(m[1]);
  return names.size;
}

async function main() {
  if (!existsSync(SERVER)) {
    die([`${SERVER} is missing — run \`npm run build:server\` before checking the surface`]);
  }

  const surface = await runToolsJson();
  const [fullTools, codeTools] = [await listTools(["--full"]), await listTools([])];

  // Measured the way a client pays for it: the serialized tools/list result, not a tool ratio.
  const fullBytes = JSON.stringify(fullTools).length;
  const codeBytes = JSON.stringify(codeTools).length;
  const reduction = Math.round((1 - codeBytes / fullBytes) * 100);

  const truth = {
    full: surface.full.length,
    code: surface.code.length,
    catalog: surface.catalog.total,
    http: surface.catalog.crawlioHttp,
    core: surface.smart.core.length,
    higher: surface.smart.higherOrder.length,
    ns: surface.smart.namespaces.length,
    frameworks: frameworkCount(),
    reduction,
  };

  // What tools/list reports must equal what the surface description claims, or the description
  // is measuring something the client never sees.
  const failures = [];
  if (fullTools.length !== truth.full) {
    failures.push(`tools/list --full returns ${fullTools.length} but describeSurface reports ${truth.full}`);
  }
  if (codeTools.length !== truth.code) {
    failures.push(`tools/list returns ${codeTools.length} but describeSurface reports ${truth.code}`);
  }

  let text = readFileSync(README, "utf-8");
  const original = text;
  const seen = new Set();

  for (const [key, value] of Object.entries(truth)) {
    const marker = new RegExp(`<!--n:${key}-->(.*?)<!--/n-->`, "g");
    let found = 0;
    text = text.replace(marker, (whole, current) => {
      found += 1;
      if (String(current) === String(value)) return whole;
      if (FIX) return `<!--n:${key}-->${value}<!--/n-->`;
      failures.push(`README marker n:${key} says ${current}, measured ${value}`);
      return whole;
    });
    if (found > 0) seen.add(key);
  }

  // A marked number nobody uses is dead weight; an unmarked claim is the failure mode this
  // whole mechanism exists to prevent.
  for (const [key] of Object.entries(truth)) {
    if (!seen.has(key) && key !== "http") {
      failures.push(`no README marker uses n:${key} — the value is measured but never quoted`);
    }
  }

  // Fenced blocks are exempt: an HTML comment inside one renders as literal text, so a number
  // there cannot be marked. Keep counts out of examples rather than marking them.
  const prose = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
  const known = new Set(Object.values(truth).map(String));

  for (const m of prose.matchAll(SUSPICIOUS)) {
    const at = m.index ?? 0;
    const before = prose.slice(Math.max(0, at - 80), at);
    if (before.includes("<!--n:") && !before.includes("<!--/n-->")) continue;
    if (!known.has(m[1])) continue;
    failures.push(`"${m[0].trim()}" states a surface number outside a marker — wrap it in <!--n:…--> so it stays checked`);
  }

  // The npm page and the MCP registry listing both quote the tool count in prose that no
  // marker can reach, so check them directly. The registry also caps descriptions at 100
  // characters and rejects the whole submission over it — which is a poor time to find out.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf-8"));

  if (server.description.length > 100) {
    failures.push(`server.json description is ${server.description.length} chars; the MCP registry rejects anything over 100`);
  }
  // The registry proves you own the npm package by reading `mcpName` back off the PUBLISHED
  // package and comparing it to the server name. A tarball published without it can never be
  // listed, and npm tarballs are immutable — the only fix is another release.
  if (pkg.mcpName !== server.name) {
    failures.push(`package.json mcpName is ${pkg.mcpName ?? "absent"}, but server.json name is ${server.name} — the registry checks the published package for this and rejects a mismatch`);
  }

  const versionFlag = await checkVersionFlagExits(pkg.version);
  if (versionFlag) failures.push(versionFlag);

  // A skill's `allowed-tools` names tools by the client's config key. init writes
  // `crawlio-browser`, so a grant under the retired `mcp__crawlio-agent__` prefix names a tool
  // that does not exist — the skill loads, looks correct, and silently has no permission. That
  // shipped for several releases in robot-training.
  for (const rel of readdirSync(SKILLS, { recursive: true })) {
    if (typeof rel !== "string" || !rel.endsWith(".md")) continue;
    const body = readFileSync(join(SKILLS, rel), "utf-8");
    const dead = body.match(/mcp__crawlio-agent__[a-z_]+/g);
    if (dead) {
      const unique = [...new Set(dead)];
      failures.push(`skills/${rel} grants ${unique.length} tool(s) under the retired mcp__crawlio-agent__ prefix (e.g. ${unique[0]}) — init writes the crawlio-browser key, so these grant nothing`);
    }
  }
  for (const [label, description] of [["package.json", pkg.description], ["server.json", server.description]]) {
    const claimed = /(\d{2,3})\s+CDP/.exec(description);
    if (claimed && Number(claimed[1]) !== truth.full) {
      failures.push(`${label} description claims ${claimed[1]} CDP tools, measured ${truth.full}`);
    }
  }

  if (FIX && text !== original) {
    writeFileSync(README, text);
    console.log("README markers rewritten to the measured values.");
  }

  if (failures.length) die(failures);

  const summary = Object.entries(truth).map(([k, v]) => `${k}=${v}`).join(" · ");
  console.log(`Surface check passed — ${summary}`);
}

main().catch((err) => {
  console.error(`\nSurface check ERRORED: ${err.message}\n`);
  process.exit(2);
});
