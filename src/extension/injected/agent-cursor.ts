// Visible "agent cursor" overlay — a synthetic pointer the agent moves before it acts, so a
// human can watch where automation is happening. Injected into the page main world via CDP Runtime.evaluate /
// Page.addScriptToEvaluateOnNewDocument.
//
// MUST be self-contained: no imports, no closures, no external references — the function is
// stringified (`.toString()`) and evaluated inside the target page.

export interface AgentCursorMoveResult {
  x: number;
  y: number;
  animated: boolean;
}

 
export function installAgentCursorInPage(): void {
  var w = window as any;
  if (w.__crawlioAgentCursor) return; // idempotent — survives repeated injection
  var ID = "__crawlio_agent_cursor";

  function ensureEl(): HTMLElement {
    var existing = document.getElementById(ID);
    if (existing) return existing;
    var el = document.createElement("div");
    el.id = ID;
    el.setAttribute("aria-hidden", "true");
    var s = el.style;
    s.position = "fixed";
    s.left = "0px";
    s.top = "0px";
    s.width = "24px";
    s.height = "24px";
    s.margin = "0";
    s.padding = "0";
    s.zIndex = "2147483647";
    s.pointerEvents = "none";
    s.opacity = "0";
    s.willChange = "transform, opacity";
    s.transform = "translate(-100px, -100px)";
    s.transition = "opacity 160ms ease";
    // Halo ring + pointer arrow.
    el.innerHTML =
      '<div style="position:absolute;left:-6px;top:-6px;width:34px;height:34px;border-radius:50%;' +
      'background:radial-gradient(circle, rgba(99,102,241,.35) 0%, rgba(99,102,241,0) 70%);"></div>' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
      'style="position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));">' +
      '<path d="M5 3l14 7-6 2-3 6-5-15z" fill="#ffffff" stroke="#4f46e5" stroke-width="1.5" stroke-linejoin="round"/>' +
      "</svg>";
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function moveTo(x: number, y: number, opts?: { animate?: boolean; durationMs?: number }): Promise<AgentCursorMoveResult> {
    var o = opts || {};
    var el = ensureEl();
    el.style.opacity = "1";
    var visible = typeof document.visibilityState === "undefined" || document.visibilityState === "visible";
    var animate = o.animate !== false && visible;
    var dur = typeof o.durationMs === "number" ? o.durationMs : 360;
    var tx = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)";
    return new Promise(function (resolve) {
      if (!animate) {
        el.style.transition = "opacity 160ms ease";
        el.style.transform = tx;
        resolve({ x: x, y: y, animated: false });
        return;
      }
      el.style.transition = "transform " + dur + "ms cubic-bezier(.22,.61,.36,1), opacity 160ms ease";
      void el.offsetWidth; // force reflow so the new transition applies to the move below
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", onEnd);
        resolve({ x: x, y: y, animated: true });
      }
      function onEnd(e: Event) {
        if ((e as TransitionEvent).propertyName === "transform") finish();
      }
      el.addEventListener("transitionend", onEnd);
      setTimeout(finish, dur + 150); // fallback if transitionend never fires (e.g. offscreen)
      el.style.transform = tx;
    });
  }

  function moveToElement(target: any, opts?: { animate?: boolean; durationMs?: number }): Promise<AgentCursorMoveResult | null> {
    try {
      if (target && typeof target.getBoundingClientRect === "function") {
        var r = target.getBoundingClientRect();
        return moveTo(r.left + r.width / 2, r.top + r.height / 2, opts);
      }
    } catch {
      /* element detached mid-action */
    }
    return Promise.resolve(null);
  }

  function hide(): void {
    var el = document.getElementById(ID);
    if (el) el.style.opacity = "0";
  }

  w.__crawlioAgentCursor = { moveTo: moveTo, moveToElement: moveToElement, hide: hide, _id: ID };
}
