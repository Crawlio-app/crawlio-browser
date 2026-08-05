#!/usr/bin/env node
// Regenerate the pinned extension key + its derived Chrome extension id.
// Rewrites bin/native-host/ext-key.json. Then paste the printed "key" into
// src/extension/manifest.prod.json (top-level "key"), reload the unpacked extension,
// and re-run install.mjs — it reads ext-key.json so the host manifest's
// allowed_origins follows the new id automatically.
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const spki = publicKey.export({ type: "spki", format: "der" });
const key = spki.toString("base64");
// Chrome extension id = first 128 bits of SHA-256(SPKI), hex digits mapped 0-9a-f -> a-p.
const hash = crypto.createHash("sha256").update(spki).digest("hex").slice(0, 32);
const extensionId = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(resolve(here, "ext-key.json"), JSON.stringify({ key, extensionId }, null, 2));
console.log("extensionId:", extensionId);
console.log('\nPaste this as the top-level "key" in src/extension/manifest.prod.json:\n');
console.log(key);
