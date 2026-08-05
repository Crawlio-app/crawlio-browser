import { describe, expect, it } from "vitest";
import { isAllowedHostHeader, isAcceptableWsClient } from "../../src/mcp-server/websocket-bridge.js";

/**
 * Historically /health disclosed the bridge token and the listener honored any Host,
 * so a DNS-rebound page (evil.com -> 127.0.0.1) could read the token and drive
 * the bridge. The token is now gone from /health and every request must carry a
 * loopback Host header. This guards the rebind decision.
 */
describe("isAllowedHostHeader — DNS-rebind guard", () => {
  it("accepts loopback hosts with and without a port", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:9333", "localhost", "localhost:9342", "[::1]", "[::1]:9333"]) {
      expect(isAllowedHostHeader(host)).toBe(true);
    }
  });

  it("rejects a rebound attacker host (same-origin rebind sends the attacker Host)", () => {
    for (const host of ["evil.com", "evil.com:9333", "attacker.example", "169.254.169.254", "0.0.0.0:9333"]) {
      expect(isAllowedHostHeader(host)).toBe(false);
    }
  });

  it("rejects a missing/empty Host header", () => {
    expect(isAllowedHostHeader(undefined)).toBe(false);
    expect(isAllowedHostHeader("")).toBe(false);
  });

  it("is not fooled by a loopback-looking subdomain", () => {
    expect(isAllowedHostHeader("127.0.0.1.evil.com")).toBe(false);
    expect(isAllowedHostHeader("localhost.evil.com")).toBe(false);
    expect(isAllowedHostHeader("notlocalhost")).toBe(false);
  });
});

/**
 * verifyClient once accepted bare no-origin / localhost connections, so any unauthenticated
 * local process could connect, evict the extension, and drive/forge the session. Accept is
 * now: valid token OR a chrome-extension:// origin (the extension).
 */
describe("isAcceptableWsClient — WS auth decision", () => {
  it("accepts any client that presented a valid bridge token (origin irrelevant)", () => {
    expect(isAcceptableWsClient(undefined, true)).toBe(true);
    expect(isAcceptableWsClient("http://localhost", true)).toBe(true);
    expect(isAcceptableWsClient("chrome-extension://abc", true)).toBe(true);
  });

  it("accepts the extension by its chrome-extension:// origin without a token (TOFU)", () => {
    expect(isAcceptableWsClient("chrome-extension://hcjdiacihjiilndbaeligceompemdcmp", false)).toBe(true);
  });

  it("REJECTS a tokenless no-origin / null-origin local client (the old accept-anyone hole)", () => {
    expect(isAcceptableWsClient(undefined, false)).toBe(false);
    expect(isAcceptableWsClient("null", false)).toBe(false);
    expect(isAcceptableWsClient("", false)).toBe(false);
  });

  it("REJECTS a tokenless localhost / 127.0.0.1 origin (no longer a free pass)", () => {
    expect(isAcceptableWsClient("http://localhost", false)).toBe(false);
    expect(isAcceptableWsClient("http://127.0.0.1:5173", false)).toBe(false);
    expect(isAcceptableWsClient("http://localhost:3000", false)).toBe(false);
  });

  it("REJECTS a tokenless remote/web origin", () => {
    expect(isAcceptableWsClient("https://evil.com", false)).toBe(false);
    expect(isAcceptableWsClient("https://app.example.com", false)).toBe(false);
  });
});
