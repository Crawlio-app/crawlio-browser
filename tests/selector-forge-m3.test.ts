// Selector Forge M3 (extension) — verified capture + picker.
//
// Proves the extension's selector generation now goes through the committed
// @crawlio/selectors kernel: the exact-set oracle (resolvesExactlyTo) rejects
// over- AND under-match before a selector is trusted, computeXPath/
// generalizeArrayXpath produce minimal selectors, a recorded step stores a
// verified selector + the 5-rail bundle, a previously-brittle recording heals
// on replay via the rail ladder, and the picker overlay tool is registered.

import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, vi } from "vitest";

import { resolvesExactlyTo, generalizeArrayXpath, partOfSameArrayXpath } from "@crawlio/selectors";
import {
  getForgePreludeJs,
  kernelAvailable,
  selectWorkingRail,
  generalizeVerifiedArrayXpath,
  RAIL_LADDER,
  type ForgedSelectorBundle,
} from "@/mcp-server/selector-kernel";
import { createTools, TOOL_TIMEOUTS } from "@/mcp-server/tools";

function createMockBridge(responses: unknown[] = []) {
  const queue = [...responses];
  return { send: vi.fn(async () => queue.shift() ?? {}), isConnected: true, push: vi.fn() };
}
function createMockCrawlio() {
  return { request: vi.fn() } as unknown as Parameters<typeof createTools>[1];
}

// --- 1. The verification oracle: reject over/under-match, accept exact --------

describe("resolvesExactlyTo (the verify-before-trust gate)", () => {
  const a = { id: "a" } as unknown as Element;
  const b = { id: "b" } as unknown as Element;
  // A CSS-only stub document: resolvesExactlyTo's css path needs no DOM globals.
  const root = {
    querySelectorAll: (sel: string) => (sel === "exact" ? [a] : sel === "over" ? [a, b] : []),
  } as unknown as Document;

  it("accepts a selector that resolves to EXACTLY the target", () => {
    expect(resolvesExactlyTo({ type: "css", value: "exact" }, [a], root)).toBe(true);
  });
  it("rejects an OVER-matching selector (too many)", () => {
    expect(resolvesExactlyTo({ type: "css", value: "over" }, [a], root)).toBe(false);
  });
  it("rejects an UNDER-matching selector (too few / wrong)", () => {
    expect(resolvesExactlyTo({ type: "css", value: "under" }, [a], root)).toBe(false);
  });
  it("never matches an empty expected set", () => {
    expect(resolvesExactlyTo({ type: "css", value: "exact" }, [], root)).toBe(false);
  });
});

// --- 2. generalizeArrayXpath: minimal array selector, reject non-arrays -------

describe("generalizeArrayXpath / generalizeVerifiedArrayXpath", () => {
  it("collapses sibling xpaths into one index-stripped (minimal) array xpath", () => {
    expect(generalizeArrayXpath(["/html/body/ul/li[1]/a", "/html/body/ul/li[3]/a"])).toBe("/html/body/ul/li/a");
  });
  it("rejects picks that do not form a clean array (structural difference)", () => {
    expect(generalizeArrayXpath(["/html/body/div/a", "/html/body/section/a"])).toBeNull();
  });
  it("partOfSameArrayXpath needs exactly one numeric difference", () => {
    expect(partOfSameArrayXpath("/a/b[1]/c", "/a/b[2]/c")).toBe(true);
    expect(partOfSameArrayXpath("/a/b[1]/c", "/a/b[1]/c")).toBe(false);
  });
  it("the server-side wrapper drops blanks and needs >= 2 valid xpaths", () => {
    expect(generalizeVerifiedArrayXpath(["/ul/li[1]", "/ul/li[2]"])).toBe("/ul/li");
    expect(generalizeVerifiedArrayXpath(["/ul/li[1]", null, undefined])).toBeNull();
  });
});

// --- 3. Replay heal: the rail ladder rescues a brittle recording --------------

describe("selectWorkingRail (deterministic replay heal)", () => {
  const bundle: ForgedSelectorBundle = {
    verified: true,
    selector: { type: "xpath", value: "/html/body/div[2]/button", rail: "xpath" },
    rails: {
      xpath: "/html/body/div[2]/button",
      attribute: null,
      classChain: "button.buy-now",
      textContent: "Buy now",
      rolePlusText: "button[Buy now]",
    },
  };

  it("returns the recorded primary while it still resolves", () => {
    expect(selectWorkingRail(bundle, () => true)).toEqual({ rail: "xpath", value: "/html/body/div[2]/button" });
  });

  it("heals to a surviving rail when the recorded xpath has drifted (brittle recording replays)", () => {
    // The positional xpath broke after a redesign; only the class chain still
    // resolves — replay must find it instead of failing.
    const onlyClassChain = (_rail: string, value: string) => value === "button.buy-now";
    expect(selectWorkingRail(bundle, onlyClassChain)).toEqual({ rail: "classChain", value: "button.buy-now" });
  });

  it("returns null when nothing in the bundle resolves", () => {
    expect(selectWorkingRail(bundle, () => false)).toBeNull();
  });

  it("exposes the five canonical rails in heal-priority order", () => {
    expect([...RAIL_LADDER]).toEqual(["rolePlusText", "textContent", "attribute", "classChain", "xpath"]);
  });
});

