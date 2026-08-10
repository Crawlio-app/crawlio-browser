/**
 * State that belongs to one tab rather than to the extension.
 *
 * These began as module globals, back when exactly one tab could be driven. Once any command can
 * name a tab, a global becomes a bug with a delay on it: `switch_to_frame` on tab A would retarget
 * every later evaluation on tab B, and framework detection would read whichever tab most recently
 * answered a navigation. Keyed by tab, each tab reads its own.
 *
 * Lives in shared/ rather than inside background.ts because background.ts is a service-worker
 * bundle with no exports — the only way to test anything in it is to parse its source, which
 * proves the code was typed, not that it works. Here the isolation itself is testable.
 */
export interface TabRuntimeState {
  /** Frame targeted by implicit frame-scoped evaluation; null = the main frame. */
  activeFrameId: string | null;
  cssCoverageActive: boolean;
  jsCoverageActive: boolean;
  /** Response headers of the tab's main document, read by framework detection. */
  mainDocResponseHeaders: Record<string, string>;
}

export interface TabRuntimeRegistry {
  /** This tab's state, created on first use. */
  get(tabId: number): TabRuntimeState;
  /** Drop one tab's state — call when it detaches or closes. */
  clear(tabId: number): void;
  /** Drop everything — for a full debugger teardown. */
  clearAll(): void;
  /** Whether any tab has a pinned frame; the idle check asks about the extension, not a tab. */
  anyFramePinned(): boolean;
  /** Whether any tab is collecting coverage. */
  anyCoverageActive(): boolean;
  /** Number of tabs holding state, so leaks are observable. */
  readonly size: number;
}

function freshState(): TabRuntimeState {
  return { activeFrameId: null, cssCoverageActive: false, jsCoverageActive: false, mainDocResponseHeaders: {} };
}

export function createTabRuntimeRegistry(): TabRuntimeRegistry {
  const states = new Map<number, TabRuntimeState>();
  return {
    get(tabId) {
      let state = states.get(tabId);
      if (!state) { state = freshState(); states.set(tabId, state); }
      return state;
    },
    clear(tabId) { states.delete(tabId); },
    clearAll() { states.clear(); },
    anyFramePinned() {
      for (const s of states.values()) if (s.activeFrameId !== null) return true;
      return false;
    },
    anyCoverageActive() {
      for (const s of states.values()) if (s.cssCoverageActive || s.jsCoverageActive) return true;
      return false;
    },
    get size() { return states.size; },
  };
}
