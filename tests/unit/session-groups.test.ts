import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertTabRecord,
  findOwningSession,
  planFinalize,
  isSessionGroupStore,
  addTabToSessionGroup,
  claimTabIntoSession,
  finalizeSession,
  renameSessionGroup,
  pruneClosedTab,
  loadSessionGroups,
  NO_GROUP,
  SESSION_GROUP_DELIVERABLE_TITLE,
  type SessionGroup,
} from "@/extension/session-groups";

function group(sessionId: string, tabs: SessionGroup["tabs"], groupId = 100): SessionGroup {
  return { sessionId, groupId, title: "Crawlio", tabs };
}

// Minimal stateful chrome mock for the tabGroups + storage surface the module touches.
function installChrome(opts: { hasTabGroups?: boolean } = {}) {
  const store: Record<string, unknown> = {};
  const calls = {
    group: [] as Array<Record<string, unknown>>,
    ungroup: [] as unknown[],
    remove: [] as unknown[],
    update: [] as Array<{ groupId: number; props: Record<string, unknown> }>,
  };
  let nextGroupId = 100;
  const chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => { Object.assign(store, obj); },
      },
    },
    permissions: {
      contains: (_q: unknown, cb: (granted: boolean) => void) => cb(opts.hasTabGroups !== false),
    },
    tabs: {
      group: async (o: { tabIds: number | number[]; groupId?: number }) => {
        calls.group.push(o);
        return o.groupId ?? nextGroupId++;
      },
      ungroup: async (ids: number | number[]) => { calls.ungroup.push(ids); },
      remove: async (ids: number | number[]) => { calls.remove.push(ids); },
    },
    tabGroups: {
      update: async (groupId: number, props: Record<string, unknown>) => { calls.update.push({ groupId, props }); },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chrome;
  return { calls, store };
}

describe("session-groups pure helpers", () => {
  it("upsertTabRecord de-duplicates by tabId and keeps the latest origin", () => {
    let g = group("s", [{ tabId: 1, origin: "agent" }]);
    g = upsertTabRecord(g, 1, "user"); // re-add same tab with a new origin (moves to end)
    g = upsertTabRecord(g, 2, "agent");
    expect(g.tabs).toEqual([{ tabId: 1, origin: "user" }, { tabId: 2, origin: "agent" }]);
  });

  it("findOwningSession returns the session that holds a tab, else null", () => {
    const store = { a: group("a", [{ tabId: 1, origin: "agent" }]), b: group("b", [{ tabId: 2, origin: "user" }]) };
    expect(findOwningSession(store, 2)).toBe("b");
    expect(findOwningSession(store, 99)).toBeNull();
  });

  it("planFinalize routes tabs by keep-status and origin", () => {
    const g = group("s", [
      { tabId: 1, origin: "agent" }, // -> deliverable
      { tabId: 2, origin: "user" },  // -> handoff
      { tabId: 3, origin: "agent" }, // not kept, agent-created -> closed
      { tabId: 4, origin: "user" },  // not kept, user-owned -> released
    ]);
    const plan = planFinalize(g, [
      { tabId: 1, status: "deliverable" },
      { tabId: 2, status: "handoff" },
    ]);
    expect(plan).toEqual({ deliverable: [1], handoff: [2], closed: [3], released: [4] });
  });

  it("planFinalize rejects unknown tabs, duplicates, and invalid status", () => {
    const g = group("s", [{ tabId: 1, origin: "agent" }]);
    expect(() => planFinalize(g, [{ tabId: 9, status: "handoff" }])).toThrow(/not part of session/);
    expect(() => planFinalize(g, [{ tabId: 1, status: "handoff" }, { tabId: 1, status: "deliverable" }])).toThrow(/duplicate/);
    // @ts-expect-error invalid status on purpose
    expect(() => planFinalize(g, [{ tabId: 1, status: "nope" }])).toThrow(/invalid status/);
  });

  it("isSessionGroupStore validates shape", () => {
    expect(isSessionGroupStore({ s: group("s", [{ tabId: 1, origin: "agent" }]) })).toBe(true);
    expect(isSessionGroupStore({ s: { sessionId: "s", groupId: 1, title: "x", tabs: [{ tabId: 1, origin: "bogus" }] } })).toBe(false);
    expect(isSessionGroupStore(null)).toBe(false);
    expect(isSessionGroupStore("nope")).toBe(false);
  });
});

