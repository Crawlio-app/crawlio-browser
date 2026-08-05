import { describe, it, expect, afterEach } from "vitest";
import { installAgentCursorInPage } from "@/extension/injected/agent-cursor";

// Minimal DOM stub — jsdom is not a dependency, and the cursor controller only needs a
// handful of document/element members. This exercises the real controller logic in node.
interface StubEl {
  id: string;
  style: Record<string, string>;
  innerHTML: string;
  offsetWidth: number;
  setAttribute: (k: string, v: string) => void;
  appendChild: (el: StubEl) => void;
  addEventListener: (t: string, cb: (e: unknown) => void) => void;
  removeEventListener: (t: string, cb: (e: unknown) => void) => void;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
}

function makeEl(): StubEl {
  return {
    id: "",
    style: {},
    innerHTML: "",
    offsetWidth: 0,
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 100, height: 20 }),
  };
}

function installDom(visibilityState = "visible") {
  const byId: Record<string, StubEl> = {};
  const body = { appendChild: (el: StubEl) => { if (el.id) byId[el.id] = el; } };
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  g.window = {};
  g.document = {
    visibilityState,
    getElementById: (id: string) => byId[id] ?? null,
    createElement: () => makeEl(),
    body,
    documentElement: body,
  };
}

function cursor() {
  return (globalThis as unknown as { window: { __crawlioAgentCursor: any } }).window.__crawlioAgentCursor;
}

afterEach(() => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  delete g.window;
  delete g.document;
});

describe("agent cursor controller", () => {
  it("installs a controller on window and is idempotent", () => {
    installDom();
    installAgentCursorInPage();
    const first = cursor();
    expect(first).toBeTruthy();
    expect(typeof first.moveTo).toBe("function");
    expect(typeof first.moveToElement).toBe("function");
    expect(typeof first.hide).toBe("function");
    installAgentCursorInPage(); // second call must not replace the controller
    expect(cursor()).toBe(first);
  });

  it("moveTo positions the overlay and resolves with the coordinates (no animation)", async () => {
    installDom();
    installAgentCursorInPage();
    const res = await cursor().moveTo(150, 250, { animate: false });
    expect(res).toEqual({ x: 150, y: 250, animated: false });
  });

  it("creates a non-interactive, top-most overlay element", () => {
    installDom();
    installAgentCursorInPage();
    cursor().moveTo(10, 10, { animate: false });
    const el = (globalThis as unknown as { document: { getElementById: (id: string) => StubEl } })
      .document.getElementById("__crawlio_agent_cursor");
    expect(el).toBeTruthy();
    expect(el.style.pointerEvents).toBe("none");
    expect(el.style.position).toBe("fixed");
    expect(el.style.zIndex).toBe("2147483647");
    expect(el.style.transform).toContain("translate(10px, 10px)");
  });

  it("moveToElement targets the element center", async () => {
    installDom();
    installAgentCursorInPage();
    // rect = {left:20, top:40, width:100, height:20} -> center (70, 50)
    const res = await cursor().moveToElement(makeEl(), { animate: false });
    expect(res).toEqual({ x: 70, y: 50, animated: false });
  });

  it("does not animate when the document is hidden (resolves immediately)", async () => {
    installDom("hidden");
    installAgentCursorInPage();
    const res = await cursor().moveTo(5, 5, { animate: true });
    expect(res.animated).toBe(false); // hidden tab -> snapped, not animated
  });

  it("hide sets the overlay opacity to 0", () => {
    installDom();
    installAgentCursorInPage();
    cursor().moveTo(1, 1, { animate: false });
    cursor().hide();
    const el = (globalThis as unknown as { document: { getElementById: (id: string) => StubEl } })
      .document.getElementById("__crawlio_agent_cursor");
    expect(el.style.opacity).toBe("0");
  });
});
