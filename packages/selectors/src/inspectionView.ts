// Compact DOM serialization for LLM input.
//
// Ported from Selector Forge (MIT, © The Metrics Shop, Inc.). Builds a compact
// representation of the DOM around the picked targets:
//   1. Compute child-index path per target against the live tree.
//   2. Clone <body>. Stamp `element_id` on cloned target equivalents.
//   3. Prune <script>/<style>/<noscript>/<link>/<meta> subtrees.
//   4. Truncate long attribute values (zero out geometry attrs).
//   5. Keep targets + ancestor chains + a small sibling window; collapse the
//      rest so the model sees structural context, not megabytes of noise.
//   6. Serialize, with a final safety-net length cap.
//
// Adapted for portability/testability: the owner document is derived from the
// targets (falling back to the global `document`) so it runs both in-extension
// and under a jsdom test harness.

const MAX_ATTR_LENGTH = 200;
const MAX_OUTPUT_SIZE = 250_000;
const NOISE_SELECTOR = "script, style, noscript, link, meta";
const SIBLING_RADIUS = 3;
const COLLAPSED_MARKER = "…";

const GEOMETRY_ATTRS = new Set([
  "d",
  "points",
  "transform",
  "viewBox",
  "preserveAspectRatio",
  "gradientTransform",
  "patternTransform",
]);

export interface InspectionTarget {
  el: Element;
  id: string;
}

function ownerDocOf(targets: InspectionTarget[]): Document | undefined {
  const fromTarget = targets[0]?.el.ownerDocument ?? undefined;
  if (fromTarget) return fromTarget;
  return typeof document !== "undefined" ? document : undefined;
}

/**
 * Build the inspection-view payload from the currently picked targets.
 * Reads the live DOM, returns a string. Does not mutate the page.
 */
export function buildInspectionView(targets: InspectionTarget[]): string {
  const doc = ownerDocOf(targets);
  const body = doc?.body;
  if (!doc || !body) return "";

  const taggedPaths: { path: number[]; id: string }[] = [];
  for (const { el, id } of targets) {
    const path = childIndexPath(el, body);
    if (path) taggedPaths.push({ path, id });
  }

  const clone = body.cloneNode(true) as HTMLElement;

  const cloneTargets: Element[] = [];
  for (const { path, id } of taggedPaths) {
    const node = nodeAtPath(clone, path);
    if (node) {
      node.setAttribute("element_id", id);
      cloneTargets.push(node);
    }
  }

  prune(clone);
  truncateAttrs(clone);
  if (cloneTargets.length > 0) {
    compactIrrelevant(clone, cloneTargets, doc);
  }

  let html = clone.outerHTML;
  if (html.length > MAX_OUTPUT_SIZE) {
    html =
      html.slice(0, MAX_OUTPUT_SIZE) + "\n<!-- inspection view truncated -->";
  }
  return html;
}

function childIndexPath(el: Element, root: Element): number[] | null {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return null;
    path.unshift(Array.from(parent.children).indexOf(cur));
    cur = parent;
  }
  return cur === root ? path : null;
}

function nodeAtPath(root: Element, path: number[]): Element | null {
  let cur: Element = root;
  for (const i of path) {
    const next = cur.children[i];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

function prune(root: Element): void {
  root.querySelectorAll(NOISE_SELECTOR).forEach((n) => n.remove());
}

function truncateAttrs(root: Element): void {
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.length <= MAX_ATTR_LENGTH) continue;
      el.setAttribute(
        attr.name,
        GEOMETRY_ATTRS.has(attr.name)
          ? ""
          : attr.value.slice(0, MAX_ATTR_LENGTH) + COLLAPSED_MARKER
      );
    }
  }
}

/**
 * Replace the children of any element that isn't on a target's ancestor chain
 * (or within SIBLING_RADIUS of one of those ancestors) with `…`. Preserves the
 * tag + attributes so the model sees the structural skeleton.
 */
function compactIrrelevant(
  root: Element,
  targets: Element[],
  doc: Document
): void {
  const relevant = buildRelevantSet(root, targets);

  const stack: Element[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!relevant.has(node)) {
      collapseChildren(node, doc);
      continue;
    }
    for (const child of Array.from(node.children)) {
      stack.push(child);
    }
  }
}

function buildRelevantSet(root: Element, targets: Element[]): WeakSet<Element> {
  const relevant = new WeakSet<Element>();
  relevant.add(root);

  for (const target of targets) {
    let cur: Element | null = target;
    while (cur && cur !== root) {
      relevant.add(cur);
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const siblings: Element[] = Array.from(parent.children);
        const idx = siblings.indexOf(cur);
        const start = Math.max(0, idx - SIBLING_RADIUS);
        const end = Math.min(siblings.length, idx + SIBLING_RADIUS + 1);
        for (let i = start; i < end; i++) relevant.add(siblings[i]);
      }
      cur = parent;
    }
  }

  return relevant;
}

function collapseChildren(el: Element, doc: Document): void {
  // Keep elements whose only child is a short text node — tiny and often the
  // only signal worth seeing.
  const kids = Array.from(el.childNodes);
  if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) {
    const text = kids[0].textContent ?? "";
    if (text.length <= MAX_ATTR_LENGTH) return;
  }
  if (kids.length === 0) return;

  el.replaceChildren(doc.createTextNode(COLLAPSED_MARKER));
}
