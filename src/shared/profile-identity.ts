/**
 * Chrome profile identity.
 *
 * An extension instance is per-profile and cannot see any other, and `chrome.runtime.id` is
 * identical across profiles — so the same extension in two profiles is indistinguishable to the
 * server, which is exactly the thing that has to be told apart in order to switch between them.
 *
 * So the profile mints its own id: a UUID in `chrome.storage.local`, which is per-profile by
 * definition and needs no additional permission. It identifies a profile without describing it —
 * no account, no email, no path — so it discloses nothing about the human using it.
 *
 * A human-readable label would need `chrome.identity.getProfileUserInfo()` and the `identity`
 * permission. That fits the runtime-optional strategy, but ids alone are enough to switch.
 */
export const PROFILE_ID_KEY = "crawlio:profileId";

/** Matches the canonical lowercase UUID that mintProfileId() produces. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Minimal shape of `chrome.storage.local`, so this module stays testable without a browser. */
export interface ProfileIdStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * This profile's id, minting and persisting one on first call.
 *
 * A stored value that is not a well-formed UUID is replaced rather than trusted: it can only come
 * from a corrupted store or another writer, and a roster keyed by junk is worse than a new id.
 */
export async function getOrCreateProfileId(store: ProfileIdStore, mint: () => string): Promise<string> {
  const existing = (await store.get(PROFILE_ID_KEY))[PROFILE_ID_KEY];
  if (isProfileId(existing)) return existing;

  const minted = mint();
  await store.set({ [PROFILE_ID_KEY]: minted });
  return minted;
}

/** A profile the server has seen, whether or not it is connected now. */
export interface ProfileRecord {
  profileId: string;
  extensionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  connected: boolean;
}

/**
 * The set of profiles the server has seen this run, most recently seen first.
 *
 * Deliberately in-memory: it describes which browsers are reachable *now*, and a stale entry from
 * a previous run would be an invitation to switch to a profile that is not running.
 */
/**
 * How many profiles the roster remembers.
 *
 * A machine has a handful of Chrome profiles, so this is generous for real use. It exists because
 * the roster is filled from the wire: anything that can reach the bridge can send `connected`
 * repeatedly with fresh ids, and an unbounded roster is then both a memory leak and a way to
 * bloat every /health response, which the extension polls across the whole port range.
 */
export const MAX_PROFILES = 32;

export class ProfileRoster {
  private readonly profiles = new Map<string, ProfileRecord>();

  /** Record a connection. Returns the updated record. */
  observe(profileId: string, extensionId: string, at: string): ProfileRecord {
    const existing = this.profiles.get(profileId);
    const record: ProfileRecord = existing
      ? { ...existing, extensionId, lastSeenAt: at, connected: true }
      : { profileId, extensionId, firstSeenAt: at, lastSeenAt: at, connected: true };
    this.profiles.set(profileId, record);
    this.evictOldest();
    return record;
  }

  /** Drop least-recently-seen entries past the cap, never the one just recorded. */
  private evictOldest(): void {
    if (this.profiles.size <= MAX_PROFILES) return;
    const byAge = [...this.profiles.values()].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
    for (const victim of byAge.slice(0, this.profiles.size - MAX_PROFILES)) {
      this.profiles.delete(victim.profileId);
    }
  }

  /** Mark a profile disconnected without forgetting it — it stays a switch target. */
  disconnect(profileId: string, at: string): void {
    const existing = this.profiles.get(profileId);
    if (existing) this.profiles.set(profileId, { ...existing, lastSeenAt: at, connected: false });
  }

  /** Mark every profile disconnected, for a bridge teardown. */
  disconnectAll(at: string): void {
    for (const id of this.profiles.keys()) this.disconnect(id, at);
  }

  get(profileId: string): ProfileRecord | undefined {
    return this.profiles.get(profileId);
  }

  has(profileId: string): boolean {
    return this.profiles.has(profileId);
  }

  /** Most recently seen first, so the list reads as "where the agent has been". */
  list(): ProfileRecord[] {
    return [...this.profiles.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  get size(): number {
    return this.profiles.size;
  }
}
