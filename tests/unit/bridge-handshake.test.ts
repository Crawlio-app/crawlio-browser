import { describe, expect, it } from "vitest";
import {
  computeHandshakeProof,
  verifyHandshakeProof,
  timingSafeStringEqual,
  randomNonce,
  evaluateServerTrust,
} from "../../src/shared/bridge-handshake.js";

/**
 * Historically the extension trusted any local listener answering `{service:"crawlio-mcp"}`.
 * The server now proves it holds the bridge token via HMAC(token, nonce‖port); a client
 * holding the real token rejects a rogue listener that used a different token, and — because
 * the proof binds the server's own listening port — a rogue cannot RELAY the real server's
 * proof from another port.
 */
describe("bridge-handshake (server-identity proof)", () => {
  const PORT = 9333;

  it("produces a deterministic proof a holder of the same token can verify", async () => {
    const token = "real-bridge-token-abc123";
    const nonce = randomNonce();
    const proof = await computeHandshakeProof(token, nonce, PORT);
    expect(proof).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await verifyHandshakeProof(token, nonce, PORT, proof)).toBe(true);
  });

  it("rejects a proof from a ROGUE server that signed with a different token", async () => {
    const realToken = "real-bridge-token-abc123";
    const rogueToken = "rogue-process-token-zzz999";
    const nonce = randomNonce();
    // The rogue server can only sign with the token IT generated (it never read the
    // real 0600 bridge file). Verifying against the real token fails.
    const rogueProof = await computeHandshakeProof(rogueToken, nonce, PORT);
    expect(await verifyHandshakeProof(realToken, nonce, PORT, rogueProof)).toBe(false);
  });

  it("rejects a replayed proof bound to a different nonce", async () => {
    const token = "real-bridge-token-abc123";
    const proofForA = await computeHandshakeProof(token, "nonce-A", PORT);
    expect(await verifyHandshakeProof(token, "nonce-B", PORT, proofForA)).toBe(false);
  });

  it("rejects a RELAYED proof bound to a different port (handshake relay)", async () => {
    // The real server listens on X and signs ‖X. A rogue on Y relays the extension's nonce
    // to the real server, gets back the ‖X proof, and forwards it. The extension dialed Y,
    // so it verifies ‖Y — the relayed ‖X proof must NOT verify.
    const token = "real-bridge-token-abc123";
    const nonce = randomNonce();
    const realPort = 9333;
    const roguePort = 9334;
    const proofFromRealServer = await computeHandshakeProof(token, nonce, realPort);
    expect(await verifyHandshakeProof(token, nonce, realPort, proofFromRealServer)).toBe(true);
    expect(await verifyHandshakeProof(token, nonce, roguePort, proofFromRealServer)).toBe(false);
  });

  it("rejects empty/missing/non-numeric inputs", async () => {
    expect(await verifyHandshakeProof("", "n", PORT, "p")).toBe(false);
    expect(await verifyHandshakeProof("t", "", PORT, "p")).toBe(false);
    expect(await verifyHandshakeProof("t", "n", PORT, "")).toBe(false);
    expect(await verifyHandshakeProof("t", "n", PORT, undefined)).toBe(false);
    // @ts-expect-error — a non-numeric port must be rejected, not coerced
    expect(await verifyHandshakeProof("t", "n", "9333", "p")).toBe(false);
    expect(await verifyHandshakeProof("t", "n", NaN, "p")).toBe(false);
  });

  it("timingSafeStringEqual compares by value, length-sensitive", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "ab")).toBe(false);
  });

  it("randomNonce is 32 hex chars and unique across calls", () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("evaluateServerTrust: refuse an unverified server only when a trusted token is held", () => {
    expect(evaluateServerTrust(true, true)).toBe("trusted");
    expect(evaluateServerTrust(true, false)).toBe("refuse");   // rogue-server hole closed
    expect(evaluateServerTrust(false, false)).toBe("tofu-allow"); // no provisioning -> unchanged
    expect(evaluateServerTrust(false, true)).toBe("trusted");
  });
});
