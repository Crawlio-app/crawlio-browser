import { AsyncLocalStorage } from "node:async_hooks";
import { isTabScopedCommand } from "../shared/tab-scoped-commands.js";

/**
 * The tab the in-flight tool call is targeting, if it named one.
 *
 * Full-mode tools parse their arguments with Zod, which strips keys the schema does not declare,
 * so a caller's `tabId` would be discarded before the handler ever reached the bridge. Threading
 * it through instead would mean editing 46 handlers and their 46 Zod schemas, and every handler
 * added later would silently drop it again.
 *
 * So the tab rides alongside the call rather than through it: index.ts opens a context around the
 * handler, and `send()` stamps the outgoing command from that context. One wrap point, and a new
 * tab-scoped tool inherits targeting without its author doing anything.
 */
const targetTab = new AsyncLocalStorage<number>();

/** Run `fn` with `tabId` as the ambient target. A non-tab or absent id runs `fn` unchanged. */
export function withTargetTab<T>(tabId: unknown, fn: () => T): T {
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return fn();
  return targetTab.run(tabId, fn);
}

/**
 * Stamp the ambient target onto a command that acts on a tab.
 *
 * Three guards, each load-bearing: an explicit `tabId` always wins, so code mode's
 * `bridge.send({..., tabId})` is never second-guessed; commands outside TAB_SCOPED_COMMANDS are
 * left alone, so `close_tab`'s tabId (which names its victim, not its context) can't be
 * overwritten; and with no ambient target the command is returned as-is, which is every call
 * made before this existed.
 */
export function applyTargetTab<C extends Record<string, unknown>>(command: C): C {
  if (command.tabId !== undefined) return command;
  const ambient = targetTab.getStore();
  if (ambient === undefined || !isTabScopedCommand(command.type)) return command;
  return { ...command, tabId: ambient };
}

/** The ambient target, for tests and diagnostics. */
export function currentTargetTab(): number | undefined {
  return targetTab.getStore();
}
