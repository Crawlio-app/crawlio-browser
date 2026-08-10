import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";

// Relocate the port range BEFORE constants.ts is evaluated. A plain top-level assignment
// does not work here: ES imports are hoisted, so WS_PORT is already read by the time it
// runs — which is how these "isolated" suites ended up binding the production range.
vi.hoisted(() => { process.env.CRAWLIO_WS_PORT = "19333"; });


// BRIDGE_DIR is derived from homedir() at module load, so redirect HOME onto a
// temp directory BEFORE importing the bridge. Without this the suite writes
// into the developer's real ~/.crawlio/bridges.
const fakeHome = mkdtempSync(join(tmpdir(), "crawlio-bridge-test-"));
process.env.HOME = fakeHome;
// Bind away from the production range (9333-9342): a live crawlio-browser on
// this machine would otherwise race these bridges for slots (EADDRINUSE flake).

const { WebSocketBridge } = await import("../src/mcp-server/websocket-bridge.js");

const EXT_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WS_CLOSE_BRIDGE_BUSY = 4009;

/**
 * Regression cover for the bridge livelock.
 *
 * `wss.on("connection")` used to terminate whatever client held the bridge, on
 * every new connection. Eviction is there so an extension whose transport died
 * can reclaim the session — but applied to a *healthy* incumbent it is
 * symmetric, so with more than one legitimate client (several Chrome profiles,
 * or a Web Store build alongside an unpacked dev build) each victim reconnects
 * and evicts whoever replaced it. Observed in the field: 211,042 evictions and
 * a 67 MB unrotated server.err.
 */
describe("WebSocketBridge client contention", () => {
  const bridges: InstanceType<typeof WebSocketBridge>[] = [];
  const sockets: WebSocket[] = [];

  async function startBridge() {
    const bridge = new WebSocketBridge();
    await bridge.start();
    bridges.push(bridge);
    return bridge;
  }

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: EXT_ORIGIN },
      });
      sockets.push(ws);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  /** Resolves with the close code, or null if the socket is still open. */
  function closeCodeWithin(ws: WebSocket, ms: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    for (const bridge of bridges.splice(0)) {
      try { await bridge.stop(); } catch { /* already stopped */ }
    }
  });

  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("refuses a second client instead of evicting a live one", async () => {
    const bridge = await startBridge();
    const first = await connect(bridge.port);

    const second = await connect(bridge.port);
    const secondClosed = await closeCodeWithin(second, 2_000);

    // The newcomer is turned away with the busy code...
    expect(secondClosed).toBe(WS_CLOSE_BRIDGE_BUSY);
    // ...and the incumbent is untouched. Before the fix it was terminated here,
    // which is the step that made eviction symmetric.
    expect(first.readyState).toBe(WebSocket.OPEN);
  });

  it("does not evict across repeated contention — the livelock cannot start", async () => {
    const bridge = await startBridge();
    const incumbent = await connect(bridge.port);

    let incumbentClosed = false;
    incumbent.once("close", () => { incumbentClosed = true; });

    // Six instances is what was actually installed when this was found.
    for (let i = 0; i < 6; i++) {
      const challenger = await connect(bridge.port);
      const code = await closeCodeWithin(challenger, 2_000);
      expect(code).toBe(WS_CLOSE_BRIDGE_BUSY);
    }

    expect(incumbentClosed).toBe(false);
    expect(incumbent.readyState).toBe(WebSocket.OPEN);
  });

  it("still lets the first client take the bridge", async () => {
    const bridge = await startBridge();
    const only = await connect(bridge.port);
    expect(await closeCodeWithin(only, 500)).toBeNull();
    expect(only.readyState).toBe(WebSocket.OPEN);
  });

  it("degrades cleanly when the complete ten-port range is occupied", async () => {
    const blockers: Server[] = [];
    const listen = (server: Server, port: number) => new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    try {
      for (let port = 19333; port <= 19342; port++) {
        const blocker = createServer((_request, response) => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ service: "foreign-test-server" }));
        });
        await listen(blocker, port);
        blockers.push(blocker);
      }

      const bridge = new WebSocketBridge();
      await expect(bridge.start()).resolves.toBeUndefined();
      bridges.push(bridge);
      expect(bridge.isConnected).toBe(false);
      expect(blockers.every((server) => server.listening)).toBe(true);
    } finally {
      await Promise.all(blockers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
});
