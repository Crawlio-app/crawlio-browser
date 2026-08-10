#!/usr/bin/env node
// Print the extension's build id: a hash of the sources it is built from.
//
// It used to be `date -u +%Y%m%dT%H%M%SZ`, which changes on every build whether or not the
// extension changed. The E2E harness compares the id Chrome reports against the one in
// dist/extension and refuses to grade a stale browser — a guard worth having, since Chrome does
// not hot-reload unpacked extensions and grading the wrong binary produces a scatter of unrelated
// failures. But with a timestamp, any rebuild for a SERVER-side change also invalidated it, so the
// guard blocked runs over work that could not affect the extension, and the only way through was
// to reload Chrome for a bundle byte-identical to the one already loaded.
//
// Hashing the sources makes the id mean what the guard assumes it means: same id, same extension.
// A server-only rebuild now yields the same id, and a real extension change yields a new one.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everything the extension bundle is built from. `shared/` is included because background.ts
// imports from it, so a change there changes the bundle.
const ROOTS = ["src/extension", "src/shared"];
const EXTS = new Set([".ts", ".js", ".json", ".html", ".css"]);

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { yield* files(full); continue; }
    if (EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")))) yield full;
  }
}

const hash = createHash("sha256");
for (const root of ROOTS) {
  const dir = join(ROOT, root);
  try { statSync(dir); } catch { continue; }
  for (const f of files(dir)) {
    // Path as well as content: renaming a file changes the bundle even when bytes do not.
    hash.update(relative(ROOT, f));
    hash.update(readFileSync(f));
  }
}

process.stdout.write(hash.digest("hex").slice(0, 16));
