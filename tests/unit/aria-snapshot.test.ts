import { describe, it, expect } from "vitest";

/**
 * Tests for the ARIA snapshot logic extracted from generateAriaSnapshot().
 * We test the pure tree-building and formatting logic independently of CDP.
 * Updated for Phase 2: ARIA Snapshot Parity (interactive/compact/maxDepth/selector, role sets, RoleNameTracker, token estimation).
 */

// --- Role sets mirroring background.ts ---

const ARIA_INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio",
  "combobox", "listbox", "slider", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option",
  "switch", "searchbox", "spinbutton", "treeitem",
]);

const ARIA_LANDMARK_ROLES = new Set([
  "heading", "img", "navigation", "main", "banner",
  "contentinfo", "complementary", "form", "region",
]);

const ARIA_CONTENT_ROLES = new Set([
  "heading", "cell", "gridcell", "columnheader", "rowheader",
  "listitem", "article", "region", "main", "navigation",
]);

const ARIA_STRUCTURAL_ROLES = new Set([
  "generic", "group", "list", "table", "row", "rowgroup",
  "grid", "treegrid", "menu", "menubar", "toolbar",
  "tablist", "tree", "directory", "document", "application",
  "presentation", "none",
]);

const SNAPSHOT_MAX_NODES = 15000;

// --- RoleNameTracker mirroring background.ts ---

interface RoleNameTracker {
  counts: Map<string, number>;
  refsByKey: Map<string, string[]>;
  getKey(role: string, name: string): string;
  track(role: string, name: string, ref: string): number;
  getDuplicateKeys(): Set<string>;
}

function createRoleNameTracker(): RoleNameTracker {
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();
  return {
    counts,
    refsByKey,
    getKey(role: string, name: string): string {
      return `${role}:${name}`;
    },
    track(role: string, name: string, ref: string): number {
      const key = this.getKey(role, name);
      const idx = counts.get(key) ?? 0;
      counts.set(key, idx + 1);
      const refs = refsByKey.get(key) ?? [];
      refs.push(ref);
      refsByKey.set(key, refs);
      return idx;
    },
    getDuplicateKeys(): Set<string> {
      const dups = new Set<string>();
      for (const [key, refs] of refsByKey) {
        if (refs.length > 1) dups.add(key);
      }
      return dups;
    },
  };
}

// --- Options interface mirroring background.ts ---

interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
}

interface AriaState {
  refMap: Map<string, number>;
  counter: number;
}

/**
 * Pure version of generateAriaSnapshot tree logic for testing.
 * Mirrors the production code in background.ts (Phase 2 version).
 */
