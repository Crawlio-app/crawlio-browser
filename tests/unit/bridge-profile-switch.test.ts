// Port-isolated before importing anything that reads WS_PORT: the production range is 9333-9342,
// and a test that binds it would fight the developer's own running bridge.

import { describe, expect, it, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocketBridge } from "../../src/mcp-server/websocket-bridge.js";
import { HANDSHAKE_MESSAGE_TYPES } from "../../src/shared/bridge-handshake.js";
import type { WorkerGeneration } from "../../src/shared/worker-generation.js";

// Relocate the port range BEFORE constants.ts is evaluated. A plain top-level assignment
// does not work here: ES imports are hoisted, so WS_PORT is already read by the time it
// runs — which is how these "isolated" suites ended up binding the production range.
vi.hoisted(() => { process.env.CRAWLIO_WS_PORT = "19533"; });


const UUID_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const UUID_B = "f0e9d8c7-b6a5-4948-9a3b-2c1d0e9f8a7b";
const EXT_ORIGIN = "chrome-extension://testextensionidaaaaaaaaaaaaaaaa";

/** Connect a fake extension and identify as `profileId`, resolving once the server has seen it. */
async function connectAs(port: number, profileId: string | null, workerGeneration?: WorkerGeneration): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
    ws.on("open", () => { clearTimeout(timer); resolve(); });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
  ws.send(JSON.stringify({
    type: "connected",
    extensionId: "ext-test",
    ...(profileId ? { profileId } : {}),
    ...(workerGeneration ? { workerGeneration } : {}),
  }));
  // The server handles `connected` synchronously on receipt; one turn is enough for it to land.
  await new Promise((r) => setTimeout(r, 60));
  return ws;
}

const closed = (ws: WebSocket) =>
  new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on("close", () => resolve());
  });

