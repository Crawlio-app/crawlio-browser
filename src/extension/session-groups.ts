// Logical session-tab registry. Each tracked tab carries an origin so we know which tabs the
// agent created (and may close) vs. ones it adopted from the user (which it must not close).
// Crawlio intentionally does not declare `tabGroups`: visible Chrome grouping would add another
// optional permission and store-review explanation without improving browser control.

const SESSION_GROUPS_KEY = "crawlio:sessionGroups";
export const SESSION_GROUP_DEFAULT_TITLE = "Crawlio";
/** Back-compat sentinel for persisted records created before visible grouping was removed. */
export const NO_GROUP = -1;

export type TabOrigin = "agent" | "user";
export type FinalizeStatus = "handoff" | "deliverable";

export interface SessionGroupTab {
  tabId: number;
  origin: TabOrigin;
}

export interface SessionGroup {
  sessionId: string;
  groupId: number;
  title: string;
  tabs: SessionGroupTab[];
}

export type SessionGroupStore = Record<string, SessionGroup>;

export interface FinalizeResult {
  handoff: number[];
  deliverable: number[];
  released: number[];
  closed: number[];
}

// ---------------------------------------------------------------------------
// Pure helpers (no Chrome APIs) — unit-tested directly.
// ---------------------------------------------------------------------------

function isSessionGroup(v: unknown): v is SessionGroup {
  if (!v || typeof v !== "object") return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.sessionId === "string" &&
    typeof g.groupId === "number" &&
    typeof g.title === "string" &&
    Array.isArray(g.tabs) &&
    (g.tabs as unknown[]).every(
      (t) =>
        !!t &&
        typeof t === "object" &&
        typeof (t as SessionGroupTab).tabId === "number" &&
        ((t as SessionGroupTab).origin === "agent" || (t as SessionGroupTab).origin === "user"),
    )
  );
}

export function isSessionGroupStore(v: unknown): v is SessionGroupStore {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every(isSessionGroup);
}

/** Upsert a tab into a group record, de-duplicating by tabId (last origin wins). */
export function upsertTabRecord(group: SessionGroup, tabId: number, origin: TabOrigin): SessionGroup {
  const tabs = group.tabs.filter((t) => t.tabId !== tabId);
  tabs.push({ tabId, origin });
  return { ...group, tabs };
}

/** Which session, if any, currently owns a tab. */
export function findOwningSession(store: SessionGroupStore, tabId: number): string | null {
  for (const [sessionId, group] of Object.entries(store)) {
    if (group.tabs.some((t) => t.tabId === tabId)) return sessionId;
  }
  return null;
}

/** Compute the finalize disposition for every tab in a session group. Throws on invalid keep. */
export function planFinalize(
  group: SessionGroup,
  keep: Array<{ tabId: number; status: FinalizeStatus }>,
): FinalizeResult {
  const keepMap = new Map<number, FinalizeStatus>();
  for (const k of keep) {
    if (!Number.isInteger(k.tabId)) throw new Error("finalize: tabId must be an integer");
    if (k.status !== "handoff" && k.status !== "deliverable") {
      throw new Error(`finalize: invalid status "${String(k.status)}" for tab ${k.tabId}`);
    }
    if (!group.tabs.some((t) => t.tabId === k.tabId)) {
      throw new Error(`finalize: tab ${k.tabId} is not part of session ${group.sessionId}`);
    }
    if (keepMap.has(k.tabId)) throw new Error(`finalize: duplicate tab ${k.tabId}`);
    keepMap.set(k.tabId, k.status);
  }

  const result: FinalizeResult = { handoff: [], deliverable: [], released: [], closed: [] };
  for (const tab of group.tabs) {
    const status = keepMap.get(tab.tabId);
    if (status === "handoff") result.handoff.push(tab.tabId);
    else if (status === "deliverable") result.deliverable.push(tab.tabId);
    else if (tab.origin === "agent") result.closed.push(tab.tabId); // throwaway agent tab
    else result.released.push(tab.tabId); // never close a user's own tab
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function loadSessionGroups(): Promise<SessionGroupStore> {
  try {
    const stored = await chrome.storage.session.get(SESSION_GROUPS_KEY);
    const raw = stored[SESSION_GROUPS_KEY];
    return isSessionGroupStore(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function saveSessionGroups(store: SessionGroupStore): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSION_GROUPS_KEY]: store });
  } catch {
    // Group metadata is reconstructable; storage pressure should not crash a session op.
  }
}

// ---------------------------------------------------------------------------
// Logical membership operations
// ---------------------------------------------------------------------------

/** Add (or re-add) a tab to a session's logical group. */
export async function addTabToSessionGroup(
  sessionId: string,
  tabId: number,
  origin: TabOrigin,
  title = SESSION_GROUP_DEFAULT_TITLE,
): Promise<SessionGroup> {
  const store = await loadSessionGroups();
  let group = store[sessionId] ?? { sessionId, groupId: NO_GROUP, title, tabs: [] };
  group = upsertTabRecord({ ...group, groupId: NO_GROUP }, tabId, origin);
  store[sessionId] = group;
  await saveSessionGroups(store);
  return group;
}

/** Adopt an existing user tab into a session group. Throws if another session owns it. */
export async function claimTabIntoSession(sessionId: string, tabId: number): Promise<SessionGroup> {
  const store = await loadSessionGroups();
  const owner = findOwningSession(store, tabId);
  if (owner && owner !== sessionId) {
    throw new Error(`Tab ${tabId} is already owned by session ${owner}`);
  }
  return addTabToSessionGroup(sessionId, tabId, "user");
}

/** Rename a logical session group. */
export async function renameSessionGroup(sessionId: string, title: string): Promise<SessionGroup | null> {
  const store = await loadSessionGroups();
  const group = store[sessionId];
  if (!group) return null;
  group.title = title;
  group.groupId = NO_GROUP;
  store[sessionId] = group;
  await saveSessionGroups(store);
  return group;
}

/** Apply an end-of-task disposition to a session's tabs (handoff / deliverable / release / close). */
export async function finalizeSession(
  sessionId: string,
  keep: Array<{ tabId: number; status: FinalizeStatus }>,
): Promise<FinalizeResult> {
  const store = await loadSessionGroups();
  const group = store[sessionId];
  if (!group) return { handoff: [], deliverable: [], released: [], closed: [] };

  const plan = planFinalize(group, keep);

  // Close throwaway agent tabs.
  if (plan.closed.length) {
    try {
      await chrome.tabs.remove(plan.closed);
    } catch {
      // Tabs may already be gone.
    }
  }

  delete store[sessionId];
  await saveSessionGroups(store);
  return plan;
}

/** Drop a closed tab from whichever session group references it (called from tabs.onRemoved). */
export async function pruneClosedTab(tabId: number): Promise<void> {
  const store = await loadSessionGroups();
  let changed = false;
  for (const group of Object.values(store)) {
    const next = group.tabs.filter((t) => t.tabId !== tabId);
    if (next.length !== group.tabs.length) {
      group.tabs = next;
      changed = true;
    }
  }
  if (changed) await saveSessionGroups(store);
}
