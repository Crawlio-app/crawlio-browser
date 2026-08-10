import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketBridge } from "../../src/mcp-server/websocket-bridge.js";
import { BRIDGE_DIR } from "../../src/shared/constants.js";
import {
  evaluateServerTrust,
  randomNonce,
  verifyHandshakeProof,
  HANDSHAKE_MESSAGE_TYPES,
} from "../../src/shared/bridge-handshake.js";

// Relocate the port range BEFORE constants.ts is evaluated. A plain top-level assignment
// does not work here: ES imports are hoisted, so WS_PORT is already read by the time it
// runs — which is how these "isolated" suites ended up binding the production range.
vi.hoisted(() => { process.env.CRAWLIO_WS_PORT = "19844"; });


/**
 * The first browser call after every MCP reconnect died with "Queued command timed out".
 *
 * Two independent orderings put a command in front of the identity proof, and the extension
 * refuses — silently — anything that arrives while its verdict is still pending:
 *
 *  1. The server released the offline queue from the `connection` and `connected` handlers, both
 *     synchronous, while the proof is answered from an async crypto promise. The queued command
 *     therefore reached the wire first, every time. Not a race — an ordering.
 *  2. Even with the proof sent first, the extension verifies it through an `await`, so its
 *     handler yields and the next frame is judged while `verified` is still false.
 *
 * Nothing errored anywhere, so nothing retried: the caller simply waited out its whole timeout
 * for a command that had been dropped on the floor.
 */
