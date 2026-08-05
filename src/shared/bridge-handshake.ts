/**
 * Bridge server-identity handshake.
 *
 * A rogue local listener can answer /health with `{ service: "crawlio-mcp" }` and
 * lure the extension into connecting and executing its pushed CDP commands. To
 * raise the bar, the server proves it holds the bridge token (which the legitimate
 * server read from its own 0600 `~/.crawlio/bridges/<pid>.json`) by returning
 * HMAC-SHA256(token, nonce‖port) for an extension-issued nonce. A client that learns
 * the real token through a trusted channel (the authenticated native-messaging host)
 * can then reject any listener that cannot produce the proof.
 *
 * The proof binds the server's own LISTENING PORT, not just the nonce (defeating a
 * handshake relay). A rogue on port Y cannot relay the extension's nonce to the real
 * server on port X and pass back its proof: the real server signs ‖X, but the
 * extension dialed Y and verifies ‖Y, so the relayed proof mismatches. Binding the
 * port is sound because on loopback a port maps to exactly one listening process.
 *
 * Scope: this defends against listeners that CANNOT read the user's bridge files
 * (sandboxed / lower-privilege / cross-user). A *same-user* process has equal
 * privilege — it can read the token itself — so that residual is covered by
 * Chrome's visible debugger infobar (consent), not by this handshake.
 *
 * Implemented over Web Crypto so the identical code runs in the MV3 service worker
 * and in Node (>=20 exposes webcrypto as the global `crypto`).
 */

const CHALLENGE_TYPE = "__crawlio_challenge__";
const HANDSHAKE_TYPE = "__crawlio_handshake__";

export const HANDSHAKE_MESSAGE_TYPES = { challenge: CHALLENGE_TYPE, handshake: HANDSHAKE_TYPE } as const;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Canonical proof a server returns for a nonce: base64(HMAC-SHA256(token, `${nonce}:${port}`)).
 * `port` is the server's own listening port; binding it defeats a cross-port relay.
 */
export async function computeHandshakeProof(token: string, nonce: string, port: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${nonce}:${port}`));
  return bytesToBase64(new Uint8Array(sig));
}

/** Constant-time string compare so a verifier does not leak the proof via timing. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True iff `proof` is a valid HMAC of `nonce‖port` under `token` (port = the port WE dialed). */
export async function verifyHandshakeProof(token: string, nonce: string, port: number, proof: unknown): Promise<boolean> {
  if (!token || !nonce || typeof port !== "number" || !Number.isFinite(port) || typeof proof !== "string" || proof.length === 0) return false;
  const expected = await computeHandshakeProof(token, nonce, port);
  return timingSafeStringEqual(expected, proof);
}

/** 16-byte random nonce, hex-encoded (Web Crypto getRandomValues — Node + MV3). */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export type ServerTrustDecision = "trusted" | "refuse" | "tofu-allow";

/**
 * Decide whether to trust a discovered server given (a) whether we hold the real
 * bridge token from a trusted channel and (b) whether the server's handshake proof
 * verified. With a trusted token we REFUSE any server that fails the proof (this
 * closes the rogue-server hole); without one we fall back to trust-on-first-use so
 * existing setups with no native provisioning keep working unchanged.
 */
export function evaluateServerTrust(hasTrustedToken: boolean, handshakeVerified: boolean): ServerTrustDecision {
  if (handshakeVerified) return "trusted";
  if (hasTrustedToken) return "refuse";
  return "tofu-allow";
}
