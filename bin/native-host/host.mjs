#!/usr/bin/env node
// Crawlio native-messaging host.
//
// Chrome launches this host (named "com.crawlio.agent" in the installed manifest)
// when the extension calls connectNative(). It is the rogue-proof channel that
// delivers the REAL bridge token to the extension: Chrome only launches the binary
// named in a manifest placed in a protected directory, and only routes messages to
// the extension ID in the manifest's allowed_origins — so a rogue local listener
// can't impersonate it. The extension then refuses any WS server that can't prove it
// holds this token (see evaluateServerTrust / verifyHandshakeProof).
//
// Protocol: Chrome native messaging = 4-byte little-endian length + UTF-8 JSON on
// stdin/stdout. The extension's connectNative sends {type:"ping"} and expects a
// {type:"pong"}; we answer that, then push the trusted token + port.
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeNativeMessage, decodeNativeMessages, isNativeHostLeaseExpired, selectProvisionableBridge } from "./provision.mjs";

const BRIDGES_DIR = join(homedir(), ".crawlio", "bridges");
const MAX_STDIN_BUF = 1 * 1024 * 1024; // a ping is tiny; cap the inbound buffer

function send(obj) {
  try {
    process.stdout.write(encodeNativeMessage(obj));
  } catch {
    // stdout closed (Chrome disconnected) — nothing to do
  }
}

// Last token+port we pushed to the extension. We re-elect on an interval (the active
// bridge can change as the user drives a different server), but only re-send when the
// winner actually changes — so the extension isn't told to reconnect on every tick.
let lastSent = { token: null, port: null };

// In-flight guard: selectProvisionableBridge validates bridges SEQUENTIALLY with
// a 500ms health timeout each, so one run can exceed the 2.5s poll; without this two runs
// overlap and race lastSent (double-send / A-B thrash).
let provisioning = false;
async function provisionToken() {
  if (provisioning) return;
  provisioning = true;
  try {
    // The /health-validated live bridges are elected by most-recent activity; a rogue file
    // or a pid-mismatched server never validates, so it can't be provisioned.
    const bridge = await selectProvisionableBridge(BRIDGES_DIR);
    if (bridge && (bridge.token !== lastSent.token || bridge.port !== lastSent.port)) {
      send({ type: "set_crawlio_token", token: bridge.token });
      send({ type: "set_crawlio_port", port: bridge.port });
      lastSent = { token: bridge.token, port: bridge.port };
    }
  } finally {
    provisioning = false;
  }
}

// Re-provision poll: started once after the first ping so the trusted token follows the
// active session even while connectNative stays open. Cleared on stdin end/error.
let reprovisionTimer = null;
let leaseTimer = null;
let lastPingAt = 0;
function startReprovisionPoll() {
  if (reprovisionTimer) return;
  reprovisionTimer = setInterval(() => { void provisionToken(); }, 2500);
}
function startLeaseWatch() {
  if (leaseTimer) return;
  leaseTimer = setInterval(() => {
    if (isNativeHostLeaseExpired(lastPingAt)) shutdown();
  }, 5_000);
}
function stopReprovisionPoll() {
  if (reprovisionTimer) { clearInterval(reprovisionTimer); reprovisionTimer = null; }
}
function shutdown() {
  stopReprovisionPoll();
  if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
  process.exit(0);
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length > MAX_STDIN_BUF) {
    buf = Buffer.alloc(0); // drop a malformed/oversized stream rather than grow unbounded
    return;
  }
  const { messages, rest } = decodeNativeMessages(buf);
  buf = rest;
  for (const msg of messages) {
    if (msg && msg.type === "ping") {
      lastPingAt = Date.now();
      send({ type: "pong" }); // satisfy connectNative's liveness handshake
      void provisionToken(); // then deliver the trusted token over this authenticated channel
      startReprovisionPoll(); // and keep it pointed at the active session
      startLeaseWatch(); // retire if the owning extension worker stops renewing the lease
    }
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
