import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketBridge } from "../../src/mcp-server/websocket-bridge.js";
import { BRIDGE_DIR } from "../../src/shared/constants.js";
import { verifyHandshakeProof, randomNonce, HANDSHAKE_MESSAGE_TYPES } from "../../src/shared/bridge-handshake.js";

/**
 * Wire-level integration for the token bootstrap (rt-bridge ship-blocker follow-up):
 *  - #4: a chrome-extension-origin client (how the extension connects) is still ACCEPTED
 *        after dropping the no-origin/localhost fallbacks — i.e. the fix didn't brick the
 *        real client.
 *  - #3: the real bridge answers a challenge with a proof bound to ITS listening port, which
 *        the (token-holding) client verifies at the dialed port and rejects at any other.
 * Token = the secret the server writes to its 0600 bridge file, exactly what the native host
 * provisions to the extension.
 */
describe("bridge token handshake — wire integration (#3/#4)", () => {
  it("accepts the extension origin and returns a port-bound, verifiable proof", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    const port = bridge.port;
    try {
      const token = JSON.parse(
        readFileSync(join(BRIDGE_DIR, `${process.pid}.json`), "utf8"),
      ).token as string;
      expect(typeof token).toBe("string");

      const nonce = randomNonce();
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });

      const proof = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("handshake timeout")), 4000);
        ws.on("open", () => ws.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce })));
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === HANDSHAKE_MESSAGE_TYPES.handshake) { clearTimeout(timer); resolve(msg.proof); }
          } catch { /* ignore non-JSON */ }
        });
        ws.on("error", (e) => { clearTimeout(timer); reject(e); });
      });

      // #3: valid only for the port the client actually dialed.
      expect(await verifyHandshakeProof(token, nonce, port, proof)).toBe(true);
      expect(await verifyHandshakeProof(token, nonce, port + 1, proof)).toBe(false);
      // Wrong token never verifies.
      expect(await verifyHandshakeProof("not-the-real-token", nonce, port, proof)).toBe(false);

      ws.close();
    } finally {
      await bridge.stop();
    }
  }, 15000);
});