function buildAriaSnapshot(
  nodes: any[],
  options: SnapshotOptions = {},
): { snapshot: string; estimatedTokens: number; ariaState: AriaState; tracker: RoleNameTracker } {
  if (nodes.length > SNAPSHOT_MAX_NODES) {
    nodes.length = SNAPSHOT_MAX_NODES;
  }

  const ariaState: AriaState = { refMap: new Map(), counter: 0 };

  const childrenOf = new Map<string, any[]>();
  let rootNode: any = null;

  for (const node of nodes) {
    if (node.ignored) continue;
    if (node.parentId) {
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
      childrenOf.get(node.parentId)!.push(node);
    } else {
      rootNode = node;
    }
  }

  if (rootNode) {
    const knownIds = new Set<string>();
    for (const node of nodes) {
      if (!node.ignored) knownIds.add(node.nodeId);
    }
    for (const node of nodes) {
      if (node.ignored || !node.parentId || node === rootNode) continue;
      if (!knownIds.has(node.parentId)) {
        if (!childrenOf.has(rootNode.nodeId)) childrenOf.set(rootNode.nodeId, []);
        childrenOf.get(rootNode.nodeId)!.push(node);
      }
    }
  }

  const tracker = createRoleNameTracker();

  function hasInteractiveDescendant(node: any): boolean {
    if (node.ignored) return false;
    const role = node.role?.value || "";
    if (ARIA_INTERACTIVE_ROLES.has(role)) return true;
    const children = childrenOf.get(node.nodeId) || [];
    for (const child of children) {
      if (hasInteractiveDescendant(child)) return true;
    }
    return false;
  }

  function formatNode(node: any, depth: number): string {
    if (node.ignored) return "";

    if (options.maxDepth !== undefined && depth > options.maxDepth) return "";

    const role = node.role?.value || "";
    const name = node.name?.value || "";
    const children = childrenOf.get(node.nodeId) || [];
    const isInteractive = ARIA_INTERACTIVE_ROLES.has(role);
    const isContent = ARIA_CONTENT_ROLES.has(role);
    const isStructural = ARIA_STRUCTURAL_ROLES.has(role);
    const isLandmark = ARIA_LANDMARK_ROLES.has(role);

    // Interactive-only mode: skip non-interactive, recurse children
    if (options.interactive && !isInteractive) {
      const lines: string[] = [];
      for (const child of children) {
        const cl = formatNode(child, depth);
        if (cl) lines.push(cl);
      }
      return lines.join("\n");
    }

    // Presentational/none nodes: promote children
    if (role === "none" || role === "presentation") {
      if (children.length === 0) return "";
      const lines: string[] = [];
      for (const child of children) {
        const cl = formatNode(child, depth);
        if (cl) lines.push(cl);
      }
      return lines.join("\n");
    }

    // Generic wrappers with no name: promote children
    if (role === "generic" && !name) {
      if (children.length === 0) return "";
      const lines: string[] = [];
      for (const child of children) {
        const cl = formatNode(child, depth);
        if (cl) lines.push(cl);
      }
      return lines.join("\n");
    }

    // Group wrappers with no name and just one child: promote child
    if (role === "group" && !name && children.length === 1) {
      return formatNode(children[0], depth);
    }

    // Compact mode: skip unnamed structural nodes with no interactive descendants
    if (options.compact && isStructural && !name && !hasInteractiveDescendant(node)) {
      return "";
    }

    const indent = "  ".repeat(depth);
    const truncatedName = name.length > 80 ? name.substring(0, 77) + "..." : name;

    let label = "";
    if (role && role !== "generic") {
      label = role;
      if (truncatedName) label += ` "${truncatedName}"`;
    } else if (truncatedName) {
      label = `"${truncatedName}"`;
    }

    // Assign ref to interactive, named content, or named landmark nodes
    const shouldRef = isInteractive || (isContent && name) || (isLandmark && name);
    if (shouldRef && node.backendDOMNodeId) {
      ariaState.counter++;
      const ref = `e${ariaState.counter}`;
      const resolvedName = name || "";
      const nth = tracker.track(role, resolvedName, ref);
      ariaState.refMap.set(ref, node.backendDOMNodeId);
      if (label) {
        label += ` [ref=${ref}]`;
        if (nth > 0) label += ` [nth=${nth}]`;
      }
    }

    const childLines: string[] = [];
    for (const child of children) {
      const childLine = formatNode(child, depth + 1);
      if (childLine) childLines.push(childLine);
    }

    if (!label && childLines.length === 0) return "";
    if (!label && childLines.length > 0) return childLines.join("\n");

    const line = `${indent}- ${label}`;
    if (childLines.length > 0) return line + ":\n" + childLines.join("\n");
    return line;
  }

  if (!rootNode) {
    return { snapshot: "(empty page)", estimatedTokens: 0, ariaState, tracker };
  }

  const snapshot = formatNode(rootNode, 0) || "(empty page)";
  const estimatedTokens = Math.ceil(snapshot.length / 4);
  return { snapshot, estimatedTokens, ariaState, tracker };
}

// ===== TESTS =====

