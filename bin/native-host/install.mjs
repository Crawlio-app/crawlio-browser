#!/usr/bin/env node
// Install (or remove) the Crawlio native-messaging host so the extension can be
// handed the real bridge token over Chrome's authenticated channel.
//
//   node bin/native-host/install.mjs            # install for all detected browsers
//   node bin/native-host/install.mjs --uninstall
//
// Set CRAWLIO_NM_DIR=<dir> to target a single directory (used by tests).
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { HOST_NAME, targetDirs } from "./provision.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hostScript = resolve(here, "host.mjs");
const provisionScript = resolve(here, "provision.mjs");
// Stage the host into a STABLE, non-TCC-protected directory and run the wrapper from THERE.
// Two reasons the package dir can't be the exec location: (1) macOS TCC blocks Chrome from
// executing a native-messaging host under ~/Desktop, ~/Documents, or ~/Downloads — a repo
// cloned to the Desktop fails at runtime with "Native host has exited" even though the host
// is fine; (2) an `npx` package dir is ephemeral and may be GC'd, leaving a dangling manifest.
// ~/.crawlio/native-host avoids both. (Honors CRAWLIO_NM_DIR so tests stay self-contained.)
const HOST_DIR = process.env.CRAWLIO_NM_DIR
  ? join(process.env.CRAWLIO_NM_DIR, "native-host")
  : join(homedir(), ".crawlio", "native-host");
const stagedHost = join(HOST_DIR, "host.mjs");
const wrapperPath = join(HOST_DIR, "crawlio-native-host"); // exec'd by the NM manifest
const extKey = JSON.parse(readFileSync(resolve(here, "ext-key.json"), "utf8"));
const extId = extKey.extensionId;
// Include the published Chrome Web Store id(s): a store install has a DIFFERENT id than the
// dev unpacked build, so without it every Web Store user's connectNative is refused and the
// trusted token never arrives -> permanent trust-on-first-use for the whole fleet.
const allowedExtensionIds = [extId, ...(Array.isArray(extKey.storeIds) ? extKey.storeIds : [])];

function uninstall() {
  for (const dir of targetDirs()) {
    const f = join(dir, `${HOST_NAME}.json`);
    try { rmSync(f); console.log(`removed ${f}`); } catch { /* not present */ }
  }
  try { rmSync(HOST_DIR, { recursive: true, force: true }); } catch { /* fine */ }
}

function install() {
  // 1. Stage the host (+ its provision.mjs sibling) into ~/.crawlio/native-host and run the
  //    wrapper from there, so Chrome can always exec it regardless of where the package lives.
  mkdirSync(HOST_DIR, { recursive: true });
  copyFileSync(hostScript, stagedHost);
  copyFileSync(provisionScript, join(HOST_DIR, "provision.mjs"));
  // node-path wrapper (the NM manifest must point at an executable; .mjs is not).
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stagedHost)} "$@"\n`);
  chmodSync(wrapperPath, 0o755);

  // 2. the host manifest, locked to OUR extension id.
  const manifest = {
    name: HOST_NAME,
    description: "Crawlio bridge token provisioner",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: allowedExtensionIds.map((id) => `chrome-extension://${id}/`),
  };
  const dirs = targetDirs();
  if (dirs.length === 0) { console.log("No Chromium-family browser profile found; nothing installed."); return; }
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${HOST_NAME}.json`);
    writeFileSync(f, JSON.stringify(manifest, null, 2));
    console.log(`installed ${f}`);
  }
  console.log(`\nNative host ready for extension id(s): ${allowedExtensionIds.join(", ")}.`);
  console.log("Reload the unpacked extension, then server identity verification is live.");
}

if (process.argv.includes("--uninstall")) uninstall();
else install();
