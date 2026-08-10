import { describe, it, expect, beforeEach } from "vitest";
import { createTabRuntimeRegistry, type TabRuntimeRegistry } from "../../src/shared/tab-runtime-state.js";

describe("TabRuntimeRegistry", () => {
  let reg: TabRuntimeRegistry;
  beforeEach(() => { reg = createTabRuntimeRegistry(); });

  it("should start every tab on the main frame with no coverage and no headers", () => {
    expect(reg.get(1)).toEqual({
      activeFrameId: null, cssCoverageActive: false, jsCoverageActive: false, mainDocResponseHeaders: {},
    });
  });

  it("should return the same object for the same tab so writes stick", () => {
    reg.get(1).activeFrameId = "frame-a";
    expect(reg.get(1).activeFrameId).toBe("frame-a");
  });

  it("should keep two tabs' frame targeting independent", () => {
    // The bug this prevents: switch_to_frame on tab 1 retargeting tab 2's evaluations.
    reg.get(1).activeFrameId = "frame-a";
    reg.get(2).activeFrameId = "frame-b";
    expect(reg.get(1).activeFrameId).toBe("frame-a");
    expect(reg.get(2).activeFrameId).toBe("frame-b");

    reg.get(1).activeFrameId = null;
    expect(reg.get(2).activeFrameId).toBe("frame-b");
  });

  it("should keep two tabs' coverage sessions independent", () => {
    reg.get(1).cssCoverageActive = true;
    reg.get(2).jsCoverageActive = true;
    expect(reg.get(1).jsCoverageActive).toBe(false);
    expect(reg.get(2).cssCoverageActive).toBe(false);
  });

  it("should keep two tabs' main-document headers independent", () => {
    // The bug this prevents: framework detection on tab 2 reading tab 1's headers and
    // reporting the wrong framework.
    reg.get(1).mainDocResponseHeaders = { "x-powered-by": "Next.js" };
    reg.get(2).mainDocResponseHeaders = { "x-powered-by": "Rails" };
    expect(reg.get(1).mainDocResponseHeaders["x-powered-by"]).toBe("Next.js");
    expect(reg.get(2).mainDocResponseHeaders["x-powered-by"]).toBe("Rails");
  });

  it("should not share the default header object between tabs", () => {
    reg.get(1).mainDocResponseHeaders["a"] = "1";
    expect(reg.get(2).mainDocResponseHeaders).toEqual({});
  });

  describe("clear", () => {
    it("should drop one tab and leave the others", () => {
      reg.get(1).activeFrameId = "frame-a";
      reg.get(2).activeFrameId = "frame-b";
      reg.clear(1);
      expect(reg.get(1).activeFrameId).toBeNull();
      expect(reg.get(2).activeFrameId).toBe("frame-b");
    });

    it("should shrink the registry so a closed tab cannot leak", () => {
      reg.get(1); reg.get(2); reg.get(3);
      expect(reg.size).toBe(3);
      reg.clear(2);
      expect(reg.size).toBe(2);
    });

    it("should tolerate clearing a tab that was never seen", () => {
      expect(() => reg.clear(999)).not.toThrow();
      expect(reg.size).toBe(0);
    });

    it("should drop everything on clearAll", () => {
      reg.get(1).cssCoverageActive = true;
      reg.get(2).activeFrameId = "f";
      reg.clearAll();
      expect(reg.size).toBe(0);
      expect(reg.anyCoverageActive()).toBe(false);
      expect(reg.anyFramePinned()).toBe(false);
    });
  });

  describe("aggregates", () => {
    it("should report no frame pinned and no coverage when empty", () => {
      expect(reg.anyFramePinned()).toBe(false);
      expect(reg.anyCoverageActive()).toBe(false);
    });

    it("should not count a tab that merely exists", () => {
      // The idle check asks whether the extension is busy; a tab that was touched but is sitting
      // on the main frame with no coverage must not hold the debugger banner open.
      reg.get(1); reg.get(2);
      expect(reg.anyFramePinned()).toBe(false);
      expect(reg.anyCoverageActive()).toBe(false);
    });

    it("should report a frame pinned when any tab has one", () => {
      reg.get(1); reg.get(2).activeFrameId = "frame-b";
      expect(reg.anyFramePinned()).toBe(true);
      reg.get(2).activeFrameId = null;
      expect(reg.anyFramePinned()).toBe(false);
    });

    it("should report coverage active for either kind on any tab", () => {
      reg.get(1).jsCoverageActive = true;
      expect(reg.anyCoverageActive()).toBe(true);
      reg.get(1).jsCoverageActive = false;
      reg.get(2).cssCoverageActive = true;
      expect(reg.anyCoverageActive()).toBe(true);
    });
  });
});