describe("queued commands vs. the identity handshake", () => {
  const workerGeneration = { id: "test-worker", startedAt: 1 };
  const profileId = "00000000-0000-4000-8000-000000000001";
  const bridgeToken = () =>
    JSON.parse(readFileSync(join(BRIDGE_DIR, `${process.pid}.json`), "utf8")).token as string;

  it("puts the identity proof on the wire ahead of any queued command", async () => {
    // The server-side invariant on its own — asserted against frame order, with no model of what
    // the extension does with them.
    const bridge = new WebSocketBridge();
    await bridge.start();
    let ws: WebSocket | undefined;

    try {
      const frames: string[] = [];
      // Offline, so this parks on the queue instead of transmitting. Left unanswered on purpose.
      const inFlight = bridge.send({ type: "list_tabs" } as never, 2000).catch(() => "rejected");

      ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });
      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "connected", extensionId: "testextensionidaaaaaaaaaaaaaaaa", profileId, workerGeneration }));
        ws!.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce: randomNonce() }));
      });
      ws.on("message", (raw) => frames.push(String(JSON.parse(raw.toString()).type)));

      await inFlight;
      // Housekeeping frames (permission refresh, heartbeat) may be interleaved; what matters is
      // that the command never overtakes the proof.
      expect(frames).toContain("list_tabs");
      expect(frames.indexOf(HANDSHAKE_MESSAGE_TYPES.handshake)).toBeGreaterThan(-1);
      expect(frames.indexOf(HANDSHAKE_MESSAGE_TYPES.handshake)).toBeLessThan(frames.indexOf("list_tabs"));
    } finally {
      ws?.close();
      await bridge.stop();
    }
  }, 15_000);

  it("keeps queued work off a profileless reload generation until its profile resolves", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    let ws: WebSocket | undefined;

    try {
      const frames: string[] = [];
      const inFlight = bridge.send({ type: "list_tabs" } as never, 4000);
      const nonce = randomNonce();
      let resolveProof!: () => void;
      const proofSeen = new Promise<void>((resolve) => { resolveProof = resolve; });

      ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });
      ws.on("open", () => {
        ws!.send(JSON.stringify({
          type: "connected",
          extensionId: "testextensionidaaaaaaaaaaaaaaaa",
          workerGeneration,
        }));
        ws!.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce }));
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(String(msg.type));
        if (msg.type === HANDSHAKE_MESSAGE_TYPES.handshake) resolveProof();
        if (msg.type === "list_tabs") {
          ws!.send(JSON.stringify({ id: msg.id, type: "response", success: true, data: { tabs: [] } }));
        }
      });

      await proofSeen;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(frames).not.toContain("list_tabs");

      ws.send(JSON.stringify({
        type: "connected",
        extensionId: "testextensionidaaaaaaaaaaaaaaaa",
        profileId,
        workerGeneration,
      }));
      await expect(inFlight).resolves.toEqual({ tabs: [] });
      expect(frames).toContain("list_tabs");
    } finally {
      ws?.close();
      await bridge.stop();
    }
  }, 15_000);

  it("keeps a modern client's first command queued until that client accepts the proof", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    let ws: WebSocket | undefined;

    try {
      const nonce = randomNonce();
      const frames: string[] = [];
      const inFlight = bridge.send({ type: "list_tabs" } as never, 4000);

      ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });
      const proofSeen = new Promise<void>((resolveProof) => {
        ws!.on("open", () => {
          ws!.send(JSON.stringify({
            type: "connected",
            extensionId: "testextensionidaaaaaaaaaaaaaaaa",
            handshakeAck: true,
            profileId,
            workerGeneration,
          }));
          ws!.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce }));
        });
        ws!.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          frames.push(String(msg.type));
          if (msg.type === HANDSHAKE_MESSAGE_TYPES.handshake) resolveProof();
          if (msg.type === "list_tabs") {
            ws!.send(JSON.stringify({ id: msg.id, type: "response", success: true, data: { tabs: [] } }));
          }
        });
      });

      await proofSeen;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(frames).not.toContain("list_tabs");

      ws.send(JSON.stringify({
        type: HANDSHAKE_MESSAGE_TYPES.accepted,
        nonce,
        accepted: true,
      }));
      await expect(inFlight).resolves.toEqual({ tabs: [] });
      expect(frames).toContain("list_tabs");
    } finally {
      ws?.close();
      await bridge.stop();
    }
  }, 15_000);

  it("retains queued work when a stale-token client rejects the proof, then drains after reconnect", async () => {
    const bridge = new WebSocketBridge();
    await bridge.start();
    let stale: WebSocket | undefined;
    let replacement: WebSocket | undefined;

    const connectModern = (nonce: string, accepted: boolean, answerCommands: boolean) => {
      const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });
      const closed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
      const ready = new Promise<void>((resolveReady) => {
        socket.on("open", () => {
          socket.send(JSON.stringify({
            type: "connected",
            extensionId: "testextensionidaaaaaaaaaaaaaaaa",
            handshakeAck: true,
            profileId,
            workerGeneration,
          }));
          socket.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce }));
        });
        socket.on("message", (raw) => {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === HANDSHAKE_MESSAGE_TYPES.handshake) {
            socket.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.accepted, nonce, accepted }));
            resolveReady();
            if (!accepted) socket.close();
          } else if (answerCommands && msg.type === "list_tabs") {
            socket.send(JSON.stringify({ id: msg.id, type: "response", success: true, data: { tabs: [] } }));
          }
        });
      });
      return { socket, ready, closed };
    };

    try {
      const inFlight = bridge.send({ type: "list_tabs" } as never, 4000);
      const first = connectModern(randomNonce(), false, false);
      stale = first.socket;
      await first.ready;
      await first.closed;

      const stillQueued = await Promise.race([
        inFlight.then(() => false, () => false),
        new Promise<boolean>((resolveDelay) => setTimeout(() => resolveDelay(true), 100)),
      ]);
      expect(stillQueued).toBe(true);

      const second = connectModern(randomNonce(), true, true);
      replacement = second.socket;
      await second.ready;
      await expect(inFlight).resolves.toEqual({ tabs: [] });
    } finally {
      stale?.close();
      replacement?.close();
      await bridge.stop();
    }
  }, 15_000);

  it("answers a command queued before the extension connects", async () => {
    // End to end, against a client that reproduces background.ts's message loop: the same trust
    // function, the same async verify, and the same discipline of waiting for a pending verdict
    // rather than dropping what arrived ahead of it.
    const bridge = new WebSocketBridge();
    await bridge.start();
    const port = bridge.port;
    const token = bridgeToken();

    const refused: string[] = [];
    const executed: string[] = [];
    let ws: WebSocket | undefined;

    try {
      const inFlight = bridge.send({ type: "list_tabs" } as never, 4000);

      const nonce = randomNonce();
      let verified = false;
      let verdict: Promise<void> | null = null;

      ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });

      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "connected", extensionId: "testextensionidaaaaaaaaaaaaaaaa", profileId, workerGeneration }));
        ws!.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce }));
      });

      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

        if (msg.type === HANDSHAKE_MESSAGE_TYPES.handshake) {
          verdict = verifyHandshakeProof(token, nonce, port, msg.proof as string).then((ok) => {
            verified = ok;
          });
          await verdict;
          return;
        }

        // A trusted token is held, so an unverified server is refused — but only once there is
        // actually a verdict to refuse on.
        if (!verified && verdict) await verdict;
        if (evaluateServerTrust(true, verified) === "refuse") {
          refused.push(String(msg.type));
          return;
        }

        executed.push(String(msg.type));
        ws!.send(JSON.stringify({ id: msg.id, type: "response", success: true, data: { tabs: [] } }));
      });

      await expect(inFlight).resolves.toEqual({ tabs: [] });
      // check_permissions rides along as connection housekeeping; what matters is that the queued
      // command was executed rather than refused.
      expect(executed).toContain("list_tabs");
      expect(refused).toEqual([]);
    } finally {
      ws?.close();
      await bridge.stop();
    }
  }, 15_000);

  it("holds a drained command to the caller's deadline, not a flat 30s", async () => {
    // Draining stamped TIMEOUTS.WS_COMMAND on the pending timer, discarding what the caller
    // asked for: a send(cmd, 2000) that took the queue path could hang for half a minute.
    const bridge = new WebSocketBridge();
    await bridge.start();
    let ws: WebSocket | undefined;

    try {
      const started = Date.now();
      const inFlight = bridge.send({ type: "list_tabs" } as never, 2000);

      ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
        headers: { origin: "chrome-extension://testextensionidaaaaaaaaaaaaaaaa" },
      });
      ws.on("open", () => {
        ws!.send(JSON.stringify({ type: "connected", extensionId: "testextensionidaaaaaaaaaaaaaaaa", profileId, workerGeneration }));
        ws!.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce: randomNonce() }));
      });
      // Never answers, so the pending timer is what ends this.

      await expect(inFlight).rejects.toThrow(/timed out/i);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      ws?.close();
      await bridge.stop();
    }
  }, 20_000);
});

