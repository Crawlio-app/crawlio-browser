import { describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WS_PORT_MAX } from "../../src/shared/constants.js";
import { listenWalkingPortRange } from "../../src/mcp-server/websocket-bridge.js";

// The extension's local WS_PORT_END (src/extension/background.ts) MUST equal the server's
// WS_PORT_MAX. background.ts cannot import constants.ts (that module evaluates
// os.homedir()/path at load and background.ts builds as a browser IIFE), so this test pins
// the server cap against a hard-coded expectation. If the port range ever moves, update
// WS_PORT_END in background.ts in lockstep — they must not silently diverge.
describe("bridge port range", () => {
  it("pins the server WS_PORT_MAX (cross-reference: background.ts WS_PORT_END)", () => {
    expect(WS_PORT_MAX).toBe(9342);
  });
});

// Regression for the MCP disconnect bug: a busy bridge port (a concurrent/zombie instance)
// used to escape as `EADDRINUSE` → uncaughtException → process.exit, dropping the whole MCP
// stdio server. listenWalkingPortRange must walk past a busy port and, when the range is
// exhausted, return null WITHOUT throwing. Uses ephemeral ports so it's independent of the
// real 9333-9342 range and any live crawlio server on the machine.
describe("listenWalkingPortRange — bind-collision resilience", () => {
  const occupy = (): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => resolve({ server: s, port: (s.address() as AddressInfo).port }));
    });

  it("walks past an occupied port to the next free one", async () => {
    const occupied = await occupy();
    const test = createServer();
    try {
      const bound = await listenWalkingPortRange(test, occupied.port, occupied.port + 10, "127.0.0.1");
      expect(bound).not.toBeNull();
      expect(bound).not.toBe(occupied.port); // never claims the busy port
      expect(bound!).toBeGreaterThan(occupied.port);
      expect(bound!).toBeLessThanOrEqual(occupied.port + 10);
      expect((test.address() as AddressInfo).port).toBe(bound); // actually listening on the walked port
    } finally {
      test.close();
      occupied.server.close();
    }
  });

  it("returns null (no throw, no crash) when the whole range is busy", async () => {
    const occupied = await occupy();
    const test = createServer();
    try {
      // Range = the single occupied port. The EADDRINUSE must be caught (not escape to
      // uncaughtException — that would crash this test process) and yield null.
      const bound = await listenWalkingPortRange(test, occupied.port, occupied.port, "127.0.0.1");
      expect(bound).toBeNull();
      expect(test.listening).toBe(false);
    } finally {
      test.close();
      occupied.server.close();
    }
  });

  it("binds the start port when it is free", async () => {
    // Grab then release a port to learn a currently-free number, then bind it via the walker.
    const probe = await occupy();
    const freePort = probe.port;
    await new Promise<void>((r) => probe.server.close(() => r()));
    const test = createServer();
    try {
      const bound = await listenWalkingPortRange(test, freePort, freePort + 5, "127.0.0.1");
      expect(bound).toBe(freePort);
    } finally {
      test.close();
    }
  });
});
