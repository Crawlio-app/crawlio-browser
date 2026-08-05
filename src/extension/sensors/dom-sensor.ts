// DOM snapshot types and constants
// Actual implementations are self-contained in background.ts (captureDOMSnapshot)
// and content.ts (getDOMSnapshot) for CDP Runtime.evaluate compatibility

export interface DOMNode {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: DOMNode[];
  isShadowRoot?: boolean;
}

export interface SnapshotMetadata {
  sizeBytes: number;
  truncated: boolean;
  shadowRoots: number;
  iframeCount: number;
  depth: number;
}

export interface IframeCapture {
  src: string;
  content?: string;
}

export interface DOMSnapshot {
  tree: DOMNode;
  html: string;
  iframes: IframeCapture[];
  metadata: SnapshotMetadata;
}

export const SKIP_TAGS = ["SCRIPT", "STYLE", "SVG", "NOSCRIPT", "LINK", "META"];
export const MAX_TEXT_LENGTH = 200;
export const MAX_ATTR_LENGTH = 500;
export const DEFAULT_MAX_DEPTH = 10;
export const MAX_SNAPSHOT_SIZE = 5 * 1024 * 1024; // 5MB

// Inline event handlers to strip during sanitization (on* attributes)
export const EVENT_HANDLER_ATTRS = /^on[a-z]+$/i;