/**
 * background.ts is a browser IIFE bundle and cannot be imported under vitest, so the extension
 * half is asserted structurally — the same approach as idle-release-wiring. These catch the
 * regression that matters: deleting the wait, or leaving a parked command with no way to wake.
 */
describe("extension: a pending verdict is not a refusal", () => {
  const SOURCE = readFileSync(resolve(__dirname, "../../src/extension/background.ts"), "utf8");

  it("waits for the verdict before judging a command", () => {
    const gate = SOURCE.indexOf("const decision = evaluateServerTrust(trustedBridgeToken !== null");
    expect(gate).toBeGreaterThan(-1);
    // The wait has to come first — after the refusal it would be dead code.
    const wait = SOURCE.lastIndexOf("await awaitHandshakeVerdict(port)", gate);
    expect(wait).toBeGreaterThan(-1);
    expect(gate - wait).toBeLessThan(400); // same guard, not some unrelated earlier call
  });

  it("wakes parked commands wherever trust state is torn down", () => {
    // Both teardown sites delete from wsBridges BEFORE the socket closes, which makes onclose's
    // `wasTracked` guard false — so neither is covered by the close path, and a parked command
    // would sit out the whole handshake window waiting on a socket that is already gone.
    const SRC = readFileSync(resolve(__dirname, "../../src/extension/background.ts"), "utf8");
    for (const teardown of ["bridgeTrust.delete(previousPort)", "bridgeTrust.clear()"]) {
      const at = SRC.indexOf(teardown);
      expect(at, `${teardown} not found`).toBeGreaterThan(-1);
      const before = SRC.slice(Math.max(0, at - 600), at);
      expect(before, `${teardown} discards waiters without waking them`).toMatch(/releaseHandshakeWaiters\(/);
    }
  });

  it("wakes parked commands on every path the verdict can take", () => {
    // Verified, refused-on-timeout, and socket-closed. A missed one strands a command for the
    // whole handshake window.
    expect(SOURCE.split("releaseHandshakeWaiters(port)").length - 1).toBeGreaterThanOrEqual(3);
    const closed = SOURCE.indexOf("releaseHandshakeWaiters(port); // socket is gone");
    expect(closed).toBeGreaterThan(-1);
  });

  it("does not let a zombie same-port close demote the tracked replacement", () => {
    // A replacement may open before the old socket's delayed onclose fires. `activeBridgePort`
    // names only the port, so it must be cleared under the same socket-identity guard as the
    // per-port trust state; otherwise the old close makes the live replacement look disconnected.
    expect(SOURCE).toContain("if (wasTracked && activeBridgePort === port) activeBridgePort = null");
  });

  it("bounds what a rogue server can park", () => {
    expect(SOURCE).toContain("MAX_HANDSHAKE_WAITERS");
    expect(SOURCE).toMatch(/waiters\.length >= MAX_HANDSHAKE_WAITERS/);
  });

  it("advertises and returns the nonce-bound handshake acknowledgement", () => {
    expect(SOURCE).toContain("handshakeAck: true");
    expect(SOURCE).toContain("type: HANDSHAKE_MESSAGE_TYPES.accepted");
    expect(SOURCE).toContain("nonce: trust.nonce");
  });
});
