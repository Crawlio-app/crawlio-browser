// Pure, testable helpers for the Crawlio native-messaging host.
//
// The host delivers the real bridge token to the extension over Chrome's
// authenticated native-messaging channel so the extension's server-identity
// handshake can reject rogue local listeners. This module holds the logic that is
// worth unit-testing — the wire framing and the freshest-live-bridge selection —
// separate from the thin stdin/stdout shell in host.mjs.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Native-messaging host name — the identity Chrome's manifest greenlights. */
export const HOST_NAME = "com.crawlio.agent";

/**
 * NativeMessagingHosts dirs for every installed Chromium-family browser (macOS paths,
 * Linux equivalents under ~/.config/...). Lives here rather than install.mjs because
 * importing install.mjs EXECUTES the installer (top-level dispatch) — read-only
 * consumers like `crawlio-browser doctor` need the dir list without that side effect.
 * CRAWLIO_NM_DIR overrides with a single literal dir (used by tests).
 */
export function targetDirs(env = process.env, exists = existsSync, home = homedir) {
  if (env.CRAWLIO_NM_DIR) return [env.CRAWLIO_NM_DIR];
  const root = home();
  const mac = "Library/Application Support";
  const candidates = [
    `${mac}/Google/Chrome`, `${mac}/Google/Chrome Beta`, `${mac}/Google/Chrome Canary`,
    `${mac}/Chromium`, `${mac}/Microsoft Edge`, `${mac}/BraveSoftware/Brave-Browser`,
    ".config/google-chrome", ".config/chromium", ".config/microsoft-edge", ".config/BraveSoftware/Brave-Browser",
  ];
  // Only report where the browser profile root exists, so installers don't litter.
  return candidates
    .map((c) => join(root, c))
    .filter((p) => exists(p))
    .map((p) => join(p, "NativeMessagingHosts"));
}

/** Encode a JSON object as a Chrome native-messaging frame: 4-byte LE length + UTF-8 JSON. */
export function encodeNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Decode every COMPLETE frame in `buffer`. Returns { messages, rest } where `rest`
 * is the unconsumed tail (a partial frame to be completed by the next chunk).
 */
export function decodeNativeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32LE(offset);
    if (buffer.length - offset - 4 < len) break; // incomplete frame — wait for more
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf8");
    offset += 4 + len;
    try {
      messages.push(JSON.parse(json));
    } catch {
      // skip a malformed frame but keep consuming the rest
    }
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** ESRCH => dead; EPERM => alive but not ours; no throw => alive. */
export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === "EPERM";
  }
}

/**
 * All bridges from `~/.crawlio/bridges/<pid>.json` with a LIVE pid. We do NOT use the
 * file's `startedAt` for anything security-relevant — it is attacker-forgeable, and a
 * same-user rogue could drop a file with a future `startedAt` to win a "freshest" race
 * (the review's break). `lastActivityAt` is read for the SAME reason it is
 * forgeable, but it is consulted ONLY to break ties among bridges that already passed
 * the /health cross-check (validateBridgeViaHealth), never to admit an unvalidated one —
 * see selectProvisionableBridge for why that relaxation is safe. Dependencies are
 * injected for tests.
 */
export function listLiveBridges(
  bridgesDir,
  isPidAlive = defaultIsPidAlive,
  readDir = readdirSync,
  readFile = readFileSync,
) {
  let files;
  try {
    files = readDir(bridgesDir);
  } catch {
    return []; // dir absent — no bridge yet
  }
  const out = [];
  for (const f of files) {
    if (!String(f).endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(readFile(join(bridgesDir, f), "utf8"));
    } catch {
      continue;
    }
    if (typeof data.port !== "number" || typeof data.token !== "string" || typeof data.pid !== "number") continue;
    if (!isPidAlive(data.pid)) continue;
    out.push({
      port: data.port,
      token: data.token,
      pid: data.pid,
      // Used only to elect among multiple VALIDATED bridges (see selectProvisionableBridge).
      // Missing/non-numeric/FUTURE sorts last so a malformed or forged file never wins.
      // Reject future timestamps: a genuine server stamps Date.now() (<= now);
      // a same-user rogue forges a far-future value to always win the election. (Same-user
      // remains out of scope — see the scope note in bridge-handshake.ts — but this kills the trivial forge.)
      lastActivityAt:
        typeof data.lastActivityAt === "number" && data.lastActivityAt <= Date.now() + 5000
          ? data.lastActivityAt
          : -Infinity,
    });
  }
  return out;
}

/**
 * Cross-check that a bridge file corresponds to a REAL crawlio-mcp server actually
 * listening on its port with its pid. So a same-user rogue can't get its token
 * provisioned by merely DROPPING a forged file — it would have to run a real server
 * on that port, which then makes selection ambiguous (see below), never authoritative.
 * (/health no longer discloses the token, so we verify service+pid+port.)
 */
export async function validateBridgeViaHealth(bridge, fetchFn = fetch) {
  try {
    const res = await fetchFn(`http://127.0.0.1:${bridge.port}/health`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return false;
    const body = await res.json();
    return !!body && body.service === "crawlio-mcp" && body.pid === bridge.pid && body.port === bridge.port;
  } catch {
    return false;
  }
}

/**
 * Choose the token to provision among the live bridges whose /health validates:
 *
 *   - zero validate  → null (degrade to trust-on-first-use; safe).
 *   - one validates  → that one (the happy path — single server, no ambiguity).
 *   - two+ validate  → elect the bridge with the MAX `lastActivityAt` (most-recently
 *     dispatched a tool). This is the DELIBERATE relaxation that makes "N bridges, one
 *     extension" work: when the user runs several real crawlio-mcp servers, the token
 *     must follow whichever they are actively driving instead of provisioning nothing.
 *
 * Why this stays safe: validateBridgeViaHealth (service+pid+port, unchanged here) is the
 * security gate and runs BEFORE the election — a file-only rogue or a pid-mismatched
 * forgery never reaches it, so we can never INVERT to such a rogue (the original break).
 * The residual is a same-user process that runs a REAL validating server AND forges a
 * high `lastActivityAt` to win the tiebreak; same-user is explicitly out of scope for this
 * handshake (see bridge-handshake.ts — equal-privilege, covered by Chrome's visible
 * debugger infobar/consent), so electing by a forgeable activity stamp among already-
 * validated peers does not lower the real bar. Returns `{ port, token } | null`.
 */
export async function selectProvisionableBridge(bridgesDir, deps = {}) {
  const live = listLiveBridges(bridgesDir, deps.isPidAlive, deps.readDir, deps.readFile);
  const validated = [];
  for (const b of live) {
    if (await validateBridgeViaHealth(b, deps.fetchFn)) validated.push(b);
  }
  if (validated.length === 0) return null;
  if (validated.length === 1) return { port: validated[0].port, token: validated[0].token };
  // Elect the most-recently-active validated bridge (argmax lastActivityAt). Sort by pid
  // first so ties / all-missing are deterministic regardless of readdir order.
  validated.sort((a, b) => a.pid - b.pid);
  const winner = validated.reduce((a, b) => (b.lastActivityAt > a.lastActivityAt ? b : a));
  return { port: winner.port, token: winner.token };
}
