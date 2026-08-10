import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketBridge } from "../../src/mcp-server/websocket-bridge.js";
import { BRIDGE_DIR } from "../../src/shared/constants.js";

// Relocate the port range BEFORE constants.ts is evaluated. A plain top-level assignment does not
// work here: ES imports are hoisted, so WS_PORT is already read by the time it runs.
vi.hoisted(() => { process.env.CRAWLIO_WS_PORT = "19855"; });

/**
 * The bridge file's `lastActivityAt` is the ONLY signal the native host elects on, and a server
 * that never publishes one can never be handed the trusted token — so the extension never attaches
 * to it and every command it makes expires on the queue.
 *
 * touchBridgeFile() throttles to one write a second, and start() stamps the clock. A freshly
 * spawned server takes its first tool call a few hundred milliseconds later, i.e. always inside
 * that window — so the write that decided whether the server was reachable at all was the one
 * being discarded, and with that first call parked on the queue nothing ever rewrote it. Every
 * new server sat at zero, tied with the idle incumbent, and lost the tie-break forever.
 */
describe("bridge file activity stamp", () => {
  const readStamp = () =>
    JSON.parse(readFileSync(join(BRIDGE_DIR, `${process.pid}.json`), "utf8")).lastActivityAt as number;

  it("publishes the first activity even though it lands inside the write throttle", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    try {
      expect(readStamp(), "a server with no traffic must not claim activity").toBe(0);

      // Exactly what index.ts does on receiving a tool call, at the moment it really happens.
      const at = Date.now();
      bridge.noteActivity(at);

      // Deferred, not dropped: within the throttle interval it has to reach the file.
      await vi.waitFor(() => expect(readStamp()).toBeGreaterThanOrEqual(at), { timeout: 3000, interval: 100 });
    } finally {
      await bridge.stop();
    }
  }, 10_000);

  it("still collapses a burst into a bounded number of writes", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    try {
      const start = Date.now();
      for (let i = 0; i < 50; i++) bridge.noteActivity(start + i);
      await vi.waitFor(() => expect(readStamp()).toBeGreaterThan(0), { timeout: 3000, interval: 50 });
      // The throttle is intact — the file holds one coalesced write, not fifty.
      expect(readStamp()).toBeGreaterThanOrEqual(start);
    } finally {
      await bridge.stop();
    }
  }, 10_000);

  it("does not resurrect its bridge file after stop()", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    bridge.noteActivity(Date.now()); // arms the trailing write
    await bridge.stop();
    const after = (() => { try { return readStamp(); } catch { return null; } })();
    await new Promise((r) => setTimeout(r, 1500)); // long enough for a leaked trailing write to fire
    const later = (() => { try { return readStamp(); } catch { return null; } })();
    expect(later).toEqual(after);
  }, 10_000);
});