// --- 4. The injected prelude is the kernel's OWN source, not a reimpl ---------

describe("getForgePreludeJs (kernel injected into the page)", () => {
  it("ships the committed kernel primitives + the 5-rail forge", () => {
    const prelude = getForgePreludeJs();
    expect(kernelAvailable()).toBe(true);
    expect(prelude).toContain("function computeXPath");
    expect(prelude).toContain("function resolvesExactlyTo");
    expect(prelude).toContain("__crawlioSelectors");
    expect(prelude).toContain("__crawlioForge");
    // The forge picks its primary by verifying with the kernel oracle.
    expect(prelude).toContain("resolvesExactlyTo");
  });
});

// --- 5. Capture wiring: a recorded step stores a verified selector + 5 rails --

describe("robot training capture stores verified selector + 5-rail bundle", () => {
  it("threads the forged bundle from the monitor into each recipe step", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "sf-m3-"));
    try {
      const forged: ForgedSelectorBundle = {
        verified: true,
        selector: { type: "xpath", value: "/html/body/button", rail: "xpath" },
        rails: {
          xpath: "/html/body/button",
          attribute: "#buy",
          classChain: "button.buy",
          textContent: "Buy",
          rolePlusText: "button[Buy]",
        },
      };
      const stateLog = [
        { id: 1, ts: 1, reason: "before-click", url: "https://shop.example.com", title: "Shop",
          extra: { selector: "/html/body/button", tag: "BUTTON", text: "Buy", bundle: forged } },
      ];
      const recording = {
        id: "rec_1",
        startedAt: "2026-06-22T00:00:00Z",
        duration: 1,
        pages: [{
          url: "https://shop.example.com",
          enteredAt: "2026-06-22T00:00:00Z",
          console: [],
          interactions: [{ timestamp: "2026-06-22T00:00:00Z", tool: "user_click", args: {}, durationMs: 1, pageUrl: "https://shop.example.com", source: "user" }],
          network: [{ requestId: "1", url: "https://shop.example.com/api/buy", method: "POST", status: 200, mimeType: "application/json", size: 4, transferSize: 4, durationMs: 5, resourceType: "XHR", requestHeaders: {}, requestBody: "{}" }],
        }],
        metadata: { tabId: 101, initialUrl: "https://shop.example.com", stopReason: "manual" },
      };

      const bridge = createMockBridge([
        { tabId: 101, url: "https://shop.example.com", title: "Shop", connected: true }, // create_tab
        "started",                                                                        // start_network_capture
        { sessionId: "rec_1" },                                                           // start_recording
        { result: { ok: true, monitor: "robot-training" } },                              // browser_evaluate(monitor)
        { result: stateLog },                                                             // browser_evaluate(state log)
        recording,                                                                        // stop_recording
        { body: "{}", base64Encoded: false },                                             // get_response_body
        recording.pages[0].network,                                                       // stop_network_capture
        [],                                                                               // get_console_logs
        { cookies: [] },                                                                  // get_cookies
        { result: { url: "https://shop.example.com", title: "Shop" } },                   // browser_evaluate(finalMeta)
      ]);

      const tools = createTools(bridge as never, createMockCrawlio());
      const start = tools.find((t) => t.name === "robot_training_start")!;
      const stop = tools.find((t) => t.name === "robot_training_stop")!;

      await start.handler({ url: "https://shop.example.com", runId: "rt_m3", outputDir });
      const result = await stop.handler({ runId: "rt_m3", closeTab: false }) as { isError: boolean };
      expect(result.isError).toBe(false);

      const recipe = JSON.parse(await readFile(join(outputDir, "recipe.json"), "utf-8"));
      const step = recipe.steps.find((s: { kind: string }) => s.kind === "user_click");
      expect(step).toBeTruthy();
      expect(step.verified).toBe(true);
      expect(step.selector).toEqual({ type: "xpath", value: "/html/body/button" });
      expect(Object.keys(step.rails).sort()).toEqual(["attribute", "classChain", "rolePlusText", "textContent", "xpath"]);
      expect(step.rails.rolePlusText).toBe("button[Buy]");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

// --- 6. The interactive picker overlay tool is registered --------------------

describe("picker overlay MCP tool", () => {
  it("registers pick_element + cancel_picker with timeouts", () => {
    const tools = createTools(createMockBridge() as never, createMockCrawlio());
    const names = tools.map((t) => t.name);
    expect(names).toContain("pick_element");
    expect(names).toContain("cancel_picker");
    expect(TOOL_TIMEOUTS.pick_element).toBeGreaterThan(0);
    expect(TOOL_TIMEOUTS.cancel_picker).toBeGreaterThan(0);
  });
});
