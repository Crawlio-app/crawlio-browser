import { describe, it, expect } from "vitest";
import {
  getOrCreateProfileId,
  isProfileId,
  ProfileRoster,
  MAX_PROFILES,
  PROFILE_ID_KEY,
  type ProfileIdStore,
} from "../../src/shared/profile-identity.js";

function memoryStore(initial: Record<string, unknown> = {}): ProfileIdStore & { data: Record<string, unknown>; writes: number } {
  const data = { ...initial };
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    async get(key) { return key in data ? { [key]: data[key] } : {}; },
    async set(items) { writes++; Object.assign(data, items); },
  };
}

// Both carry hex letters on purpose: an all-digit UUID is unchanged by toUpperCase(), which would
// make the case-sensitivity assertion below pass without testing anything.
const UUID_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const UUID_B = "f0e9d8c7-b6a5-4948-9a3b-2c1d0e9f8a7b";

describe("isProfileId", () => {
  it("should accept a canonical lowercase UUID", () => {
    expect(isProfileId(UUID_A)).toBe(true);
  });

  it("should reject anything that is not one", () => {
    for (const junk of ["", "abc", UUID_A.toUpperCase(), UUID_A.slice(0, -1), 42, null, undefined, {}]) {
      expect(isProfileId(junk)).toBe(false);
    }
  });
});

describe("getOrCreateProfileId", () => {
  it("should mint and persist an id on first run", async () => {
    const store = memoryStore();
    const id = await getOrCreateProfileId(store, () => UUID_A);
    expect(id).toBe(UUID_A);
    expect(store.data[PROFILE_ID_KEY]).toBe(UUID_A);
  });

  it("should return the stored id on later runs without writing again", async () => {
    const store = memoryStore({ [PROFILE_ID_KEY]: UUID_A });
    const id = await getOrCreateProfileId(store, () => UUID_B);
    expect(id).toBe(UUID_A);
    expect(store.writes).toBe(0);
  });

  it("should be stable across repeated calls", async () => {
    const store = memoryStore();
    let n = 0;
    const mint = () => [UUID_A, UUID_B][n++];
    expect(await getOrCreateProfileId(store, mint)).toBe(UUID_A);
    expect(await getOrCreateProfileId(store, mint)).toBe(UUID_A);
  });

  it("should replace a stored value that is not a well-formed id", async () => {
    // Junk can only come from a corrupted store or another writer, and a roster keyed by junk is
    // worse than a fresh id — switch_profile would offer a target that can never be matched.
    const store = memoryStore({ [PROFILE_ID_KEY]: "not-a-uuid" });
    expect(await getOrCreateProfileId(store, () => UUID_B)).toBe(UUID_B);
    expect(store.data[PROFILE_ID_KEY]).toBe(UUID_B);
  });
});

describe("ProfileRoster", () => {
  it("should start empty", () => {
    const r = new ProfileRoster();
    expect(r.size).toBe(0);
    expect(r.list()).toEqual([]);
    expect(r.has(UUID_A)).toBe(false);
  });

  it("should record a first sighting as connected", () => {
    const r = new ProfileRoster();
    const rec = r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    expect(rec).toEqual({
      profileId: UUID_A, extensionId: "ext-1",
      firstSeenAt: "2026-08-06T10:00:00.000Z", lastSeenAt: "2026-08-06T10:00:00.000Z",
      connected: true,
    });
  });

  it("should keep firstSeenAt while advancing lastSeenAt on reconnect", () => {
    const r = new ProfileRoster();
    r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    const again = r.observe(UUID_A, "ext-1", "2026-08-06T11:00:00.000Z");
    expect(again.firstSeenAt).toBe("2026-08-06T10:00:00.000Z");
    expect(again.lastSeenAt).toBe("2026-08-06T11:00:00.000Z");
    expect(r.size).toBe(1);
  });

  it("should track two profiles independently", () => {
    const r = new ProfileRoster();
    r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    r.observe(UUID_B, "ext-1", "2026-08-06T10:00:01.000Z");
    expect(r.size).toBe(2);
    expect(r.get(UUID_A)?.connected).toBe(true);
    expect(r.get(UUID_B)?.connected).toBe(true);
  });

  it("should keep a disconnected profile as a switch target", () => {
    // Forgetting it would make switching back impossible, which is the whole point of the roster.
    const r = new ProfileRoster();
    r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    r.disconnect(UUID_A, "2026-08-06T10:05:00.000Z");
    expect(r.has(UUID_A)).toBe(true);
    expect(r.get(UUID_A)).toMatchObject({ connected: false, lastSeenAt: "2026-08-06T10:05:00.000Z" });
  });

  it("should ignore disconnecting a profile it never saw", () => {
    const r = new ProfileRoster();
    expect(() => r.disconnect(UUID_A, "2026-08-06T10:00:00.000Z")).not.toThrow();
    expect(r.size).toBe(0);
  });

  it("should disconnect every profile at once", () => {
    const r = new ProfileRoster();
    r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    r.observe(UUID_B, "ext-1", "2026-08-06T10:00:01.000Z");
    r.disconnectAll("2026-08-06T10:09:00.000Z");
    expect(r.list().every((p) => !p.connected)).toBe(true);
  });

  it("should list most recently seen first", () => {
    const r = new ProfileRoster();
    r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    r.observe(UUID_B, "ext-1", "2026-08-06T09:00:00.000Z");
    expect(r.list().map((p) => p.profileId)).toEqual([UUID_A, UUID_B]);

    r.observe(UUID_B, "ext-1", "2026-08-06T12:00:00.000Z");
    expect(r.list().map((p) => p.profileId)).toEqual([UUID_B, UUID_A]);
  });

  it("should cap how many profiles it remembers", () => {
    // The roster is filled from the wire, so an unbounded one is both a memory leak and a way to
    // bloat every /health response — which the extension polls across the whole port range.
    const r = new ProfileRoster();
    for (let i = 0; i < MAX_PROFILES + 10; i++) {
      r.observe(`0000${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`, "ext", `2026-08-06T10:${String(i).padStart(2, "0")}:00.000Z`);
    }
    expect(r.size).toBe(MAX_PROFILES);
  });

  it("should evict the least recently seen, keeping the newest", () => {
    const r = new ProfileRoster();
    for (let i = 0; i < MAX_PROFILES; i++) {
      r.observe(`0000${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`, "ext", `2026-08-06T10:${String(i).padStart(2, "0")}:00.000Z`);
    }
    const oldest = "00000000-0000-4000-8000-000000000000";
    expect(r.has(oldest)).toBe(true);

    r.observe(UUID_A, "ext", "2026-08-06T23:00:00.000Z");
    expect(r.size).toBe(MAX_PROFILES);
    expect(r.has(UUID_A), "the profile just seen must survive").toBe(true);
    expect(r.has(oldest), "the least recently seen is evicted").toBe(false);
  });

  it("should not hand out a reference callers can mutate in place", () => {
    const r = new ProfileRoster();
    const rec = r.observe(UUID_A, "ext-1", "2026-08-06T10:00:00.000Z");
    r.disconnect(UUID_A, "2026-08-06T10:05:00.000Z");
    expect(rec.connected).toBe(true);          // the snapshot the caller held is unchanged
    expect(r.get(UUID_A)?.connected).toBe(false);
  });
});