describe("session-groups chrome operations", () => {
  beforeEach(() => { installChrome(); });

  it("addTabToSessionGroup creates a Chrome group, titles it, and persists membership", async () => {
    const { calls } = installChrome();
    const g = await addTabToSessionGroup("s1", 11, "agent", "Research");
    expect(g.groupId).toBeGreaterThan(0);
    expect(g.tabs).toEqual([{ tabId: 11, origin: "agent" }]);
    expect(calls.group).toHaveLength(1);
    expect(calls.update[0]?.props).toEqual({ title: "Research" });

    const persisted = await loadSessionGroups();
    expect(persisted.s1.tabs).toEqual([{ tabId: 11, origin: "agent" }]);

    // Adding a second tab reuses the existing groupId.
    const g2 = await addTabToSessionGroup("s1", 12, "agent", "Research");
    expect(g2.groupId).toBe(g.groupId);
    expect(g2.tabs.map(t => t.tabId).sort()).toEqual([11, 12]);
  });

  it("degrades gracefully without the tabGroups permission", async () => {
    const { calls } = installChrome({ hasTabGroups: false });
    const g = await addTabToSessionGroup("s2", 21, "agent");
    expect(g.groupId).toBe(NO_GROUP);
    expect(calls.group).toHaveLength(0); // never calls chrome.tabs.group when not permitted
    expect(g.tabs).toEqual([{ tabId: 21, origin: "agent" }]); // membership still tracked
  });

  it("claimTabIntoSession rejects a tab owned by another session", async () => {
    installChrome();
    await addTabToSessionGroup("owner", 5, "agent");
    await expect(claimTabIntoSession("intruder", 5)).rejects.toThrow(/already owned by session owner/);
    // Re-claiming into the same owning session is allowed.
    await expect(claimTabIntoSession("owner", 5)).resolves.toBeTruthy();
  });

  it("finalizeSession closes agent tabs, moves deliverables, and clears the registry", async () => {
    const { calls } = installChrome();
    await addTabToSessionGroup("s3", 1, "agent");
    await addTabToSessionGroup("s3", 2, "agent");
    await claimTabIntoSession("s3", 3); // user-owned

    const result = await finalizeSession("s3", [
      { tabId: 1, status: "deliverable" },
      { tabId: 3, status: "handoff" },
    ]);
    expect(result).toEqual({ deliverable: [1], handoff: [3], closed: [2], released: [] });
    expect(calls.remove).toContainEqual([2]);                       // throwaway agent tab closed
    expect(calls.update.some(u => u.props.title === SESSION_GROUP_DELIVERABLE_TITLE)).toBe(true);

    const persisted = await loadSessionGroups();
    expect(persisted.s3).toBeUndefined();                            // session record removed
  });

  it("renameSessionGroup updates the stored title and the Chrome group", async () => {
    const { calls } = installChrome();
    await addTabToSessionGroup("s4", 1, "agent");
    const g = await renameSessionGroup("s4", "Final report");
    expect(g?.title).toBe("Final report");
    expect(calls.update.some(u => u.props.title === "Final report")).toBe(true);
  });

  it("pruneClosedTab removes a closed tab from its session group", async () => {
    installChrome();
    await addTabToSessionGroup("s5", 1, "agent");
    await addTabToSessionGroup("s5", 2, "agent");
    await pruneClosedTab(1);
    const persisted = await loadSessionGroups();
    expect(persisted.s5.tabs).toEqual([{ tabId: 2, origin: "agent" }]);
  });
});
