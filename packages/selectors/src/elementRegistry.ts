// Element registry + the verification oracle.
//
// Ported from Selector Forge (MIT, © The Metrics Shop, Inc.).
//
// `resolvesExactlyTo` is the heart of "verify before trust": a candidate
// selector is accepted only if it resolves to EXACTLY the expected element set —
// rejecting both over-matching (too many) and under-matching (too few/wrong).

import type { SelectorRecord } from "./contract.js";

export function queryAll(sel: SelectorRecord, root: Document): Element[] {
  try {
    if (sel.type === "css") {
      return Array.from(root.querySelectorAll(sel.value));
    }
    const r = root.evaluate(
      sel.value,
      root,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const out: Element[] = [];
    for (let i = 0; i < r.snapshotLength; i++) {
      const n = r.snapshotItem(i);
      if (n instanceof Element) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The verification oracle: true iff `sel` resolves to exactly `expected`
 * (same size, same members). An empty expected set never matches.
 */
export function resolvesExactlyTo(
  sel: SelectorRecord,
  expected: Element[],
  root: Document
): boolean {
  const expectedSet = new Set(expected);
  if (expectedSet.size === 0) return false;
  const foundSet = new Set(queryAll(sel, root));
  return (
    foundSet.size === expectedSet.size &&
    [...expectedSet].every((el) => foundSet.has(el))
  );
}

/** Maps elements to stable ids and back. Scoped per selector session. */
export class ElementRegistry {
  private toId = new WeakMap<Element, string>();
  private toEl = new Map<string, Element>();
  private counter = 0; // monotonically increasing counter for id generation

  idFor(el: Element): string {
    let id = this.toId.get(el);
    if (id === undefined) {
      id = `el-${++this.counter}`;
      this.toId.set(el, id);
      this.toEl.set(id, el);
    }
    return id;
  }

  // Seed an entry with a caller-supplied id. Used to re-anchor a registry
  // after a target-page reload: stored targets carry ids from the original
  // pre-reload registry, and the relocated DOM nodes must keep resolving under
  // those same ids. Bumps `counter` past any matching `el-N` id so future
  // `idFor` calls can't collide with it.
  register(el: Element, id: string): void {
    this.toId.set(el, id);
    this.toEl.set(id, el);
    const match = /^el-(\d+)$/.exec(id);
    if (match) {
      const n = Number(match[1]);
      if (n > this.counter) this.counter = n;
    }
  }

  elFor(id: string): Element | undefined {
    return this.toEl.get(id);
  }

  idsForSelector(sel: SelectorRecord, root: Document): string[] {
    return queryAll(sel, root).map((el) => this.idFor(el));
  }

  htmlFor(id: string, maxChars = 1200): string {
    const el = this.toEl.get(id);
    if (!el) return id;
    const html = el.outerHTML ?? "";
    return html.length > maxChars ? html.slice(0, maxChars) + " …" : html;
  }

  release(): void {
    this.toEl.clear();
    this.counter = 0;
  }
}
