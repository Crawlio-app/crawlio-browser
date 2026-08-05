// Robust XPath generation.
//
// Ported from Selector Forge (MIT, © The Metrics Shop, Inc.), whose
// implementation is in turn ported from Chromium DevTools (BSD-3, © The
// Chromium Authors — the recorder panel inspector). It short-circuits on `id`,
// handles ShadowDOM boundaries, and emits sibling indices only when a node
// actually has same-named siblings.
//
// Sources:
//   https://github.com/ChromeDevTools/devtools-frontend/blob/1c800e5a8d66d5cd8af8a394c753ad437889ac32/front_end/panels/recorder/injected/selectors/XPath.ts

class SelectorPart {
  constructor(readonly value: string, readonly optimized: boolean = false) {}

  toString(): string {
    return this.value;
  }
}

function attributeSelector(name: string, value: string): string {
  return `//*[@${name}=${JSON.stringify(value)}]`;
}

function areNodesSimilar(left: Node, right: Node): boolean {
  if (left === right) return true;
  if (left instanceof Element && right instanceof Element) {
    return left.localName === right.localName;
  }
  if (left.nodeType === right.nodeType) return true;
  // XPath treats CDATA as text nodes.
  const leftType =
    left.nodeType === Node.CDATA_SECTION_NODE ? Node.TEXT_NODE : left.nodeType;
  const rightType =
    right.nodeType === Node.CDATA_SECTION_NODE
      ? Node.TEXT_NODE
      : right.nodeType;
  return leftType === rightType;
}

function getXPathIndexInParent(node: Node): number {
  const children = node.parentNode ? node.parentNode.children : null;
  if (!children) return 0;

  let hasSameNamedElements = false;
  for (let i = 0; i < children.length; ++i) {
    if (areNodesSimilar(node, children[i]) && children[i] !== node) {
      hasSameNamedElements = true;
      break;
    }
  }
  if (!hasSameNamedElements) return 0;

  let ownIndex = 1; // XPath indices start with 1.
  for (let i = 0; i < children.length; ++i) {
    if (areNodesSimilar(node, children[i])) {
      if (children[i] === node) return ownIndex;
      ++ownIndex;
    }
  }
  throw new Error("This is impossible; a child must be the child of the parent");
}

function getSelectorPart(
  node: Node,
  optimized: boolean,
  attributes: string[]
): SelectorPart | undefined {
  let value: string;
  switch (node.nodeType) {
    case Node.ELEMENT_NODE: {
      if (!(node instanceof Element)) return undefined;
      if (optimized) {
        for (const attribute of attributes) {
          const attrValue = node.getAttribute(attribute) || "";
          if (attrValue) {
            return new SelectorPart(
              attributeSelector(attribute, attrValue),
              true
            );
          }
        }
      }
      if (node.id) {
        return new SelectorPart(attributeSelector("id", node.id), true);
      }
      value = node.localName;
      break;
    }
    case Node.ATTRIBUTE_NODE:
      value = "@" + node.nodeName;
      break;
    case Node.TEXT_NODE:
    case Node.CDATA_SECTION_NODE:
      value = "text()";
      break;
    case Node.PROCESSING_INSTRUCTION_NODE:
      value = "processing-instruction()";
      break;
    case Node.COMMENT_NODE:
      value = "comment()";
      break;
    case Node.DOCUMENT_NODE:
      value = "";
      break;
    default:
      value = "";
      break;
  }

  const index = getXPathIndexInParent(node);
  if (index > 0) value += `[${index}]`;
  return new SelectorPart(value, node.nodeType === Node.DOCUMENT_NODE);
}

/**
 * Compute a minimal XPath for `node`. Returns `undefined` when the path would
 * have to cross a shadow boundary (XPath cannot express that) or a part can't
 * be derived. `optimized` consults `attributes` (e.g. `data-testid`) for a
 * stable one-hop anchor before falling back to `id`/structural parts.
 */
export function computeXPath(
  node: Node,
  optimized: boolean = false,
  attributes: string[] = []
): string | undefined {
  if (node.nodeType === Node.DOCUMENT_NODE) return "/";

  const ownerDocument = node.ownerDocument ?? (node as Document);
  const selectors: string[] = [];
  let buffer: SelectorPart[] = [];
  let contextNode: Node | null = node;
  while (contextNode && contextNode !== ownerDocument) {
    const part = getSelectorPart(contextNode, optimized, attributes);
    if (!part) return undefined;
    buffer.unshift(part);
    contextNode = part.optimized
      ? contextNode.getRootNode()
      : contextNode.parentNode;
    if (contextNode instanceof ShadowRoot) {
      selectors.unshift((buffer[0].optimized ? "" : "/") + buffer.join("/"));
      buffer = [];
      contextNode = contextNode.host;
    }
  }

  if (buffer.length) {
    selectors.unshift((buffer[0].optimized ? "" : "/") + buffer.join("/"));
  }

  // XPath evaluation does not work across shadowRoot boundaries.
  if (!selectors.length || selectors.length > 1) return undefined;
  return selectors[0];
}
