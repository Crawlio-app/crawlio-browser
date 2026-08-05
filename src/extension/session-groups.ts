// Session tab-group manager — maps an agent browser session to a Chrome tab group so each
// session owns a *visible fleet* of tabs. Each tracked tab carries an origin so we know which tabs the
// agent created (and may close) vs. ones it adopted from the user (which it must not close).
//
// Requires the optional `tabGroups` permission. When the permission is absent, grouping
// degrades gracefully: the registry still tracks membership but no Chrome group is created
// (groupId = NO_GROUP), so single-tab sessions keep working unchanged.

const SESSION_GROUPS_KEY = "crawlio:sessionGroups";
export const SESSION_GROUP_DEFAULT_TITLE = "Crawlio";
export const SESSION_GROUP_DELIVERABLE_TITLE = "✅ Crawlio";
/** Sentinel groupId used when the tabGroups permission is not granted. */
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
// Chrome tab-group operations
// ---------------------------------------------------------------------------

export function hasTabGroupsPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ permissions: ["tabGroups"] }, (granted) => resolve(granted === true));
    } catch {
      resolve(false);
    }
  });
}

// Group a tab into the session's Chrome group, creating the group on first use. Best-effort:
// if tabGroups isn't permitted the membership is still tracked but no visual group is made.
async function groupTabInChrome(group: SessionGroup, tabId: number): Promise<number> {
  if (!(await hasTabGroupsPermission())) return NO_GROUP;
  try {
    const opts: chrome.tabs.GroupOptions =
      group.groupId !== NO_GROUP ? { groupId: group.groupId, tabIds: tabId } : { tabIds: tabId };
    const groupId = await chrome.tabs.group(opts);
    if (group.groupId === NO_GROUP || group.groupId !== groupId) {
      try {
        await chrome.tabGroups.update(groupId, { title: group.title });
      } catch {
        // Title is cosmetic.
      }
    }
    return groupId;
  } catch {
    return group.groupId;
  }
}

/** Add (or re-add) a tab to a session's group, creating the registry entry + Chrome group lazily. */
export async function addTabToSessionGroup(
  sessionId: string,
  tabId: number,
  origin: TabOrigin,
  title = SESSION_GROUP_DEFAULT_TITLE,
): Promise<SessionGroup> {
  const store = await loadSessionGroups();
  let group = store[sessionId] ?? { sessionId, groupId: NO_GROUP, title, tabs: [] };
  const groupId = await groupTabInChrome(group, tabId);
  group = upsertTabRecord({ ...group, groupId }, tabId, origin);
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

/** Rename a session's Chrome group (and the stored title). */
export async function renameSessionGroup(sessionId: string, title: string): Promise<SessionGroup | null> {
  const store = await loadSessionGroups();
  const group = store[sessionId];
  if (!group) return null;
  group.title = title;
  if (group.groupId !== NO_GROUP && (await hasTabGroupsPermission())) {
    try {
      await chrome.tabGroups.update(group.groupId, { title });
    } catch {
      // Group may have been dissolved by the user.
    }
  }
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
  const permitted = await hasTabGroupsPermission();

  // Close throwaway agent tabs.
  if (plan.closed.length) {
    try {
      await chrome.tabs.remove(plan.closed);
    } catch {
      // Tabs may already be gone.
    }
  }

  // Ungroup handed-off + released tabs so they return to the user's normal strip.
  const ungroup = [...plan.handoff, ...plan.released];
  if (ungroup.length && permitted) {
    try {
      await chrome.tabs.ungroup(ungroup);
    } catch {
      // Best effort.
    }
  }

  // Move deliverables into a dedicated "✅ Crawlio" group.
  if (plan.deliverable.length && permitted) {
    try {
      const deliverableGroupId = await chrome.tabs.group({ tabIds: plan.deliverable });
      try {
        await chrome.tabGroups.update(deliverableGroupId, { title: SESSION_GROUP_DELIVERABLE_TITLE });
      } catch {
        // Title is cosmetic.
      }
    } catch {
      // Best effort.
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
