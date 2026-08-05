// Predict the full repeating set from a couple of picked examples.
//
// Ported from Selector Forge (MIT, © The Metrics Shop, Inc.). The pure
// xpath-generalization lives in `arrayXpath` so callers without a DOM can reuse
// it; this module resolves the generalized xpath against a document.

import { generalizeArrayXpath } from "./arrayXpath.js";

/** Every element matched by an xpath, in document order; [] on a bad xpath. */
function resolveAllByXpath(xpath: string, doc: Document): Element[] {
  const out: Element[] = [];
  try {
    const result = doc.evaluate(
      xpath,
      doc,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    for (let i = 0; i < result.snapshotLength; i++) {
      const node = result.snapshotItem(i);
      if (node instanceof Element) out.push(node);
    }
  } catch {
    /* malformed xpath — no prediction */
  }
  return out;
}

/**
 * Given picked target xpaths, predict the other sibling elements a single
 * generalized selector would match. Returns [] if the picks don't form a clean
 * array.
 */
export function predictListMatches(
  pickedXpaths: string[],
  doc: Document
): Element[] {
  const xpath = generalizeArrayXpath(pickedXpaths);
  if (!xpath) return [];
  return resolveAllByXpath(xpath, doc);
}
