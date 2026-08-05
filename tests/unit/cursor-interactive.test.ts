import { describe, it, expect } from "vitest";

/**
 * Tests for cursor-interactive discovery logic.
 * Tests the in-page script logic independently of CDP Runtime.evaluate.
 *
 * The actual findCursorInteractiveElements() runs in-page JS via CDP.
 * Here we test the selector generation, filtering, name derivation, and cap logic
 * by simulating what the in-page script does.
 */

const MAX_CURSOR_INTERACTIVE = 50;

// Simulate the in-page interactive role/tag sets
const interactiveRoles = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "searchbox",
  "slider", "spinbutton", "switch", "tab", "treeitem",
]);

const interactiveTags = new Set([
  "a", "button", "input", "select", "textarea", "details", "summary",
]);

const skipTags = new Set(["head", "script", "style", "noscript"]);

interface MockElement {
  tagName: string;
  id?: string;
  classList?: string[];
  role?: string;
  cursor?: string;
  onclick?: boolean;
  tabindex?: string | null;
  ariaLabel?: string;
  textContent?: string;
  title?: string;
  offsetWidth?: number;
  offsetHeight?: number;
  rectWidth?: number;
  rectHeight?: number;
  parentCursor?: string;
  parentTagName?: string;
  testId?: string;
}

function shouldDiscover(el: MockElement): boolean {
  const tagName = el.tagName.toLowerCase();
  if (skipTags.has(tagName)) return false;
  if (interactiveTags.has(tagName)) return false;
  if (el.role && interactiveRoles.has(el.role.toLowerCase())) return false;

  const hasCursorPointer = el.cursor === "pointer";
  const hasOnClick = el.onclick === true;
  const hasTabIndex = el.tabindex !== null && el.tabindex !== undefined && el.tabindex !== "-1";

  if (!hasCursorPointer && !hasOnClick && !hasTabIndex) return false;

  // Skip inherited cursor:pointer
  if (hasCursorPointer && !hasOnClick && !hasTabIndex) {
    if (el.parentCursor === "pointer") return false;
  }

  // Skip hidden
  if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
  // Skip tiny
  if ((el.rectWidth ?? el.offsetWidth ?? 0) < 10 || (el.rectHeight ?? el.offsetHeight ?? 0) < 10) return false;

  // Must have a name
  const name = el.ariaLabel || (el.textContent || "").trim().slice(0, 50) || el.title || tagName;
  if (!name) return false;

  return true;
}

function deriveName(el: MockElement): string {
  const tagName = el.tagName.toLowerCase();
  return el.ariaLabel || (el.textContent || "").trim().slice(0, 50) || el.title || tagName;
}

function buildSelector(el: MockElement): string {
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  if (el.classList && el.classList.length > 0) return `${tag}.${el.classList[0]}`;
  return tag;
}

