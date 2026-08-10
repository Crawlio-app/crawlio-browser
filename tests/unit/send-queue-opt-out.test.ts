import { describe, it, expect } from "vitest";
import { WebSocketBridge } from "../../src/mcp-server/websocket-bridge.js";

/**
 * `send()` queues when the extension is offline, with a 45s floor, so a command issued while the
 * service worker restarts is not lost. That is right for work and wrong for a probe.
 *
 * Two probes run on every `execute` — get_connection_status for the smart-object cache key, and
 * detect_framework to decide which namespaces to attach. Both already degrade in a catch. With no
 * browser attached they queued anyway, so `execute` blocked before returning a result it could
 * have produced immediately: measured at over 80 seconds against a real server, 4ms after this.
 *
 * These never call start(). A bridge that has not started has no client, which is exactly the
 * "offline" state under test — and starting one bound a real port, which collided with the
 * production range under parallel test files and made this file fail only in a full run.
 */
describe("send({ queueWhenOffline: false })", () => {
  const offline = () => new WebSocketBridge();

  it("should reject at once instead of queueing", async () => {
    const b = offline();
    expect(b.isConnected).toBe(false);
    const started = Date.now();
    await expect(
      b.send({ type: "detect_framework" }, 5000, { queueWhenOffline: false }),
    ).rejects.toThrow(/not connected/i);
    expect(Date.now() - started).toBeLessThan(250);
    expect(b.queueDepth, "a refused probe must not occupy the queue").toBe(0);
  });

  it("should still queue by default, so work survives a reconnect", async () => {
    // The property this must not break: a command issued while the extension restarts waits for
    // it rather than failing. Not awaited — the queue floor is 45s and nothing will drain it.
    const b = offline();
    void b.send({ type: "capture_page" }, 1000).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(b.queueDepth).toBe(1);
  });

  it("should queue when the option is explicitly true", async () => {
    const b = offline();
    void b.send({ type: "capture_page" }, 1000, { queueWhenOffline: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(b.queueDepth).toBe(1);
  });

  it("should carry a problem code a caller can branch on", async () => {
    const err = await offline()
      .send({ type: "detect_framework" }, 5000, { queueWhenOffline: false })
      .then(() => null)
      .catch((e) => e as Error & { problem?: string });
    expect(err).toBeTruthy();
    expect(err!.problem).toBe("not_connected");
  });

  it("should not let many refused probes accumulate anywhere", async () => {
    // A client polling in a loop used to enqueue one status probe per poll, evicting real work
    // from a bounded queue with its own telemetry.
    const b = offline();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        b.send({ type: "get_connection_status" }, 3000, { queueWhenOffline: false }).catch(() => {}),
      ),
    );
    expect(b.queueDepth).toBe(0);
  });
});
