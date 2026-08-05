import { describe, expect, it } from "vitest";
import {
  encodeNativeMessage,
  decodeNativeMessages,
  listLiveBridges,
  selectProvisionableBridge,
} from "../../bin/native-host/provision.mjs";

/**
 * Native host: the rogue-proof channel that delivers the real bridge token to
 * the extension. These cover the two pieces worth testing — the Chrome
 * native-messaging wire framing and the freshest-live-bridge selection.
 */
describe("native-host framing", () => {
  it("round-trips a message through encode/decode", () => {
    const frame = encodeNativeMessage({ type: "pong" });
    // 4-byte LE length prefix
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    const { messages, rest } = decodeNativeMessages(frame);
    expect(messages).toEqual([{ type: "pong" }]);
    expect(rest.length).toBe(0);
  });

  it("decodes multiple frames and preserves a partial tail", () => {
    const a = encodeNativeMessage({ type: "ping" });
    const b = encodeNativeMessage({ type: "set_crawlio_token", token: "t" });
    const partial = b.subarray(0, 3); // an incomplete next frame
    const { messages, rest } = decodeNativeMessages(Buffer.concat([a, b, partial]));
    expect(messages).toEqual([{ type: "ping" }, { type: "set_crawlio_token", token: "t" }]);
    expect(rest.length).toBe(3); // the partial frame is held back
  });
});

describe("listLiveBridges (no startedAt tiebreak)", () => {
  const files: Record<string, string> = {
    "100.json": JSON.stringify({ port: 9333, token: "a", pid: 100, startedAt: 1 }),
    "200.json": JSON.stringify({ port: 9334, token: "b", pid: 200, startedAt: 9e15 }), // forged future ts ignored
    "300.json": JSON.stringify({ port: 9335, token: "dead", pid: 300 }),
    "junk.json": "{ not json",
  };
  const readDir = () => Object.keys(files);
  const readFile = (p: string) => files[p.split("/").pop() as string];

  it("lists every live bridge, skipping dead pids + malformed (startedAt is not consulted)", () => {
    const got = listLiveBridges("/b", (pid: number) => pid !== 300, readDir as never, readFile as never);
    expect(got.map((b) => b.token).sort()).toEqual(["a", "b"]);
  });
});

describe("selectProvisionableBridge — /health-validated, elect-by-activity", () => {
  const mk = (pid: number, port: number, token: string, lastActivityAt?: number) =>
    ({ [`${pid}.json`]: JSON.stringify({ pid, port, token, ...(lastActivityAt !== undefined ? { lastActivityAt } : {}) }) });
  type Health = { service?: string; pid?: number; port?: number } | null;
  function deps(files: Record<string, string>, healthByPort: Record<number, Health>) {
    return {
      isPidAlive: () => true,
      readDir: () => Object.keys(files),
      readFile: (p: string) => files[p.split("/").pop() as string],
      fetchFn: async (url: string) => {
        const h = healthByPort[Number(new URL(url).port)];
        if (!h) throw new Error("connection refused");
        return { ok: true, json: async () => h } as Response;
      },
    };
  }

  it("provisions the unique bridge whose /health validates (service+pid+port match)", async () => {
    const d = deps(mk(100, 9333, "real"), { 9333: { service: "crawlio-mcp", pid: 100, port: 9333 } });
    expect(await selectProvisionableBridge("/b", d)).toEqual({ port: 9333, token: "real" });
  });

  it("rejects a file-only rogue (no live server on its port) → null", async () => {
    const d = deps(mk(100, 9333, "rogue"), { 9333: null });
    expect(await selectProvisionableBridge("/b", d)).toBeNull();
  });

  it("rejects a forged file whose pid mismatches the server actually on that port", async () => {
    const d = deps(mk(999, 9333, "rogue"), { 9333: { service: "crawlio-mcp", pid: 100, port: 9333 } });
    expect(await selectProvisionableBridge("/b", d)).toBeNull();
  });

  it("two validate → elects the most-recently-active (higher lastActivityAt wins)", async () => {
    const d = deps({ ...mk(100, 9333, "stale", 1000), ...mk(200, 9334, "active", 2000) }, {
      9333: { service: "crawlio-mcp", pid: 100, port: 9333 },
      9334: { service: "crawlio-mcp", pid: 200, port: 9334 },
    });
    expect(await selectProvisionableBridge("/b", d)).toEqual({ port: 9334, token: "active" });
  });

  it("two validate → elects most-active regardless of file order (not positionally lucky)", async () => {
    // Reverse the declaration order: the active bridge is now FIRST in the dir listing.
    const d = deps({ ...mk(200, 9334, "active", 2000), ...mk(100, 9333, "stale", 1000) }, {
      9333: { service: "crawlio-mcp", pid: 100, port: 9333 },
      9334: { service: "crawlio-mcp", pid: 200, port: 9334 },
    });
    expect(await selectProvisionableBridge("/b", d)).toEqual({ port: 9334, token: "active" });
  });

  it("tie / missing lastActivityAt → returns one deterministically (no throw)", async () => {
    // Neither file carries lastActivityAt (both sort to -Infinity); reduce keeps the first.
    const d = deps({ ...mk(100, 9333, "a"), ...mk(200, 9334, "b") }, {
      9333: { service: "crawlio-mcp", pid: 100, port: 9333 },
      9334: { service: "crawlio-mcp", pid: 200, port: 9334 },
    });
    const got = await selectProvisionableBridge("/b", d);
    expect(got).not.toBeNull();
    expect(["a", "b"]).toContain(got!.token);
  });

  it("single validated still wins regardless of lastActivityAt (no tiebreak needed)", async () => {
    // A low/zero activity stamp must not gate the lone validated bridge.
    const d = deps(mk(100, 9333, "real", 0), { 9333: { service: "crawlio-mcp", pid: 100, port: 9333 } });
    expect(await selectProvisionableBridge("/b", d)).toEqual({ port: 9333, token: "real" });
  });
});
