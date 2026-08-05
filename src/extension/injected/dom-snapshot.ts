// DOM snapshot function — injected into page via cdpExecuteFunction (Runtime.evaluate)
// MUST be self-contained: no imports, no closures, no external references
// ah-18: shadow DOM serialization + iframe capture + size limiting + sanitization
 
export function captureDOMSnapshot(maxDepth: number): any {
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META"]);
  const EVENT_RE = /^on[a-z]+$/i;
  const MAX_TEXT = 200;
  const MAX_ATTR = 500;
  const MAX_SNAPSHOT = 5 * 1024 * 1024; // 5MB
  const MAX_NODES = 50_000;
  let nodeCount = 0;
  let nodeLimitReached = false;
  let shadowRootCount = 0;
  let maxDepthReached = 0;

  function walk(node: Element, depth: number): any {
    if (depth > maxDepth) return null;
    if (nodeCount >= MAX_NODES) { nodeLimitReached = true; return null; }
    nodeCount++;
    if (depth > maxDepthReached) maxDepthReached = depth;
    const tag = node.tagName?.toLowerCase();
    if (!tag || SKIP_TAGS.has(node.tagName)) return null;

    const result: any = { tag };

    // Attributes (sanitized: strip on* event handlers)
    if (node.attributes.length > 0) {
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(node.attributes)) {
        if (EVENT_RE.test(attr.name)) continue;
        let val = attr.value;
        if (val.length > MAX_ATTR) val = val.slice(0, MAX_ATTR) + "...";
        attrs[attr.name] = val;
      }
      result.attrs = attrs;
    }

    // Text content (leaf nodes only)
    if (node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        result.text = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "..." : text;
      }
    }

    // Children
    const children: any[] = [];
    for (const child of Array.from(node.children)) {
      const c = walk(child, depth + 1);
      if (c) children.push(c);
    }

    // Shadow DOM traversal
    if (node.shadowRoot) {
      shadowRootCount++;
      for (const child of Array.from(node.shadowRoot.children)) {
        const c = walk(child, depth + 1);
        if (c) { c.isShadowRoot = true; children.push(c); }
      }
    }

    if (children.length > 0) result.children = children;
    return result;
  }

  // Build tree
  const tree = walk(document.documentElement, 0);

  // Capture iframes (same-origin via contentDocument, cross-origin URL only)
  const iframes: Array<{ src: string; content?: string }> = [];
  for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
    try {
      const iframeEl = iframe as HTMLIFrameElement;
      const innerDoc = iframeEl.contentDocument;
      if (innerDoc) {
        iframes.push({ src: iframeEl.src, content: innerDoc.documentElement.outerHTML });
      } else {
        iframes.push({ src: iframeEl.src });
      }
    } catch { /* cross-origin iframe — access denied */
      iframes.push({ src: (iframe as HTMLIFrameElement).src });
    }
  }

  // HTML snapshot with shadow DOM serialization
  function serializeNode(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent || "";
    if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
    let h = "";
    for (const child of Array.from(n.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        h += serializeElement(child as Element);
      } else if (child.nodeType === Node.TEXT_NODE) {
        h += child.textContent || "";
      }
    }
    return h;
  }

  function serializeElement(el: Element): string {
    const t = el.tagName.toLowerCase();
    if (t === "script") return "<script>[stripped]</script>";
    const attrs = Array.from(el.attributes)
      .filter(a => !EVENT_RE.test(a.name))
      .map(a => ` ${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join("");
    let inner = "";
    if (el.shadowRoot) {
      inner += `<template shadowrootmode="${el.shadowRoot.mode}">`;
      inner += serializeNode(el.shadowRoot);
      inner += "</template>";
    }
    inner += serializeNode(el);
    return `<${t}${attrs}>${inner}</${t}>`;
  }

  let html = serializeElement(document.documentElement);

  // Size limiting with progressive stripping
  let truncated = false;
  if (html.length > MAX_SNAPSHOT) {
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script>[stripped]</script>");
    truncated = true;
  }
  if (html.length > MAX_SNAPSHOT) {
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style>[stripped]</style>");
  }
  if (html.length > MAX_SNAPSHOT) {
    html = html.slice(0, MAX_SNAPSHOT);
  }

  const metadata = {
    sizeBytes: html.length,
    truncated: truncated || nodeLimitReached,
    shadowRoots: shadowRootCount,
    iframeCount: iframes.length,
    depth: maxDepthReached,
    ...(nodeLimitReached ? { _truncated: true, nodeCount, maxNodes: MAX_NODES } : {}),
  };

  return { tree, html, iframes, metadata };
}
