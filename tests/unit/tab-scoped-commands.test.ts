import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TAB_SCOPED_COMMANDS, isTabScopedCommand, TAB_ID_SCHEMA } from "../../src/shared/tab-scoped-commands.js";

/**
 * TAB_SCOPED_COMMANDS is the server's copy of a fact owned by the extension: a command accepts
 * `tabId` iff its handler resolves through resolveTargetTab(). Nothing at runtime couples them —
 * the server would happily stamp a tabId onto a command that ignores it, and the caller would see
 * their targeting silently land on the connected tab instead. So the coupling is enforced here,
 * by parsing background.ts.
 */
const isTopLevelDecl = (l: string) =>
  /^(export )?(async )?function |^chrome\.[\w.]+\.addListener\(|^const \w+ = /.test(l);

/**
 * Line ranges of the two functions that dispatch commands, where `command` is in scope.
 *
 * Both matter: handleCommandWithRecording owns start_recording, and handleCommand owns the rest.
 * Each range ends at the next top-level declaration rather than at end-of-file, because helpers
 * defined after them legitimately call getConnectedTab() with no command in scope, and counting
 * those made the guard below cry wolf. Brace matching is not an option — the bodies are full of
 * braces inside string and template literals.
 */
function commandHandlerRanges(src: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const decl of ["async function handleCommand(", "async function handleCommandWithRecording("]) {
    const start = src.findIndex((l) => l.startsWith(decl));
    expect(start, `${decl} not found — did it get renamed?`).toBeGreaterThan(-1);
    let end = src.length - 1;
    for (let i = start + 1; i < src.length; i++) {
      if (isTopLevelDecl(src[i])) { end = i - 1; break; }
    }
    ranges.push([start, end]);
  }
  return ranges;
}

function readBackground(): string[] {
  return readFileSync(join(__dirname, "../../src/extension/background.ts"), "utf8").split("\n");
}

function commandsResolvingATargetTab(): string[] {
  const src = readBackground();
  const found = new Set<string>();
  for (const [start, end] of commandHandlerRanges(src)) {
    let current: string | null = null;
    for (let i = start; i <= end; i++) {
      const label = /^\s*case "([a-z_]+)":/.exec(src[i]);
      if (label) current = label[1];
      // Two resolvers reach a target tab: resolveTargetTab directly, and requireDebuggerTab, which
      // forwards to it when the command names a tab. Both make a command targetable.
      const resolves = src[i].includes("resolveTargetTab(command)") || src[i].includes("requireDebuggerTab(command)");
      if (resolves && current) found.add(current);
    }
  }
  return [...found].sort();
}

describe("TAB_SCOPED_COMMANDS", () => {
  it("should match exactly the handlers that resolve a target tab", () => {
    expect(commandsResolvingATargetTab()).toEqual([...TAB_SCOPED_COMMANDS].sort());
  });

  it("should list every command exactly once", () => {
    expect(new Set(TAB_SCOPED_COMMANDS).size).toBe(TAB_SCOPED_COMMANDS.length);
  });

  it("should exclude commands whose tabId names a tab to operate on rather than act within", () => {
    // close_tab/switch_tab/connect_tab already carry a *required* tabId with a different meaning:
    // it is the object of the verb. Stamping an ambient target over it would close the wrong tab.
    for (const c of ["close_tab", "switch_tab", "connect_tab", "agent_session_claim_tab", "list_tabs"]) {
      expect(isTabScopedCommand(c), `${c} must not be tab-scoped`).toBe(false);
    }
  });

  it("should reject non-string types without throwing", () => {
    for (const junk of [undefined, null, 42, {}, [], Symbol("x")]) {
      expect(isTabScopedCommand(junk)).toBe(false);
    }
  });

  it("should describe tabId as a number so MCP clients can pass one", () => {
    expect(TAB_ID_SCHEMA.type).toBe("number");
    expect(TAB_ID_SCHEMA.description).toMatch(/default: the connected tab/);
  });
});