describe("ARIA Snapshot", () => {
  describe("role set completeness", () => {
    it("should cover all 17 interactive ARIA roles the snapshot addresses", () => {
      expect(ARIA_INTERACTIVE_ROLES.size).toBe(17);
    });

    it("should include the 4 roles added in Phase 2", () => {
      expect(ARIA_INTERACTIVE_ROLES.has("listbox")).toBe(true);
      expect(ARIA_INTERACTIVE_ROLES.has("menuitemcheckbox")).toBe(true);
      expect(ARIA_INTERACTIVE_ROLES.has("menuitemradio")).toBe(true);
      expect(ARIA_INTERACTIVE_ROLES.has("treeitem")).toBe(true);
    });

    it("should have 10 content roles", () => {
      expect(ARIA_CONTENT_ROLES.size).toBe(10);
      for (const role of ["heading", "cell", "gridcell", "columnheader", "rowheader", "listitem", "article", "region", "main", "navigation"]) {
        expect(ARIA_CONTENT_ROLES.has(role)).toBe(true);
      }
    });

    it("should have 18 structural roles", () => {
      expect(ARIA_STRUCTURAL_ROLES.size).toBe(18);
      for (const role of ["generic", "group", "list", "table", "row", "rowgroup", "grid", "treegrid", "menu", "menubar", "toolbar", "tablist", "tree", "directory", "document", "application", "presentation", "none"]) {
        expect(ARIA_STRUCTURAL_ROLES.has(role)).toBe(true);
      }
    });

    it("should not have overlapping roles between interactive and structural sets", () => {
      for (const role of ARIA_INTERACTIVE_ROLES) {
        expect(ARIA_STRUCTURAL_ROLES.has(role)).toBe(false);
      }
    });
  });

  describe("parentId reconstruction", () => {
    it("should build correct tree from flat CDP nodes with parentId", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Test Page" } },
        { nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "Main Nav" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "2", role: { value: "link" }, name: { value: "Home" }, backendDOMNodeId: 11 },
        { nodeId: "4", parentId: "2", role: { value: "link" }, name: { value: "About" }, backendDOMNodeId: 12 },
        { nodeId: "5", parentId: "1", role: { value: "main" }, name: { value: "Content" }, backendDOMNodeId: 13 },
        { nodeId: "6", parentId: "5", role: { value: "heading" }, name: { value: "Welcome" }, backendDOMNodeId: 14 },
        { nodeId: "7", parentId: "5", role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 15 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('navigation "Main Nav"');
      expect(snapshot).toContain('link "Home"');
      expect(snapshot).toContain('link "About"');
      expect(snapshot).toContain('main "Content"');
      expect(snapshot).toContain('heading "Welcome"');
      expect(snapshot).toContain('textbox "Search"');
    });
  });

  describe("orphan handling", () => {
    it("should attach orphan nodes to root when parent is missing", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "3", parentId: "999", role: { value: "button" }, name: { value: "Orphan Button" }, backendDOMNodeId: 20 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('button "Orphan Button"');
    });
  });

  describe("presentation node skipping", () => {
    it("should skip presentational nodes and promote their children", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "presentation" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Click Me" }, backendDOMNodeId: 30 },
        { nodeId: "4", parentId: "2", role: { value: "link" }, name: { value: "Go" }, backendDOMNodeId: 31 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).not.toContain("presentation");
      expect(snapshot).toContain('button "Click Me"');
      expect(snapshot).toContain('link "Go"');
    });

    it("should skip 'none' role nodes and promote children", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "none" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "heading" }, name: { value: "Title" }, backendDOMNodeId: 40 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).not.toContain("- none");
      expect(snapshot).toContain('heading "Title"');
    });
  });

  describe("safety cap", () => {
    it("should truncate nodes exceeding SNAPSHOT_MAX_NODES", () => {
      const nodes: any[] = [
        { nodeId: "0", role: { value: "RootWebArea" }, name: { value: "Big Page" } },
      ];
      for (let i = 1; i <= 20000; i++) {
        nodes.push({
          nodeId: String(i),
          parentId: "0",
          role: { value: "generic" },
          name: { value: `Item ${i}` },
        });
      }

      const { snapshot } = buildAriaSnapshot(nodes);
      const itemCount = (snapshot.match(/Item \d+/g) || []).length;
      expect(itemCount).toBeLessThanOrEqual(SNAPSHOT_MAX_NODES);
    });
  });

  describe("ref assignment", () => {
    it("should assign refs to interactive nodes with backendDOMNodeId", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Submit" }, backendDOMNodeId: 42 },
        { nodeId: "3", parentId: "1", role: { value: "link" }, name: { value: "Help" }, backendDOMNodeId: 43 },
      ];

      const { snapshot, ariaState } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain("[ref=e1]");
      expect(snapshot).toContain("[ref=e2]");
      expect(ariaState.refMap.get("e1")).toBe(42);
      expect(ariaState.refMap.get("e2")).toBe(43);
    });

    it("should assign refs to landmark nodes with names", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "Main" }, backendDOMNodeId: 50 },
        { nodeId: "3", parentId: "1", role: { value: "heading" }, name: { value: "Title" }, backendDOMNodeId: 51 },
      ];

      const { snapshot, ariaState } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain("[ref=e1]");
      expect(snapshot).toContain("[ref=e2]");
      expect(ariaState.refMap.get("e1")).toBe(50);
      expect(ariaState.refMap.get("e2")).toBe(51);
    });

    it("should assign refs to named content roles", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "cell" }, name: { value: "Price" }, backendDOMNodeId: 60 },
        { nodeId: "3", parentId: "1", role: { value: "article" }, name: { value: "Post 1" }, backendDOMNodeId: 61 },
      ];

      const { snapshot, ariaState } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain("[ref=e1]");
      expect(snapshot).toContain("[ref=e2]");
      expect(ariaState.refMap.get("e1")).toBe(60);
      expect(ariaState.refMap.get("e2")).toBe(61);
    });

    it("should not assign refs to unnamed content roles", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "cell" }, name: { value: "" }, backendDOMNodeId: 70 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).not.toContain("[ref=");
    });

    it("should not assign refs to nodes without backendDOMNodeId", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "No Backend" } },
      ];

      const { snapshot, ariaState } = buildAriaSnapshot(nodes);
      expect(snapshot).not.toContain("[ref=");
      expect(ariaState.refMap.size).toBe(0);
    });
  });

  describe("empty page", () => {
    it("should return '(empty page)' for empty nodes array", () => {
      const { snapshot } = buildAriaSnapshot([]);
      expect(snapshot).toBe("(empty page)");
    });

    it("should return '(empty page)' for only ignored nodes", () => {
      const { snapshot } = buildAriaSnapshot([
        { nodeId: "1", ignored: true, role: { value: "RootWebArea" }, name: { value: "" } },
      ]);
      expect(snapshot).toBe("(empty page)");
    });
  });

  describe("generic nodes", () => {
    it("should skip empty generic nodes without children", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "generic" }, name: { value: "" } },
        { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "OK" }, backendDOMNodeId: 60 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('button "OK"');
    });

    it("should render generic nodes with text content", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "generic" }, name: { value: "Some text" } },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('"Some text"');
    });
  });

  describe("name truncation", () => {
    it("should truncate names longer than 80 characters", () => {
      const longName = "A".repeat(90);
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: longName }, backendDOMNodeId: 70 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain("...");
      expect(snapshot).not.toContain(longName);
    });
  });

  // ===== Phase 2: New feature tests =====

  describe("interactive-only mode", () => {
    it("should show only interactive elements when interactive=true", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "Nav" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "2", role: { value: "heading" }, name: { value: "Section" }, backendDOMNodeId: 11 },
        { nodeId: "4", parentId: "2", role: { value: "link" }, name: { value: "Home" }, backendDOMNodeId: 12 },
        { nodeId: "5", parentId: "1", role: { value: "main" }, name: { value: "Content" }, backendDOMNodeId: 13 },
        { nodeId: "6", parentId: "5", role: { value: "button" }, name: { value: "Submit" }, backendDOMNodeId: 14 },
        { nodeId: "7", parentId: "5", role: { value: "article" }, name: { value: "Post" }, backendDOMNodeId: 15 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { interactive: true });
      expect(snapshot).toContain('link "Home"');
      expect(snapshot).toContain('button "Submit"');
      expect(snapshot).not.toContain("navigation");
      expect(snapshot).not.toContain("heading");
      expect(snapshot).not.toContain("main");
      expect(snapshot).not.toContain("article");
    });

    it("should find interactive elements nested under structural nodes", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "list" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "listitem" }, name: { value: "" } },
        { nodeId: "4", parentId: "3", role: { value: "link" }, name: { value: "Item 1" }, backendDOMNodeId: 20 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { interactive: true });
      expect(snapshot).toContain('link "Item 1"');
      expect(snapshot).not.toContain("list ");
      expect(snapshot).not.toContain("listitem");
    });

    it("should return (empty page) if no interactive elements exist", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Title" }, backendDOMNodeId: 30 },
        { nodeId: "3", parentId: "1", role: { value: "article" }, name: { value: "Content" }, backendDOMNodeId: 31 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { interactive: true });
      expect(snapshot).toBe("(empty page)");
    });

    it("should significantly reduce output size compared to full mode", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
      ];
      // Add many structural + a few interactive
      for (let i = 2; i <= 50; i++) {
        nodes.push({
          nodeId: String(i),
          parentId: "1",
          role: { value: i % 10 === 0 ? "button" : "heading" },
          name: { value: `Element ${i}` },
          backendDOMNodeId: i + 100,
        });
      }

      const full = buildAriaSnapshot(nodes);
      const interactive = buildAriaSnapshot(nodes, { interactive: true });
      expect(interactive.snapshot.length).toBeLessThan(full.snapshot.length);
    });
  });

  describe("compact mode", () => {
    it("should remove unnamed structural nodes with no interactive descendants", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "list" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "listitem" }, name: { value: "Static text" } },
        { nodeId: "4", parentId: "1", role: { value: "toolbar" }, name: { value: "" } },
        { nodeId: "5", parentId: "4", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 40 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { compact: true });
      // list with only static text content → removed
      expect(snapshot).not.toContain("listitem");
      // toolbar with interactive descendant → kept
      expect(snapshot).toContain('button "Save"');
    });

    it("should keep named structural nodes even without interactive descendants", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "list" }, name: { value: "Categories" } },
        { nodeId: "3", parentId: "2", role: { value: "listitem" }, name: { value: "Sports" } },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { compact: true });
      expect(snapshot).toContain('list "Categories"');
    });

    it("should keep structural nodes that have interactive descendants", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "table" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "row" }, name: { value: "" } },
        { nodeId: "4", parentId: "3", role: { value: "link" }, name: { value: "Edit" }, backendDOMNodeId: 50 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { compact: true });
      expect(snapshot).toContain('link "Edit"');
    });

    it("should reduce output size compared to non-compact mode", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
      ];
      // Many structural lists with only static children (no interactive descendants)
      for (let i = 2; i <= 20; i++) {
        nodes.push({
          nodeId: String(i),
          parentId: "1",
          role: { value: "list" },
          name: { value: "" },
        });
        // Give each list multiple static children (avoids single-child group collapse)
        nodes.push({
          nodeId: `${i}a`,
          parentId: String(i),
          role: { value: "listitem" },
          name: { value: `Item ${i}a` },
        });
        nodes.push({
          nodeId: `${i}b`,
          parentId: String(i),
          role: { value: "listitem" },
          name: { value: `Item ${i}b` },
        });
      }
      // One toolbar with a button
      nodes.push({ nodeId: "99", parentId: "1", role: { value: "toolbar" }, name: { value: "" } });
      nodes.push({ nodeId: "100", parentId: "99", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 999 });

      const full = buildAriaSnapshot(nodes);
      const compact = buildAriaSnapshot(nodes, { compact: true });
      expect(compact.snapshot.length).toBeLessThan(full.snapshot.length);
      expect(compact.snapshot).toContain('button "Go"');
    });
  });

  describe("maxDepth limiting", () => {
    it("should cap tree depth at maxDepth=0 (root only)", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Deep" }, backendDOMNodeId: 10 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { maxDepth: 0 });
      expect(snapshot).toContain("RootWebArea");
      expect(snapshot).not.toContain("Deep");
    });

    it("should show one level of children at maxDepth=1", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "Nav" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "2", role: { value: "link" }, name: { value: "Deep Link" }, backendDOMNodeId: 11 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { maxDepth: 1 });
      expect(snapshot).toContain("navigation");
      expect(snapshot).not.toContain("Deep Link");
    });

    it("should show all levels when maxDepth is not set", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "Nav" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "2", role: { value: "link" }, name: { value: "Deep Link" }, backendDOMNodeId: 11 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain("navigation");
      expect(snapshot).toContain("Deep Link");
    });

    it("should handle deeply nested trees with maxDepth=2", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "main" }, name: { value: "Main" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "2", role: { value: "navigation" }, name: { value: "Sub" }, backendDOMNodeId: 11 },
        { nodeId: "4", parentId: "3", role: { value: "link" }, name: { value: "Excluded" }, backendDOMNodeId: 12 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { maxDepth: 2 });
      expect(snapshot).toContain("main");
      expect(snapshot).toContain("navigation");
      expect(snapshot).not.toContain("Excluded");
    });
  });

  describe("RoleNameTracker", () => {
    it("should track duplicate role+name combos and add nth annotation", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 11 },
        { nodeId: "4", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 12 },
      ];

      const { snapshot, tracker } = buildAriaSnapshot(nodes);
      // First occurrence: nth=0 (not shown)
      // Second: nth=1
      // Third: nth=2
      expect(snapshot).toContain("[nth=1]");
      expect(snapshot).toContain("[nth=2]");
      // Tracker should have 3 refs for button:Save
      const key = tracker.getKey("button", "Save");
      expect(tracker.counts.get(key)).toBe(3);
      expect(tracker.getDuplicateKeys().has(key)).toBe(true);
    });

    it("should not add nth for unique role+name combos", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Cancel" }, backendDOMNodeId: 11 },
        { nodeId: "4", parentId: "1", role: { value: "link" }, name: { value: "Help" }, backendDOMNodeId: 12 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).not.toContain("[nth=");
    });

    it("should distinguish different roles with same name", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Edit" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "1", role: { value: "link" }, name: { value: "Edit" }, backendDOMNodeId: 11 },
      ];

      const { snapshot, tracker } = buildAriaSnapshot(nodes);
      // Different roles, same name — NOT duplicates
      expect(snapshot).not.toContain("[nth=");
      expect(tracker.getDuplicateKeys().size).toBe(0);
    });

    it("should handle createRoleNameTracker operations correctly", () => {
      const t = createRoleNameTracker();
      expect(t.track("button", "Save", "e1")).toBe(0);
      expect(t.track("button", "Save", "e2")).toBe(1);
      expect(t.track("button", "Save", "e3")).toBe(2);
      expect(t.track("link", "Save", "e4")).toBe(0);

      const dups = t.getDuplicateKeys();
      expect(dups.has("button:Save")).toBe(true);
      expect(dups.has("link:Save")).toBe(false);
      expect(t.refsByKey.get("button:Save")).toEqual(["e1", "e2", "e3"]);
    });
  });

  describe("token estimation", () => {
    it("should return estimatedTokens = Math.ceil(length / 4)", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "OK" }, backendDOMNodeId: 10 },
      ];

      const { snapshot, estimatedTokens } = buildAriaSnapshot(nodes);
      expect(estimatedTokens).toBe(Math.ceil(snapshot.length / 4));
    });

    it("should return 0 tokens for empty page", () => {
      const { estimatedTokens } = buildAriaSnapshot([]);
      expect(estimatedTokens).toBe(0);
    });

    it("should scale with content size", () => {
      const small = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "OK" }, backendDOMNodeId: 10 },
      ];
      const large = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
      ];
      for (let i = 2; i <= 50; i++) {
        large.push({
          nodeId: String(i),
          parentId: "1",
          role: { value: "button" },
          name: { value: `Button ${i}` },
          backendDOMNodeId: i + 100,
        });
      }

      const smallResult = buildAriaSnapshot(small);
      const largeResult = buildAriaSnapshot(large);
      expect(largeResult.estimatedTokens).toBeGreaterThan(smallResult.estimatedTokens);
    });
  });

  describe("group collapse", () => {
    it("should promote single child of unnamed group", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "group" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Promoted" }, backendDOMNodeId: 10 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('button "Promoted"');
      expect(snapshot).not.toContain("group");
    });

    it("should keep named groups", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "group" }, name: { value: "Actions" } },
        { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 10 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('group "Actions"');
      expect(snapshot).toContain('button "Save"');
    });
  });

  describe("combined options", () => {
    it("should apply interactive + maxDepth together", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "Nav" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "2", role: { value: "link" }, name: { value: "Shallow" }, backendDOMNodeId: 11 },
        { nodeId: "4", parentId: "1", role: { value: "main" }, name: { value: "Main" }, backendDOMNodeId: 12 },
        { nodeId: "5", parentId: "4", role: { value: "group" }, name: { value: "" } },
        { nodeId: "6", parentId: "5", role: { value: "button" }, name: { value: "Deep" }, backendDOMNodeId: 13 },
      ];

      // interactive: skip non-interactive; maxDepth=1: skip depth > 1
      // In interactive mode, structural nodes are flattened, so depth tracking differs.
      // link "Shallow" is at depth 2 under nav (which is flattened), effectively depth 0 in interactive mode
      const { snapshot } = buildAriaSnapshot(nodes, { interactive: true, maxDepth: 1 });
      expect(snapshot).toContain('link "Shallow"');
      // button "Deep" is at depth 3 (main > group > button), but in interactive mode structural is flattened
      expect(snapshot).toContain('button "Deep"');
    });

    it("should apply compact + maxDepth together", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "toolbar" }, name: { value: "" } },
        { nodeId: "3", parentId: "2", role: { value: "heading" }, name: { value: "No interactive" }, backendDOMNodeId: 10 },
        { nodeId: "4", parentId: "1", role: { value: "navigation" }, name: { value: "Nav" }, backendDOMNodeId: 11 },
        { nodeId: "5", parentId: "4", role: { value: "link" }, name: { value: "Home" }, backendDOMNodeId: 12 },
      ];

      const { snapshot } = buildAriaSnapshot(nodes, { compact: true, maxDepth: 1 });
      // toolbar has no interactive descendants → removed by compact
      expect(snapshot).not.toContain("toolbar");
      // navigation kept (has interactive descendant), link at depth 2 → excluded by maxDepth
      expect(snapshot).toContain("navigation");
      expect(snapshot).not.toContain("Home");
    });
  });

  describe("new Phase 2 interactive roles", () => {
    it("should assign refs to listbox elements", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "listbox" }, name: { value: "Colors" }, backendDOMNodeId: 10 },
      ];
      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain("[ref=");
      expect(snapshot).toContain('listbox "Colors"');
    });

    it("should assign refs to menuitemcheckbox and menuitemradio", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "menuitemcheckbox" }, name: { value: "Bold" }, backendDOMNodeId: 10 },
        { nodeId: "3", parentId: "1", role: { value: "menuitemradio" }, name: { value: "Small" }, backendDOMNodeId: 11 },
      ];
      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('menuitemcheckbox "Bold" [ref=e1]');
      expect(snapshot).toContain('menuitemradio "Small" [ref=e2]');
    });

    it("should assign refs to treeitem elements", () => {
      const nodes = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "2", parentId: "1", role: { value: "treeitem" }, name: { value: "Folder" }, backendDOMNodeId: 10 },
      ];
      const { snapshot } = buildAriaSnapshot(nodes);
      expect(snapshot).toContain('treeitem "Folder" [ref=e1]');
    });
  });
});