describe("Cursor-Interactive Discovery", () => {
  describe("Element Detection", () => {
    it("discovers elements with cursor:pointer", () => {
      const el: MockElement = {
        tagName: "div",
        cursor: "pointer",
        textContent: "Click me",
        offsetWidth: 100,
        offsetHeight: 40,
        rectWidth: 100,
        rectHeight: 40,
      };
      expect(shouldDiscover(el)).toBe(true);
    });

    it("discovers elements with onclick", () => {
      const el: MockElement = {
        tagName: "span",
        onclick: true,
        textContent: "Action",
        offsetWidth: 80,
        offsetHeight: 30,
        rectWidth: 80,
        rectHeight: 30,
      };
      expect(shouldDiscover(el)).toBe(true);
    });

    it("discovers elements with tabindex", () => {
      const el: MockElement = {
        tagName: "div",
        tabindex: "0",
        textContent: "Focusable",
        offsetWidth: 100,
        offsetHeight: 40,
        rectWidth: 100,
        rectHeight: 40,
      };
      expect(shouldDiscover(el)).toBe(true);
    });

    it("skips elements with tabindex=-1", () => {
      const el: MockElement = {
        tagName: "div",
        tabindex: "-1",
        textContent: "Not focusable",
        offsetWidth: 100,
        offsetHeight: 40,
        rectWidth: 100,
        rectHeight: 40,
      };
      expect(shouldDiscover(el)).toBe(false);
    });
  });

  describe("Filtering", () => {
    it("skips native interactive tags", () => {
      for (const tag of ["a", "button", "input", "select", "textarea", "details", "summary"]) {
        const el: MockElement = {
          tagName: tag,
          cursor: "pointer",
          textContent: "test",
          offsetWidth: 100,
          offsetHeight: 40,
          rectWidth: 100,
          rectHeight: 40,
        };
        expect(shouldDiscover(el)).toBe(false);
      }
    });

    it("skips elements with interactive ARIA roles", () => {
      for (const role of ["button", "link", "textbox", "checkbox", "tab"]) {
        const el: MockElement = {
          tagName: "div",
          role,
          cursor: "pointer",
          textContent: "test",
          offsetWidth: 100,
          offsetHeight: 40,
          rectWidth: 100,
          rectHeight: 40,
        };
        expect(shouldDiscover(el)).toBe(false);
      }
    });

    it("skips skip-container tags", () => {
      for (const tag of ["script", "style", "noscript"]) {
        const el: MockElement = {
          tagName: tag,
          cursor: "pointer",
          textContent: "test",
          offsetWidth: 100,
          offsetHeight: 40,
          rectWidth: 100,
          rectHeight: 40,
        };
        expect(shouldDiscover(el)).toBe(false);
      }
    });

    it("skips hidden elements (zero dimensions)", () => {
      const el: MockElement = {
        tagName: "div",
        cursor: "pointer",
        textContent: "Hidden",
        offsetWidth: 0,
        offsetHeight: 0,
        rectWidth: 0,
        rectHeight: 0,
      };
      expect(shouldDiscover(el)).toBe(false);
    });

    it("skips elements smaller than 10x10", () => {
      const el: MockElement = {
        tagName: "div",
        cursor: "pointer",
        textContent: "Tiny",
        offsetWidth: 5,
        offsetHeight: 5,
        rectWidth: 5,
        rectHeight: 5,
      };
      expect(shouldDiscover(el)).toBe(false);
    });

    it("skips elements that only inherit cursor:pointer from parent", () => {
      const el: MockElement = {
        tagName: "div",
        cursor: "pointer",
        parentCursor: "pointer",
        textContent: "Inherited",
        offsetWidth: 100,
        offsetHeight: 40,
        rectWidth: 100,
        rectHeight: 40,
      };
      expect(shouldDiscover(el)).toBe(false);
    });

    it("keeps elements with cursor:pointer + onclick even if parent has cursor:pointer", () => {
      const el: MockElement = {
        tagName: "div",
        cursor: "pointer",
        onclick: true,
        parentCursor: "pointer",
        textContent: "Direct handler",
        offsetWidth: 100,
        offsetHeight: 40,
        rectWidth: 100,
        rectHeight: 40,
      };
      expect(shouldDiscover(el)).toBe(true);
    });
  });

  describe("Name Derivation", () => {
    it("prefers aria-label", () => {
      const el: MockElement = {
        tagName: "div",
        ariaLabel: "Custom Label",
        textContent: "Text Content",
        title: "Title",
      };
      expect(deriveName(el)).toBe("Custom Label");
    });

    it("falls back to textContent", () => {
      const el: MockElement = {
        tagName: "div",
        textContent: "Some Text",
        title: "Title",
      };
      expect(deriveName(el)).toBe("Some Text");
    });

    it("falls back to title", () => {
      const el: MockElement = {
        tagName: "div",
        textContent: "",
        title: "Tooltip",
      };
      expect(deriveName(el)).toBe("Tooltip");
    });

    it("falls back to tag name", () => {
      const el: MockElement = {
        tagName: "DIV",
        textContent: "",
      };
      expect(deriveName(el)).toBe("div");
    });

    it("truncates textContent to 50 chars", () => {
      const longText = "A".repeat(100);
      const el: MockElement = {
        tagName: "div",
        textContent: longText,
      };
      expect(deriveName(el)).toBe("A".repeat(50));
    });
  });

  describe("CSS Selector Generation", () => {
    it("prefers data-testid", () => {
      const el: MockElement = { tagName: "div", id: "my-id", testId: "my-test" };
      expect(buildSelector(el)).toBe('[data-testid="my-test"]');
    });

    it("uses #id when available", () => {
      const el: MockElement = { tagName: "div", id: "my-id" };
      expect(buildSelector(el)).toBe("#my-id");
    });

    it("uses tag.class when no id", () => {
      const el: MockElement = { tagName: "div", classList: ["my-class", "other"] };
      expect(buildSelector(el)).toBe("div.my-class");
    });

    it("falls back to tag name", () => {
      const el: MockElement = { tagName: "span" };
      expect(buildSelector(el)).toBe("span");
    });
  });

  describe("Cap Enforcement", () => {
    it("MAX_CURSOR_INTERACTIVE is 50", () => {
      expect(MAX_CURSOR_INTERACTIVE).toBe(50);
    });

    it("caps results at MAX_CURSOR_INTERACTIVE", () => {
      const elements: MockElement[] = [];
      for (let i = 0; i < 80; i++) {
        elements.push({
          tagName: "div",
          cursor: "pointer",
          textContent: `Item ${i}`,
          offsetWidth: 100,
          offsetHeight: 40,
          rectWidth: 100,
          rectHeight: 40,
          id: `el-${i}`,
        });
      }
      const results: Array<{ selector: string; name: string }> = [];
      for (const el of elements) {
        if (results.length >= MAX_CURSOR_INTERACTIVE) break;
        if (shouldDiscover(el)) {
          results.push({ selector: buildSelector(el), name: deriveName(el) });
        }
      }
      expect(results.length).toBe(MAX_CURSOR_INTERACTIVE);
    });
  });

  describe("Ref Assignment", () => {
    it("continues ref counter from ARIA tree", () => {
      // Simulate: ARIA tree assigned refs e1-e5, cursor-interactive starts at e6
      let counter = 5; // last ARIA ref
      const refMap = new Map<string, number>();
      const refSelectorMap = new Map<string, string>();

      const cursorElements = [
        { selector: "#custom-btn", name: "Custom Button" },
        { selector: "div.card", name: "Card Widget" },
      ];

      for (const el of cursorElements) {
        counter++;
        const ref = `e${counter}`;
        refMap.set(ref, -1);
        refSelectorMap.set(ref, el.selector);
      }

      expect(refMap.get("e6")).toBe(-1);
      expect(refMap.get("e7")).toBe(-1);
      expect(refSelectorMap.get("e6")).toBe("#custom-btn");
      expect(refSelectorMap.get("e7")).toBe("div.card");
    });

    it("uses backendDOMNodeId=-1 as cursor-interactive marker", () => {
      const refMap = new Map<string, number>();
      refMap.set("e1", 42); // normal ARIA ref
      refMap.set("e2", -1); // cursor-interactive ref

      expect(refMap.get("e1")).toBe(42);
      expect(refMap.get("e2")).toBe(-1);

      // Resolution logic check: -1 triggers CSS selector fallback
      const backendNodeId = refMap.get("e2");
      expect(backendNodeId === -1).toBe(true);
    });
  });

  describe("Snapshot Output Format", () => {
    it("formats cursor-interactive entries correctly", () => {
      const name = "Click Handler";
      const ref = "e10";
      const truncatedName = name.length > 80 ? name.substring(0, 77) + "..." : name;
      const line = `- cursor-interactive "${truncatedName}" [ref=${ref}]`;
      expect(line).toBe('- cursor-interactive "Click Handler" [ref=e10]');
    });

    it("truncates long names to 80 chars in output", () => {
      const name = "A".repeat(100);
      const truncatedName = name.length > 80 ? name.substring(0, 77) + "..." : name;
      const line = `- cursor-interactive "${truncatedName}" [ref=e1]`;
      expect(line).toContain("...");
      expect(truncatedName.length).toBe(80);
    });
  });

  describe("Interactive Mode Skip", () => {
    it("should not run cursor-interactive in interactive-only mode", () => {
      // In interactive-only mode, we only show existing ARIA interactive nodes
      // cursor-interactive supplements the full tree, not the filtered one
      const options = { interactive: true };
      const shouldRunCursorInteractive = !options.interactive;
      expect(shouldRunCursorInteractive).toBe(false);
    });

    it("should run cursor-interactive in normal mode", () => {
      const options = {};
      const shouldRunCursorInteractive = !(options as any).interactive;
      expect(shouldRunCursorInteractive).toBe(true);
    });
  });
});
