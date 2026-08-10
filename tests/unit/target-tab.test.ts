import { describe, it, expect } from "vitest";
import { withTargetTab, applyTargetTab, currentTargetTab } from "../../src/mcp-server/target-tab.js";

describe("withTargetTab", () => {
  it("should expose the tab to everything the callback awaits", async () => {
    const seen = await withTargetTab(7, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentTargetTab();
    });
    expect(seen).toBe(7);
  });

  it("should keep concurrent calls from seeing each other's tab", async () => {
    // The reason this is worth asserting: two tabs driven with Promise.all is the whole point,
    // and a context that leaked between them would send both commands to the same tab.
    const observe = (tab: number) =>
      withTargetTab(tab, async () => {
        await new Promise((r) => setTimeout(r, tab % 5));
        return currentTargetTab();
      });
    expect(await Promise.all([observe(1), observe(2), observe(3)])).toEqual([1, 2, 3]);
  });

  it("should run without a target for absent or invalid ids", async () => {
    for (const junk of [undefined, null, "3", 1.5, -1, NaN, {}]) {
      expect(await withTargetTab(junk, async () => currentTargetTab())).toBeUndefined();
    }
  });

  it("should restore the previous target after nesting", async () => {
    const trace: (number | undefined)[] = [];
    await withTargetTab(1, async () => {
      trace.push(currentTargetTab());
      await withTargetTab(2, async () => trace.push(currentTargetTab()));
      trace.push(currentTargetTab());
    });
    expect(trace).toEqual([1, 2, 1]);
  });
});

describe("applyTargetTab", () => {
  it("should stamp the ambient tab onto a tab-scoped command", () =>
    withTargetTab(9, () => {
      expect(applyTargetTab({ type: "browser_click", selector: "#go" })).toEqual({
        type: "browser_click", selector: "#go", tabId: 9,
      });
    }));

  it("should never override an explicit tabId", () =>
    withTargetTab(9, () => {
      // Code mode's bridge.send({..., tabId}) must win — the sandbox is being explicit on purpose.
      expect(applyTargetTab({ type: "browser_click", tabId: 4 }).tabId).toBe(4);
    }));

  it("should leave commands alone whose tabId means something else", () =>
    withTargetTab(9, () => {
      // close_tab's tabId is the tab being closed. Stamping the ambient target here would close
      // the tab the agent is working in.
      expect(applyTargetTab({ type: "close_tab", tabId: 4 }).tabId).toBe(4);
      expect(applyTargetTab({ type: "list_tabs" })).not.toHaveProperty("tabId");
      expect(applyTargetTab({ type: "ping" })).not.toHaveProperty("tabId");
    }));

  it("should pass commands through untouched with no ambient target", () => {
    const cmd = { type: "browser_click", selector: "#go" };
    expect(applyTargetTab(cmd)).toEqual(cmd);
  });

  it("should not mutate the command it is given", () =>
    withTargetTab(9, () => {
      const cmd: Record<string, unknown> = { type: "take_screenshot" };
      applyTargetTab(cmd);
      expect(cmd).not.toHaveProperty("tabId");
    }));
});