describe("command switch tab resolution", () => {
  it("should never resolve a tab without offering the command's tabId", () => {
    // A bare getConnectedTab()/requireDebuggerTab() inside the switch silently ignores a caller's
    // tabId and acts on the pinned tab instead — the failure mode is a command that reports
    // success against the wrong page, which is worse than an error. `command` is in scope
    // everywhere in the switch, so there is never a reason to drop it.
    const src = readBackground();
    const offenders: string[] = [];
    for (const [start, end] of commandHandlerRanges(src)) {
      for (let i = start; i <= end; i++) {
        if (/\b(getConnectedTab|requireDebuggerTab)\(\)/.test(src[i])) {
          offenders.push(`${i + 1}: ${src[i].trim()}`);
        }
      }
    }
    expect(offenders, "use resolveTargetTab(command) / requireDebuggerTab(command)").toEqual([]);
  });
});

describe("per-tab state cleanup", () => {
  it("should never clear a tab's state only when that tab is the primary one", () => {
    // The bug this encodes: the per-tab clears were introduced where the old *global* resets
    // lived, which was inside `=== debuggerAttachedTabId` guards. Globals self-healed there —
    // any primary disconnect reset the shared flag — but a per-tab record does not. A
    // non-primary tab that died holding coverage or a pinned frame poisoned anyCoverageActive()
    // / anyFramePinned() for the rest of the service-worker's life, and planIdleRelease holds on
    // both, so idle release never fired again and Chrome's "being debugged" banner never cleared.
    const src = readBackground();
    const offenders: string[] = [];
    for (let i = 0; i < src.length; i++) {
      const line = src[i];
      if (!line.includes("clearTabRuntimeState(") || line.includes("=>") || line.trim().startsWith("//")) continue;
      // Walk back to the nearest enclosing condition, stopping at the enclosing declaration.
      for (let j = i - 1; j >= 0 && j > i - 26; j--) {
        if (/^(async )?function |^chrome\./.test(src[j])) break;
        if (/if \(.*debuggerAttachedTabId/.test(src[j])) {
          offenders.push(`${i + 1}: guarded by line ${j + 1} — ${src[j].trim().slice(0, 60)}`);
          break;
        }
      }
    }
    expect(offenders, "a tab loses its state when IT dies, not when the primary tab does").toEqual([]);
  });

  it("should clear per-tab state from the canonical detach helper", () => {
    const src = readBackground().join("\n");
    const helper = /function forgetAttachedTab\(tabId: number\): void \{([\s\S]*?)\n\}/.exec(src);
    expect(helper, "forgetAttachedTab not found").toBeTruthy();
    expect(helper![1]).toContain("clearTabRuntimeState(tabId)");
  });
});

describe("tabId declarations", () => {
  const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");

  it("should declare tabId on every tab-scoped variant in the protocol", () => {
    const protocol = read("src/shared/protocol.ts").split("\n");
    const undeclared = TAB_SCOPED_COMMANDS.filter((c) => {
      const line = protocol.find((l) => new RegExp(`\\{\\s*type:\\s*"${c}"\\s*;`).test(l));
      return !line || !line.includes("tabId");
    });
    expect(undeclared, "protocol variants missing tabId").toEqual([]);
  });

  it("should expose tabId in the input schema of every tab-scoped tool", () => {
    const tools = read("src/mcp-server/tools.ts").split("\n");
    const missing: string[] = [];
    for (const c of TAB_SCOPED_COMMANDS) {
      const idx = tools.findIndex((l) => new RegExp(`^\\s*name: "${c}",\\s*$`).test(l));
      if (idx === -1) continue; // command with no matching tool (e.g. get_active_tab)
      const window = tools.slice(idx, idx + 14).join("\n");
      if (!window.includes("tabId: TAB_ID_SCHEMA")) missing.push(c);
    }
    expect(missing, "tools missing a tabId property").toEqual([]);
  });
});
