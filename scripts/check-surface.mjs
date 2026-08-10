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
const DETECTOR = join(ROOT, "src/extension/injected/framework-detector.ts");
const FIX = process.argv.includes("--fix");

// Every root that holds skills or agent definitions. Repo-local agents are scanned for dead tool
// names even though they are intentionally excluded from the npm product surface.
const PROSE_ROOTS = ["skills", ".claude/skills", ".agents/skills", "agents", ".claude/agents"];

// `search` returning one capability twice under two descriptions is a surface bug, and it makes
// the advertised catalog size exceed the number of distinct things. `get_crawl_status` was the one
// instance: an MCP tool and a Crawlio HTTP entry documenting a `?since=N` the tool could not pass.
// Resolved by giving the tool that parameter, so no allow-list is needed — any collision is a bug.
const KNOWN_CATALOG_COLLISIONS = new Set();

/** Every .md under a root, as [label, absolutePath]. */
function proseFiles() {
  const out = [];
  for (const root of PROSE_ROOTS) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true })) {
      if (typeof rel === "string" && rel.endsWith(".md")) out.push([`${root}/${rel}`, join(dir, rel)]);
    }
  }
  return out;
}

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
    const p = spawn(process.execPath, [SERVER, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      p.kill();
      fail(new Error(`timed out asking the server for tools/list ${args.join(" ")}${err.trim() ? `\n\n${err.trim()}` : ""}`));
    }, 30000);
    p.on("error", fail);
    p.stdin.on("error", fail);
    p.stderr.on("data", (chunk) => { err += chunk.toString(); });
    p.on("close", (code, signal) => {
      if (settled) return;
      const detail = err.trim() || `no stderr; signal ${signal ?? "none"}`;
      fail(new Error(`server exited ${code ?? "without a code"} before tools/list ${args.join(" ")} responded\n\n${detail}`));
    });
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
          settled = true;
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
  const codeToolNames = new Set(codeTools.map((tool) => tool.name));

  // A count can be right while the names beside it are wrong. The runtime banner did exactly
  // that after `observe` became the fourth primary tool: it printed "7" but enumerated six names.
  const indexSource = readFileSync(join(ROOT, "src/mcp-server/index.ts"), "utf-8");
  const bannerNames = /Code mode \(default\).*?tools \(([^)]+)\)/.exec(indexSource)?.[1]
    ?.replace("+ async jobs:", ",")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean) ?? [];
  const missingFromBanner = [...codeToolNames].filter((name) => !bannerNames.includes(name));
  const extraInBanner = bannerNames.filter((name) => !codeToolNames.has(name));
  if (missingFromBanner.length || extraInBanner.length) {
    failures.push(`code-mode runtime banner names [${bannerNames.join(", ")}], tools/list names [${[...codeToolNames].join(", ")}]`);
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
  for (const m of prose.matchAll(SUSPICIOUS)) {
    const at = m.index ?? 0;
    const before = prose.slice(Math.max(0, at - 80), at);
    if (before.includes("<!--n:") && !before.includes("<!--/n-->")) continue;
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
  const proseDocs = proseFiles();
  const shippedSkillCount = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "skills", entry.name, "SKILL.md")))
    .length;
  if (shippedSkillCount !== 11) {
    failures.push(`skills/ contains ${shippedSkillCount} shipped SKILL.md directories, but the product surface promises 11`);
  }
  for (const [label, path] of proseDocs) {
    const body = readFileSync(path, "utf-8");
    const dead = body.match(/mcp__crawlio-agent__[a-z_]+/g);
    if (dead) {
      const unique = [...new Set(dead)];
      failures.push(`${label} grants ${unique.length} tool(s) under the retired mcp__crawlio-agent__ prefix (e.g. ${unique[0]}) — init writes the crawlio-browser key, so these grant nothing`);
    }
  }

  // The curated browser command reference is an executable interface contract, not illustrative
  // prose. Validate every backticked key parameter in its tables against the live full-mode JSON
  // schema. `storageType` is the one deliberate code-mode alias for the full tool's `type` field,
  // because `type` is already the bridge envelope discriminator.
  const commandReference = join(ROOT, "skills/browser-automation/references/reference.md");
  if (existsSync(commandReference)) {
    const schemas = new Map(fullTools.map((tool) => [
      tool.name,
      new Set(Object.keys(tool.inputSchema?.properties ?? {})),
    ]));
    for (const line of readFileSync(commandReference, "utf-8").split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      const command = /^`([a-z][a-z0-9_]+)`$/.exec(cells[1] ?? "")?.[1];
      if (!command || !schemas.has(command)) continue;
      const aliases = command.includes("storage") ? new Set(["storageType"]) : new Set();
      const documented = [...(cells[3] ?? "").matchAll(/`([A-Za-z][A-Za-z0-9]*)(?:\?)?`/g)]
        .map((match) => match[1]);
      const unknown = documented.filter((param) => !schemas.get(command).has(param) && !aliases.has(param));
      if (unknown.length > 0) {
        failures.push(`skills/browser-automation/references/reference.md documents unknown ${command} parameter(s): ${unknown.join(", ")}`);
      }
    }
  }

  // A skill that tells the model to call something is only correct if that something is callable.
  // Checked against the whole measured catalog, not the MCP tool list, because the Crawlio HTTP
  // commands are reached through `crawlio.api()` and are just as real.
  //
  // Two things are deliberately NOT failures. A line that labels an identifier as absent is
  // teaching the trap — browser-automation warns against `get_network_entries` on purpose. And an
  // identifier has to appear in a calling position; enum values like `tab_closed` and field names
  // are not tool calls.
  const callable = new Set(surface.catalog.names);
  const TEACHING = /WRONG|does ?NOT exist|doesn't exist|no longer|not a tool|deprecated|retired|\bno `/i;
  const CALLSITE = /type:\s*['"]([a-z][a-z0-9_]+)['"]|`([a-z][a-z0-9_]+)\(\)`|mcp__crawlio-browser__([a-z0-9_]+)/g;
  for (const [label, path] of proseDocs) {
    const missing = new Set();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (TEACHING.test(line)) continue;
      for (const m of line.matchAll(CALLSITE)) {
        const name = m[1] ?? m[2] ?? m[3];
        if (name && name.includes("_") && !callable.has(name)) missing.add(name);
      }
    }
    if (missing.size > 0) {
      failures.push(`${label} instructs ${missing.size} tool(s) that do not exist: ${[...missing].join(", ")}`);
    }
  }

  // A skill quoting the surface drifts the same way the README did. Same shape as the
  // package.json check below, widened to the words skills actually use.
  for (const [label, path] of proseDocs) {
    const body = readFileSync(path, "utf-8");
    const claimed = /(\d{2,3})\s+(?:CDP|browser)\s+tools/i.exec(body);
    if (claimed && Number(claimed[1]) !== truth.full) {
      failures.push(`${label} claims ${claimed[1]} browser tools, measured ${truth.full}`);
    }
    const measuredClaims = [
      [/\b(\d{1,3})\s+core\s+(?:smart\s+)?methods\b/i, "core"],
      [/\b(\d{1,3})\s+higher(?:-order| level)\s+methods\b/i, "higher"],
      [/\b(\d{1,3})\s+(?:framework\s+)?namespaces\b/i, "ns"],
      [/\b(\d{2,3})\s+searchable\s+(?:catalog\s+)?commands\b/i, "catalog"],
    ];
    for (const [pattern, key] of measuredClaims) {
      const match = pattern.exec(body);
      if (match && Number(match[1]) !== truth[key]) {
        failures.push(`${label} claims ${match[1]} ${key}, measured ${truth[key]}`);
      }
    }
  }

  // `search` returning one capability twice under different descriptions is a surface bug, and it
  // also makes the advertised catalog size larger than the number of distinct things.
  const catalogSeen = new Set();
  const collisions = new Set();
  for (const name of surface.catalog.names) {
    if (catalogSeen.has(name)) collisions.add(name);
    catalogSeen.add(name);
  }
  const newCollisions = [...collisions].filter((c) => !KNOWN_CATALOG_COLLISIONS.has(c));
  if (newCollisions.length > 0) {
    failures.push(`catalog registers ${newCollisions.join(", ")} more than once — search would return one capability twice`);
  }

  // Shipped prose must not point at files the install does not contain.
  //
  // The eleven crawlio-* agents were briefly added to `files` on the reasoning that assets which
  // never ship reach nobody. Every one of them instructs the model to import
  // `src/evidence/wrap.ts` — which is not in `files`, and is not even part of the server build —
  // and the investigator additionally reads `loops/*.json`. An installed fleet would have failed
  // on its first instruction. A skill or agent is only shippable once what it references ships.
  const shipped = new Set(pkg.files);
  const shipsPath = (p) => [...shipped].some((f) => (f.endsWith("/") ? p.startsWith(f) : p === f));
  const REPO_PATH = /`((?:src|loops|scripts|tests|packages|bin)\/[A-Za-z0-9_./-]+)`/g;
  for (const [label, path] of proseDocs) {
    if (!shipsPath(label)) continue; // only prose that actually ships is held to this
    const dangling = new Set();
    for (const m of readFileSync(path, "utf-8").matchAll(REPO_PATH)) {
      if (!shipsPath(m[1])) dangling.add(m[1]);
    }
    if (dangling.size > 0) {
      failures.push(`${label} ships but references ${dangling.size} unshipped path(s): ${[...dangling].join(", ")}`);
    }
  }

  // Product investigation workflows live in the eleven shipped skills. The repo-local agent
  // fixtures depend on unshipped src/evidence and loops files, so adding them to the package or
  // plugin manifest would re-create a surface whose first instruction cannot run.
  if ([...shipped].some((entry) => entry === "agents" || entry.startsWith("agents/"))) {
    failures.push("package.json ships repo-local agents/ fixtures; fold executable behavior into skills or ship every runtime dependency first");
  }

  // Agent Plugins load the package in default code mode. A shipped skill granting a full-mode
  // tool therefore advertises a workflow the installed plugin cannot call. This is subtler than
  // a nonexistent tool: robot_training_start existed in the full catalog but was absent from
  // the default tools/list, so the skill looked valid while its first call was forbidden.
  for (const [label, path] of proseDocs) {
    if (!label.startsWith("skills/") || !shipsPath(label)) continue;
    const body = readFileSync(path, "utf-8");
    const allowedLine = /^allowed-tools:\s*(.+)$/m.exec(body)?.[1] ?? "";
    const grants = [...allowedLine.matchAll(/mcp__crawlio-browser__([a-z0-9_]+)/g)].map((m) => m[1]);
    for (const grant of grants) {
      if (!codeToolNames.has(grant)) {
        failures.push(`${label} grants ${grant}, but the shipped plugin starts in code mode and tools/list does not expose it`);
      }
    }
  }

  // The plugin manifests are the third place the version and the surface get quoted.
  const pluginPath = join(ROOT, "plugin.json");
  const mcpPath = join(ROOT, "mcp.json");
  if (existsSync(pluginPath)) {
    const plugin = JSON.parse(readFileSync(pluginPath, "utf-8"));
    const SPEC = "1.0.0";
    if (plugin.$schema !== `https://agent-plugins.org/schemas/${SPEC}/plugin.schema.json`) {
      failures.push(`plugin.json $schema is ${plugin.$schema} — expected the ${SPEC} plugin schema`);
    }
    if (plugin.version !== pkg.version) {
      failures.push(`plugin.json version is ${plugin.version}, package.json is ${pkg.version}`);
    }
    if (plugin.license !== pkg.license) {
      failures.push(`plugin.json license is ${plugin.license}, package.json is ${pkg.license}`);
    }
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(plugin.name) || /--|\.\./.test(plugin.name)) {
      failures.push(`plugin.json name "${plugin.name}" violates the spec's character rules`);
    }
    if (plugin.agents) {
      failures.push("plugin.json advertises repo-local agent fixtures; the supported product workflows are the shipped skills");
    }
    if (existsSync(mcpPath)) {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
      // The spec invalidates the MCP config outright when the two schema versions disagree.
      if (mcp.$schema !== `https://agent-plugins.org/schemas/${SPEC}/mcp.schema.json`) {
        failures.push(`mcp.json $schema is ${mcp.$schema} — expected the ${SPEC} mcp schema`);
      }
      for (const [name, server] of Object.entries(mcp.mcpServers ?? {})) {
        // `command` is resolved as one executable token; placeholders are expanded in args only.
        if (server.command?.includes("${") || server.command?.includes(" ")) {
          failures.push(`mcp.json server "${name}" command must be a single token without placeholders`);
        }
        if (server.transport) {
          failures.push(`mcp.json server "${name}" uses "transport" — the spec names the field "type"`);
        }
      }
    }
  }
  const descriptions = [
    ["package.json", pkg.description],
    ["server.json", server.description],
    ["plugin.json", existsSync(pluginPath) ? JSON.parse(readFileSync(pluginPath, "utf-8")).description : ""],
    [".claude-plugin/plugin.json", existsSync(join(ROOT, ".claude-plugin/plugin.json"))
      ? JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf-8")).description
      : ""],
  ];
  for (const [label, description] of descriptions) {
    const claimed = /(\d{2,3})\s+(?:CDP(?:-backed)?|browser)?\s*tools/i.exec(description ?? "");
    if (claimed && Number(claimed[1]) !== truth.full) {
      failures.push(`${label} description claims ${claimed[1]} tools, measured ${truth.full}`);
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