describe("profile switching over the wire", () => {
  let bridge: WebSocketBridge | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } }
    sockets.length = 0;
    if (bridge) { await bridge.stop(); bridge = null; }
  });

  async function startBridge(): Promise<{ bridge: WebSocketBridge; port: number }> {
    bridge = new WebSocketBridge();
    await bridge.start();
    return { bridge, port: bridge.port };
  }

  it("should fail an in-flight command when a different profile takes the bridge", async () => {
    // A disconnect holds pending commands through the reconnect grace, betting the same browser
    // returns to answer them. With two Chrome profiles competing for one bridge that bet fails:
    // the command went to A, A's socket died, B took over, and B never saw it — so the caller sat
    // out its entire timeout waiting for an answer that could not arrive.
    const { bridge: b, port } = await startBridge();
    const a = await connectAs(port, UUID_A);
    sockets.push(a);
    // connectAs never sends an identity challenge, so transmission is held until the handshake
    // settle grace elapses. Wait it out — this command has to be TRANSMITTED (in `pending`) for
    // the takeover to orphan it; a queued one would simply drain to whoever connects next.
    await new Promise((r) => setTimeout(r, 2300));

    const inFlight = b.send({ type: "capture_page" }, 25_000).catch((e: Error) => ({ _error: e.message }));
    await new Promise((r) => setTimeout(r, 80));
    expect(b.queueDepth, "transmitted, so it is pending rather than queued").toBe(0);

    a.close();
    await closed(a);

    const started = Date.now();
    const bSock = await connectAs(port, UUID_B); // a DIFFERENT browser takes the bridge
    sockets.push(bSock);

    const outcome = await inFlight as { _error?: string };
    expect(outcome._error, "the caller is told, rather than left waiting").toMatch(/different Chrome profile/i);
    expect(Date.now() - started, "and told promptly, not after the command's own timeout").toBeLessThan(5000);
  });

  it("should keep an in-flight command when the SAME profile reconnects", async () => {
    // The grace period's original bet, which must survive the fix above: a bouncing extension
    // still gets to answer what it was already sent.
    const { bridge: b, port } = await startBridge();
    const a1 = await connectAs(port, UUID_A);
    sockets.push(a1);
    await new Promise((r) => setTimeout(r, 2300)); // as above: let transmission unblock

    const inFlight = b.send({ type: "capture_page" }, 6000).catch((e: Error) => ({ _error: e.message }));
    await new Promise((r) => setTimeout(r, 80));

    a1.close();
    await closed(a1);
    const a2 = await connectAs(port, UUID_A); // same browser back
    sockets.push(a2);

    await new Promise((r) => setTimeout(r, 200));
    const outcome = await Promise.race([inFlight, new Promise((r) => setTimeout(() => r("still-waiting"), 300))]);
    expect(outcome, "same profile — the command is still owed an answer").toBe("still-waiting");
    a2.close();
  });

  it("should report no profiles before an extension identifies", async () => {
    const { bridge: b } = await startBridge();
    expect(b.listProfiles()).toEqual({ connected: null, preferred: null, seen: [] });
  });

  it("should record the profile an extension reports and mark it connected", async () => {
    const { bridge: b, port } = await startBridge();
    sockets.push(await connectAs(port, UUID_A));

    const { connected, preferred, seen } = b.listProfiles();
    expect(connected).toBe(UUID_A);
    expect(preferred).toBeNull();
    expect(seen.map((p) => p.profileId)).toEqual([UUID_A]);
  });

  it("should stay unidentified for an extension that reports no profile", async () => {
    // An older extension must keep working exactly as before, not be locked out.
    const { bridge: b, port } = await startBridge();
    sockets.push(await connectAs(port, null));

    expect(b.isConnected).toBe(true);
    expect(b.listProfiles().connected).toBeNull();
  });

  it("should adopt the profile from a later message when the first arrived unidentified", async () => {
    // On a fresh install the extension may connect before its stored profile id resolves. It
    // re-identifies once the id lands; without that the profile would stay invisible to
    // list_profiles — and unswitchable — for the rest of the session.
    const { bridge: b, port } = await startBridge();
    const ws = await connectAs(port, null);
    sockets.push(ws);
    expect(b.listProfiles().connected).toBeNull();

    ws.send(JSON.stringify({ type: "connected", extensionId: "ext-test", profileId: UUID_A }));
    await new Promise((r) => setTimeout(r, 60));

    expect(b.listProfiles().connected).toBe(UUID_A);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("should ignore a profileId that is not a well-formed id", async () => {
    // A malformed id must not enter the roster, or switch_profile would offer a target that no
    // extension can ever match.
    const { bridge: b, port } = await startBridge();
    sockets.push(await connectAs(port, "../../etc/passwd"));

    expect(b.listProfiles()).toMatchObject({ connected: null, seen: [] });
  });

  it("should refuse switching to a profile that has never connected", async () => {
    // Honouring it would pin the bridge to a profile no extension can satisfy, leaving the agent
    // with a connection that refuses every extension including the one that was working.
    const { bridge: b, port } = await startBridge();
    sockets.push(await connectAs(port, UUID_A));

    const result = b.switchProfile(UUID_B);
    expect(result.switched).toBe(false);
    expect(result.reason).toMatch(/has not connected/);
    expect(b.listProfiles().preferred).toBeNull();
    expect(b.isConnected).toBe(true);
  });

  it("should refuse a malformed profile id", async () => {
    const { bridge: b } = await startBridge();
    const result = b.switchProfile("not-a-uuid");
    expect(result.switched).toBe(false);
    expect(result.reason).toMatch(/not a profile id/);
  });

  it("should be a no-op when switching to the profile already connected", async () => {
    const { bridge: b, port } = await startBridge();
    const ws = await connectAs(port, UUID_A);
    sockets.push(ws);

    expect(b.switchProfile(UUID_A)).toEqual({ switched: true });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(b.listProfiles().preferred).toBe(UUID_A);
  });

  it("should release the current extension when switching to another known profile", async () => {
    const { bridge: b, port } = await startBridge();

    // Profile B connects first and is seen, then drops; A takes the bridge.
    const first = await connectAs(port, UUID_B);
    first.close();
    await closed(first);
    const second = await connectAs(port, UUID_A);
    sockets.push(second);
    expect(b.listProfiles().connected).toBe(UUID_A);

    expect(b.switchProfile(UUID_B)).toEqual({ switched: true });
    await closed(second);

    // The socket is released so B's extension can take it on its next reconnect attempt; the
    // preference is what makes that attempt win.
    expect(b.listProfiles().preferred).toBe(UUID_B);
    expect(b.isConnected).toBe(false);
  });

  it("should refuse an extension from a profile other than the preferred one", async () => {
    const { bridge: b, port } = await startBridge();
    const first = await connectAs(port, UUID_B);
    first.close();
    await closed(first);

    b.switchProfile(UUID_B);
    const wrong = await connectAs(port, UUID_A);
    await closed(wrong);
    expect(b.listProfiles().connected).toBeNull();
  });

  it("should accept the preferred profile when it connects", async () => {
    const { bridge: b, port } = await startBridge();
    const first = await connectAs(port, UUID_B);
    first.close();
    await closed(first);

    b.switchProfile(UUID_B);
    const right = await connectAs(port, UUID_B);
    sockets.push(right);

    expect(right.readyState).toBe(WebSocket.OPEN);
    expect(b.listProfiles().connected).toBe(UUID_B);
  });

  it("should restore first-come when the preference is cleared", async () => {
    const { bridge: b, port } = await startBridge();
    const first = await connectAs(port, UUID_B);
    first.close();
    await closed(first);
    b.switchProfile(UUID_B);

    expect(b.switchProfile(null)).toEqual({ switched: true });
    expect(b.listProfiles().preferred).toBeNull();

    const any = await connectAs(port, UUID_A);
    sockets.push(any);
    expect(any.readyState).toBe(WebSocket.OPEN);
    expect(b.listProfiles().connected).toBe(UUID_A);
  });

  it("should not transmit queued commands to a profile the agent did not choose", async () => {
    // The defect this covers: the queue drained in the connection handler, before `connected`
    // said which profile the socket was. Commands queued for B were transmitted to, and executed
    // by, whichever extension reconnected first — and the response was attributed to B.
    const { bridge: b, port } = await startBridge();
    const seed = await connectAs(port, UUID_B);
    seed.close();
    await closed(seed);
    b.switchProfile(UUID_B);

    // Offline: this takes the queue lane.
    // Not awaited: the offline lane raises any timeout to a 45s floor, and this promise is
    // settled by afterEach's bridge.stop(), which rejects everything still queued.
    void b.send({ type: "capture_page" }, 2000).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(b.queueDepth).toBe(1);

    // The wrong profile connects and is released; it must never see the queued command.
    const wrong = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    const received: string[] = [];
    wrong.on("message", (raw) => received.push(raw.toString()));
    await new Promise<void>((resolve) => wrong.on("open", () => resolve()));
    wrong.send(JSON.stringify({ type: "connected", extensionId: "ext-test", profileId: UUID_A }));
    await closed(wrong);

    expect(received.filter((m) => m.includes("capture_page"))).toEqual([]);
    expect(b.queueDepth, "the command is still waiting for the right profile").toBe(1);
  });

  it("should hold the queue for a socket that never says which profile it is", async () => {
    // Otherwise the filter is defeated by simply omitting profileId: an anonymous client would
    // keep the bridge and receive everything queued for the chosen profile.
    const { bridge: b, port } = await startBridge();
    const seed = await connectAs(port, UUID_B);
    seed.close();
    await closed(seed);
    b.switchProfile(UUID_B);

    void b.send({ type: "capture_page" }, 2000).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    const anon = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    const received: string[] = [];
    anon.on("message", (raw) => received.push(raw.toString()));
    await new Promise<void>((resolve) => anon.on("open", () => resolve()));
    anon.send(JSON.stringify({ type: "connected", extensionId: "ext-test" }));
    await new Promise((r) => setTimeout(r, 150));

    expect(received.filter((m) => m.includes("capture_page"))).toEqual([]);
    expect(b.queueDepth, "still held for the chosen profile").toBe(1);
    try { anon.close(); } catch { /* may already be closed */ }
  });

  it("should release the queue once the chosen profile identifies", async () => {
    const { bridge: b, port } = await startBridge();
    const seed = await connectAs(port, UUID_B);
    seed.close();
    await closed(seed);
    b.switchProfile(UUID_B);

    const pending = b.send({ type: "capture_page" }, 4000).catch((e) => ({ _error: String(e) }));
    await new Promise((r) => setTimeout(r, 50));
    expect(b.queueDepth).toBe(1);

    const right = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    sockets.push(right);
    const received: string[] = [];
    right.on("message", (raw) => {
      received.push(raw.toString());
      const msg = JSON.parse(raw.toString());
      if (msg.type === "capture_page") {
        right.send(JSON.stringify({ type: "response", id: msg.id, success: true, data: "ok" }));
      }
    });
    await new Promise<void>((resolve) => right.on("open", () => resolve()));
    right.send(JSON.stringify({ type: "connected", extensionId: "ext-test", profileId: UUID_B }));

    expect(await pending).toBe("ok");
    expect(received.some((m) => m.includes("capture_page"))).toBe(true);
  });

  it("should record a profile it refuses, so the agent can switch to it", async () => {
    // ProfileRoster.disconnect is a no-op for an unknown id, so refusing before observing left no
    // trace — list_profiles never showed the profile and switch_profile called it unknown.
    const { bridge: b, port } = await startBridge();
    const seed = await connectAs(port, UUID_B);
    seed.close();
    await closed(seed);
    b.switchProfile(UUID_B);

    const other = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    await new Promise<void>((resolve) => other.on("open", () => resolve()));
    other.send(JSON.stringify({ type: "connected", extensionId: "ext-test", profileId: UUID_A }));
    await closed(other);

    expect(b.listProfiles().seen.map((p) => p.profileId)).toContain(UUID_A);
    expect(b.switchProfile(UUID_A)).toEqual({ switched: true });
  });

  it("should stop reporting a profile as connected once it disconnects", async () => {
    const { bridge: b, port } = await startBridge();
    const ws = await connectAs(port, UUID_A);
    expect(b.listProfiles().connected).toBe(UUID_A);

    ws.close();
    await closed(ws);
    await new Promise((r) => setTimeout(r, 50));

    const { connected, seen } = b.listProfiles();
    expect(connected).toBeNull();
    expect(seen.find((p) => p.profileId === UUID_A)?.connected).toBe(false);
  });

  it("should ignore a socket that tries to change which profile it claims", async () => {
    const { bridge: b, port } = await startBridge();
    const ws = await connectAs(port, UUID_A);
    sockets.push(ws);

    ws.send(JSON.stringify({ type: "connected", extensionId: "ext-test", profileId: UUID_B }));
    await new Promise((r) => setTimeout(r, 60));

    expect(b.listProfiles().connected).toBe(UUID_A);
    expect(b.listProfiles().seen.map((p) => p.profileId)).not.toContain(UUID_B);
  });

  it("should record a profile refused for contention, so it can be switched to", async () => {
    // With two Chrome profiles running, the second extension is refused at the socket by
    // contention and never reaches `connected` — so it never entered the roster. list_profiles
    // showed one profile and switch_profile called the other "has not connected", which is
    // exactly the profile you would want to switch to.
    const { bridge: b, port } = await startBridge();
    const incumbent = await connectAs(port, UUID_A);
    sockets.push(incumbent);
    expect(b.listProfiles().connected).toBe(UUID_A);

    // A second profile knocks while the first holds a healthy connection.
    const contender = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    await new Promise<void>((resolve) => contender.on("open", () => resolve()));
    contender.send(JSON.stringify({ type: "connected", extensionId: "ext-two", profileId: UUID_B }));
    await closed(contender);

    const { connected, seen } = b.listProfiles();
    expect(connected, "the incumbent keeps the bridge").toBe(UUID_A);
    expect(seen.map((p) => p.profileId).sort(), "both profiles are known").toEqual([UUID_A, UUID_B].sort());
    expect(seen.find((p) => p.profileId === UUID_B)?.connected, "the refused one is not driving").toBe(false);
    // And that is enough to switch to it.
    expect(b.switchProfile(UUID_B)).toEqual({ switched: true });
  });

  it("should keep the incumbent profile online when the same profile reloads and is refused", async () => {
    // Chrome can briefly leave the previous extension generation alive during an unpacked reload.
    // The contender is the same browser profile, so recording it as disconnected must not make
    // /health claim that the healthy incumbent disappeared.
    const { bridge: b, port } = await startBridge();
    const incumbent = await connectAs(port, UUID_A);
    sockets.push(incumbent);

    const contender = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    await new Promise<void>((resolve) => contender.on("open", () => resolve()));
    contender.send(JSON.stringify({ type: "connected", extensionId: "ext-test", profileId: UUID_A }));
    await closed(contender);

    const { connected, seen } = b.listProfiles();
    expect(connected).toBe(UUID_A);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.connected).toBe(true);
  });

  it("should let a newer worker generation reclaim its profile after an extension reload", async () => {
    const { bridge: b, port } = await startBridge();
    const incumbent = await connectAs(port, UUID_A);
    sockets.push(incumbent);

    const contender = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    await new Promise<void>((resolve) => contender.on("open", () => resolve()));
    const contenderClose = new Promise<number>((resolve) => contender.on("close", (code) => resolve(code)));
    const generation = { id: "new-worker", startedAt: Date.now() + 1 };
    contender.send(JSON.stringify({
      type: "connected",
      extensionId: "ext-test",
      profileId: UUID_A,
      workerGeneration: generation,
    }));

    await closed(incumbent);
    expect(await contenderClose).toBe(4010);

    const replacement = await connectAs(port, UUID_A, generation);
    sockets.push(replacement);
    expect(replacement.readyState).toBe(WebSocket.OPEN);
    expect(b.listProfiles().connected).toBe(UUID_A);
  });

  it("should close a refused client that never identifies", async () => {
    const { bridge: b, port } = await startBridge();
    sockets.push(await connectAs(port, UUID_A));

    const silent = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    await new Promise<void>((resolve) => silent.on("open", () => resolve()));
    await closed(silent); // the identify window expires and it is closed anyway
    expect(b.listProfiles().seen.map((p) => p.profileId)).toEqual([UUID_A]);
  });

  it("should not let a refused client issue commands during its identify window", async () => {
    const { bridge: b, port } = await startBridge();
    const incumbent = await connectAs(port, UUID_A);
    sockets.push(incumbent);

    const contender = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: EXT_ORIGIN } });
    await new Promise<void>((resolve) => contender.on("open", () => resolve()));
    // A response for a command the server never sent must not be accepted from a refused socket.
    contender.send(JSON.stringify({ type: "response", id: "fabricated", success: true, data: "injected" }));
    contender.send(JSON.stringify({ type: "connected", extensionId: "ext-two", profileId: UUID_B }));
    await closed(contender);

    expect(b.isConnected, "the incumbent is untouched").toBe(true);
    expect(b.listProfiles().connected).toBe(UUID_A);
  });

  it("should expose the roster on /health for a separate process to read", async () => {
    // doctor runs in its own process and can only see /health, so the roster has to be there.
    const { port } = await startBridge();
    const ws = await connectAs(port, UUID_A);
    sockets.push(ws);
    // A real extension challenges immediately. This fake uses the legacy no-ACK path, which
    // settles as soon as the server puts its proof on the wire.
    ws.send(JSON.stringify({ type: HANDSHAKE_MESSAGE_TYPES.challenge, nonce: "health-test" }));
    await new Promise((r) => setTimeout(r, 60));

    const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as {
      connected?: boolean;
      socketConnected?: boolean;
      profiles?: { connected: string | null; preferred: string | null; seen: Array<{ profileId: string }> };
    };
    expect(body.connected).toBe(true);
    expect(body.socketConnected).toBe(true);
    expect(body.profiles?.connected).toBe(UUID_A);
    expect(body.profiles?.seen.map((p) => p.profileId)).toEqual([UUID_A]);
  });
});
