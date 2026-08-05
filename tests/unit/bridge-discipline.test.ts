import { describe, expect, it, vi } from "vitest";
import { BridgeRetryGate, SingletonConnection, closeFailedHandshake, safeWebSocketSend, electActiveBridge, planBridgeConnections } from "../../src/extension/bridge-discipline.js";

describe("BridgeRetryGate", () => {
  it("throttles starts within the retry interval", () => {
    const gate = new BridgeRetryGate(1500);
    expect(gate.reserve(1000)).toBe(0);
    expect(gate.reserve(1200)).toBe(1300);
    expect(gate.reserve(2500)).toBe(0);
  });

  it("resets after explicit user action", () => {
    const gate = new BridgeRetryGate(1500);
    expect(gate.reserve(1000)).toBe(0);
    gate.reset();
    expect(gate.reserve(1100)).toBe(0);
  });
});

describe("SingletonConnection", () => {
  it("coalesces 100 concurrent callers into one connection", async () => {
    const dispose = vi.fn();
    const onAdopt = vi.fn();
    const owner = new SingletonConnection<object>(dispose, onAdopt);
    const connection = {};
    const factory = vi.fn(async () => {
      await Promise.resolve();
      return connection;
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => owner.connect(factory))
    );

    expect(factory).toHaveBeenCalledTimes(1);
    expect(results.every(result => result === connection)).toBe(true);
    expect(owner.current).toBe(connection);
    expect(dispose).not.toHaveBeenCalled();
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledWith(connection);
  });

  it("reuses an established connection without invoking the factory", async () => {
    const owner = new SingletonConnection<object>(() => {});
    const connection = {};
    await owner.connect(async () => connection);
    const secondFactory = vi.fn(async () => ({}));

    expect(await owner.connect(secondFactory)).toBe(connection);
    expect(secondFactory).not.toHaveBeenCalled();
  });

  it("does not let a stale disconnect clear a replacement", async () => {
    const owner = new SingletonConnection<object>(() => {});
    const first = {};
    const second = {};
    await owner.connect(async () => first);
    owner.reset();
    await owner.connect(async () => second);

    expect(owner.clearIfCurrent(first)).toBe(false);
    expect(owner.current).toBe(second);
    expect(owner.clearIfCurrent(second)).toBe(true);
    expect(owner.current).toBeNull();
  });

  it("disposes a candidate that resolves after reset", async () => {
    const disposed: object[] = [];
    const owner = new SingletonConnection<object>(value => disposed.push(value));
    const late = {};
    let resolveFactory: ((value: object) => void) | undefined;
    const pending = owner.connect(() => new Promise(resolve => { resolveFactory = resolve; }));

    owner.reset();
    resolveFactory?.(late);

    expect(await pending).toBeNull();
    expect(disposed).toEqual([late]);
    expect(owner.current).toBeNull();
  });
});

describe("safeWebSocketSend", () => {
  it("does not send to closed sockets", () => {
    const socket = { readyState: 3, send: vi.fn() } as unknown as WebSocket;
    expect(safeWebSocketSend(socket, "{}")).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("catches send failures", () => {
    const socket = { readyState: 1, send: vi.fn(() => { throw new Error("closed"); }) } as unknown as WebSocket;
    expect(safeWebSocketSend(socket, "{}")).toBe(false);
  });
});

describe("closeFailedHandshake", () => {
  it("closes with a bounded reason", () => {
    const close = vi.fn();
    const socket = { close } as unknown as WebSocket;
    closeFailedHandshake(socket, "x".repeat(200));
    expect(close).toHaveBeenCalledWith(1011, "x".repeat(123));
  });
});

describe("electActiveBridge", () => {
  it("returns null when there are no live bridges", () => {
    expect(electActiveBridge([], null)).toBeNull();
    expect(electActiveBridge([], 9333)).toBeNull();
  });

  it("returns the only live bridge", () => {
    expect(electActiveBridge([{ port: 9337, lastActivityAt: 5 }], null)).toBe(9337);
  });

  it("picks the most recently active bridge", () => {
    const probes = [
      { port: 9333, lastActivityAt: 100 },
      { port: 9334, lastActivityAt: 300 },
      { port: 9335, lastActivityAt: 200 },
    ];
    expect(electActiveBridge(probes, null)).toBe(9334);
  });

  it("sticks to the current active port on a tie for the max (anti-flap)", () => {
    const probes = [
      { port: 9333, lastActivityAt: 500 },
      { port: 9334, lastActivityAt: 500 },
    ];
    expect(electActiveBridge(probes, 9334)).toBe(9334);
  });

  it("breaks a tie by lowest port when the current active is not in the tied set", () => {
    const probes = [
      { port: 9335, lastActivityAt: 500 },
      { port: 9334, lastActivityAt: 500 },
    ];
    // current active (9333) is gone, so deterministic lowest of the tied set wins
    expect(electActiveBridge(probes, 9333)).toBe(9334);
  });

  it("falls back to the lowest port when every bridge reports zero activity (pre-rollout)", () => {
    const probes = [
      { port: 9335, lastActivityAt: 0 },
      { port: 9333, lastActivityAt: 0 },
      { port: 9334, lastActivityAt: 0 },
    ];
    expect(electActiveBridge(probes, null)).toBe(9333);
  });
});

// The connection plan is the rogue-cutover defense: routing is always single, but WHICH
// sockets we open determines whether a rogue forging a high lastActivityAt can hijack or
// DoS the real bridge. TOFU = single-bridge election (storm fix); token mode = never let a
// forged-activity rogue displace a verified bridge, but DO fan out to find the real one when
// none is verified yet.
describe("planBridgeConnections (election hardening)", () => {
  const rogue = { port: 9333, lastActivityAt: 9_999_999_999 }; // forged max activity
  const real = { port: 9334, lastActivityAt: 100 };

  it("TOFU: elects a single bridge by activity (the rogue would win — covered by consent, not this layer)", () => {
    expect(planBridgeConnections([rogue, real], {
      hasToken: false, activePort: null, activeIsOpen: false, activeVerified: false,
    })).toEqual([9333]);
  });

  it("TOFU: returns [] when no bridges are live", () => {
    expect(planBridgeConnections([], {
      hasToken: false, activePort: null, activeIsOpen: false, activeVerified: false,
    })).toEqual([]);
  });

  it("token + verified incumbent alive: connects to NOTHING — a forged-activity rogue can't trigger a cutover (anti-DoS)", () => {
    expect(planBridgeConnections([rogue, real], {
      hasToken: true, activePort: 9334, activeIsOpen: true, activeVerified: true,
    })).toEqual([]);
  });

  it("token + NO verified bridge yet (cold start): fans out to ALL live candidates so the handshake can find the real one despite the rogue", () => {
    expect(planBridgeConnections([rogue, real], {
      hasToken: true, activePort: null, activeIsOpen: false, activeVerified: false,
    })).toEqual([9333, 9334]);
  });

  it("token + active-but-UNVERIFIED (e.g. rogue won cold-start election): still fans out so the real bridge gets a chance to verify", () => {
    expect(planBridgeConnections([rogue, real], {
      hasToken: true, activePort: 9333, activeIsOpen: true, activeVerified: false,
    })).toEqual([9333, 9334]);
  });

  it("token + active verified but its socket dropped (not open): re-fans out to reconverge", () => {
    expect(planBridgeConnections([rogue, real], {
      hasToken: true, activePort: 9334, activeIsOpen: false, activeVerified: true,
    })).toEqual([9333, 9334]);
  });
});
