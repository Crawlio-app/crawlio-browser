#!/usr/bin/env node
// Publish gate: the npm version and the extension version must move together.
//
// crawlio-browser@1.7.0 was published, then deprecated with "Use 1.6.1 — version
// bump was premature, extension stays at 1.6.1". The rule was written down in
// .claude/skills/release/SKILL.md ("All four version strings must match") but
// enforced only by a human reading it, so 1.7.1 shipped with manifest.prod.json
// at 1.7.0 and manifest.dev.json at 1.6.5. This script is that checklist,
// executable, wired into prepublishOnly.
//
// dist/extension/manifest.json is checked too: a matching SOURCE manifest proves
// nothing if the built extension nobody submitted is still a release behind.
//
// CRAWLIO_VERSION_CHECK_ROOT relocates the repo root (tests only).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.CRAWLIO_VERSION_CHECK_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJSONVersion(relPath) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) return { path: relPath, version: null, missing: true };
  try {
    return { path: relPath, version: JSON.parse(readFileSync(full, "utf8")).version ?? null };
  } catch (error) {
    return { path: relPath, version: null, unreadable: error.message };
  }
}

function readConstantsVersion(relPath) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) return { path: relPath, version: null, missing: true };
  const match = /PKG_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(full, "utf8"));
  return { path: relPath, version: match ? match[1] : null, unreadable: match ? undefined : "PKG_VERSION not found" };
}

export function collectVersions() {
  return [
    readJSONVersion("package.json"),
    readConstantsVersion("src/shared/constants.ts"),
    readJSONVersion("src/extension/manifest.prod.json"),
    readJSONVersion("src/extension/manifest.dev.json"),
    readJSONVersion("server.json"),
    readJSONVersion("dist/extension/manifest.json"),
  ];
}

export function findProblems(entries) {
  const expected = entries[0].version;
  const problems = [];
  if (!expected) {
    problems.push("package.json has no readable version — cannot establish the expected release version");
    return problems;
  }
  for (const entry of entries.slice(1)) {
    if (entry.missing) {
      problems.push(
        entry.path === "dist/extension/manifest.json"
          ? `${entry.path} is missing — run \`npm run build:extension\` so the shipped extension matches ${expected}`
          : `${entry.path} is missing`,
      );
      continue;
    }
    if (entry.unreadable) {
      problems.push(`${entry.path} is unreadable (${entry.unreadable})`);
      continue;
    }
    if (entry.version !== expected) {
      problems.push(`${entry.path} is ${entry.version}, expected ${expected}`);
    }
  }
  return problems;
}

function main() {
  const entries = collectVersions();
  const problems = findProblems(entries);
  const expected = entries[0].version;

  if (problems.length === 0) {
    console.log(`version sync OK — all ${entries.length} surfaces at ${expected}`);
    return 0;
  }

  console.error(`\n  Version sync FAILED (expected ${expected ?? "?"}):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\n  The npm package and the Chrome extension ship as one unit. Publishing npm\n" +
      "  ahead of the extension is what burned 1.7.0. Sync every surface, rebuild the\n" +
      "  extension, and submit it before publishing.\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
