// pickerOverlay.ts — interactive element picker (extension-only).
//
// M3 "only-here": the extension has a HUMAN at record time, so we can offer an
// interactive picker overlay the headless engine can't. `pick_element` injects
// a hover-highlight overlay into the live page, waits for the human to click an
// element (or a few, in list mode), and returns the verification-gated 5-rail
// SelectorBundle forged by the @crawlio/selectors kernel (see selector-kernel).
//
// Everything is driven through the generic `browser_evaluate` bridge command —
// no new extension message types — so it works against any connected tab.

import type { WebSocketBridge } from "./websocket-bridge.js";
import type { Tool } from "./tools.js";
import {
  getForgePreludeJs,
  generalizeVerifiedArrayXpath,
  type ForgedSelector,
  type ForgedSelectorBundle,
} from "./selector-kernel.js";
import { z } from "zod";

type BridgeCommand = Parameters<WebSocketBridge["send"]>[0];

/**
 * Server-initiated re-verification of a forged selector. The picker kernel
 * runs in the page, so its `verified` flag is page-forgeable: a hostile crawled page
 * could return `verified: true` for an arbitrary selector. Before the server vouches
 * for a selector as verified, it independently re-resolves it via a fresh
 * browser_evaluate that uses the *prototype* DOM methods (harder to shadow than the
 * instance methods the page kernel used) and confirms it resolves to exactly one
 * element. A page that fully virtualizes `Document.prototype` can still defeat this —
 * fully tamper-proof verification needs CDP DOM-domain node identity captured at pick
 * time — but a naive `verified` forgery no longer survives.
 */
function buildPickerReverifyJs(selector: ForgedSelector): string {
  const sel = JSON.stringify(selector);
  return `(() => { try { const sel = ${sel};
    if (sel && sel.type === 'css') return { count: Document.prototype.querySelectorAll.call(document, sel.value).length };
    if (sel && sel.type === 'xpath') return { count: Document.prototype.evaluate.call(document, sel.value, document, null, 7, null).snapshotLength };
    return { count: 0 };
  } catch (e) { return { count: 0, error: String((e && e.message) || e) }; } })()`;
}

async function serverVerifySelector(bridge: Pick<WebSocketBridge, "send">, selector: ForgedSelector | null): Promise<boolean> {
  if (!selector || !selector.value) return false;
  try {
    const res = await bridge.send({ type: "browser_evaluate", expression: buildPickerReverifyJs(selector) } as BridgeCommand, 5000);
    return ((res as { result?: { count?: number } }).result?.count ?? 0) === 1;
  } catch {
    return false;
  }
}

/** MCP timeouts for the picker tools (registered into TOOL_TIMEOUTS by tools.ts). */
export const PICKER_TOOL_TIMEOUTS: Record<string, number> = {
  pick_element: 130000,
  cancel_picker: 5000,
};

function ok(content: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(content ?? {}) }], isError: false };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Overlay page script -----------------------------------------------------

/** Installed in the page (after the forge prelude). Reads options from
 *  `window.__CRAWLIO_PICK_OPTS`. Highlights the hovered element and, on click,
 *  records `window.__crawlioForge.bundle(target)` into `window.__crawlioPicker`.
 *  No interpolation/backticks so it concatenates cleanly after the prelude. */
const PICKER_INSTALL_BODY = String.raw`
;(function(){
  try {
    var opts = window.__CRAWLIO_PICK_OPTS || {};
    if (window.__crawlioPicker && window.__crawlioPicker.active) { return { ok:true, already:true }; }

    var box = document.createElement('div');
    box.setAttribute('data-crawlio-picker','1');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #6FA8DC;background:rgba(111,168,220,0.20);box-shadow:0 0 0 1px rgba(0,0,0,0.4);border-radius:2px;transition:all 40ms ease;display:none;';
    var tip = document.createElement('div');
    tip.setAttribute('data-crawlio-picker','1');
    tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:12px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:#1f2937;padding:3px 6px;border-radius:3px;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none;';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);

    var state = { active:true, multiple:!!opts.multiple, label:opts.label||null, picks:[], result:null, done:false, cancelled:false };
    window.__crawlioPicker = state;

    function isOurs(el){ return !el || (el.getAttribute && el.getAttribute('data-crawlio-picker')==='1'); }

    function place(el){
      try {
        var r = el.getBoundingClientRect();
        box.style.display='block';
        box.style.left=r.left+'px'; box.style.top=r.top+'px';
        box.style.width=Math.max(0,r.width)+'px'; box.style.height=Math.max(0,r.height)+'px';
        var t=(el.tagName||'').toLowerCase();
        var txt=((el.innerText||el.textContent||'')+'').trim().slice(0,48);
        tip.textContent = t + (el.id?('#'+el.id):'') + (txt?(' — '+txt):'');
        tip.style.display='block';
        var ty = r.top>22 ? (r.top-22) : (r.top+2);
        tip.style.left=r.left+'px'; tip.style.top=ty+'px';
      } catch(e){}
    }

    function onMove(e){ var el=e.target; if (isOurs(el)) return; place(el); }
    function onClick(e){
      var el=e.target; if (isOurs(el)) return;
      e.preventDefault(); e.stopPropagation();
      var b=null; try { b = window.__crawlioForge ? window.__crawlioForge.bundle(el) : null; } catch(_){ b=null; }
      state.picks.push(b);
      if (!state.multiple) { state.result=b; finish('picked'); }
      return false;
    }
    function onKey(e){
      if (e.key==='Escape'){ e.preventDefault(); state.cancelled=true; finish('cancelled'); }
      else if (e.key==='Enter' && state.multiple){ e.preventDefault(); finish('done'); }
    }
    function finish(reason){
      state.active=false; state.done=true; state.reason=reason;
      try { document.removeEventListener('mousemove', onMove, true); } catch(_){}
      try { document.removeEventListener('click', onClick, true); } catch(_){}
      try { document.removeEventListener('keydown', onKey, true); } catch(_){}
      try { box.remove(); tip.remove(); } catch(_){}
    }
    state.__uninstall = function(reason){ if (reason==='cancelled') state.cancelled=true; finish(reason||'cancelled'); };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    return { ok:true, installed:true, multiple:state.multiple };
  } catch(e){ return { ok:false, error:String(e&&e.message||e) }; }
})()
`;

const PICKER_POLL_JS =
  ";(function(){var p=window.__crawlioPicker;if(!p)return {missing:true};return {active:!!p.active,done:!!p.done,cancelled:!!p.cancelled,reason:p.reason||null,count:(p.picks||[]).length,picks:p.picks||[]};})()";

const PICKER_CANCEL_JS =
  ";(function(){try{if(window.__crawlioPicker&&window.__crawlioPicker.__uninstall){window.__crawlioPicker.__uninstall('cancelled');return {ok:true};}return {ok:true,idle:true};}catch(e){return {ok:false,error:String(e&&e.message||e)};}})()";

interface PollResult {
  missing?: boolean;
  active?: boolean;
  done?: boolean;
  cancelled?: boolean;
  reason?: string | null;
  count?: number;
  picks?: Array<ForgedSelectorBundle | null>;
}

/** Build the picker MCP tools. Registered into the main tool surface by
 *  `createTools` (tools.ts) via spread. */
export function createPickerTools(bridge: WebSocketBridge): Tool[] {
  return [
    {
      name: "pick_element",
      description:
        "Interactive element picker (extension-only — needs a human at the tab). Injects a hover-highlight " +
        "overlay into the connected page; the user clicks an element and the tool returns a VERIFIED selector " +
        "plus the 5-rail SelectorBundle (xpath/attribute/classChain/textContent/rolePlusText) forged by the " +
        "@crawlio/selectors kernel and gated by resolvesExactlyTo. Set multiple=true to pick a repeating set " +
        "(the user presses Enter to finish) and receive one generalized, verified array selector. Press Escape to cancel.",
      inputSchema: {
        type: "object",
        properties: {
          multiple: { type: "boolean", description: "List mode: collect several picks, generalize to one array selector (default false)." },
          label: { type: "string", description: "Optional prompt label shown context for the picking session." },
          timeoutMs: { type: "number", description: "Max wait for the human to pick, ms (default 120000, max 120000)." },
        },
      },
      handler: async (args: Record<string, unknown>) => {
        const schema = z.object({
          multiple: z.boolean().default(false),
          label: z.string().max(200).optional(),
          timeoutMs: z.number().int().min(1000).max(120000).default(120000),
        });
        const parsed = schema.parse(args);

        const optsPrefix = ";window.__CRAWLIO_PICK_OPTS=" + JSON.stringify({ multiple: parsed.multiple, label: parsed.label ?? null }) + ";";
        const install = await bridge.send({
          type: "browser_evaluate",
          expression: getForgePreludeJs() + optsPrefix + PICKER_INSTALL_BODY,
        } as BridgeCommand, 15000).catch((e) => ({ result: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
        const installResult = (install as { result?: { ok?: boolean; error?: string } }).result;
        if (installResult && installResult.ok === false) {
          return err(`pick_element: could not install picker overlay${installResult.error ? ` (${installResult.error})` : ""}`);
        }

        const deadline = Date.now() + parsed.timeoutMs;
        let last: PollResult = {};
        while (Date.now() < deadline) {
          await sleep(500);
          const poll = await bridge.send({ type: "browser_evaluate", expression: PICKER_POLL_JS } as BridgeCommand, 5000)
            .catch(() => ({ result: { missing: true } }));
          last = ((poll as { result?: PollResult }).result) ?? {};
          if (last.missing) break; // page navigated away — overlay gone
          if (last.cancelled) {
            return ok({ status: "cancelled", reason: last.reason ?? "cancelled" });
          }
          if (last.done) break;
        }

        // Clean up any lingering overlay (best-effort).
        await bridge.send({ type: "browser_evaluate", expression: PICKER_CANCEL_JS } as BridgeCommand, 5000).catch(() => null);

        const picks = (last.picks ?? []).filter((p): p is ForgedSelectorBundle => !!p && typeof p === "object");
        if (last.missing) return err("pick_element: the picker page navigated away before a selection was made");
        if (picks.length === 0) return ok({ status: "timeout", picked: 0 });

        if (!parsed.multiple) {
          const b = picks[0];
          // Don't trust the page-reported flag — re-verify server-side.
          const verified = b.verified && await serverVerifySelector(bridge, b.selector);
          return ok({ status: "picked", verified, selector: b.selector, rails: b.rails });
        }

        // List mode: generalize the per-element structural xpaths into one
        // index-stripped array xpath via the kernel (server-side, DOM-free).
        const arrayXpath = generalizeVerifiedArrayXpath(picks.map((p) => p.rails?.xpath ?? null));
        // Re-verify every bundle server-side rather than trusting page flags.
        const bundles = await Promise.all(picks.map(async (p) => ({
          verified: p.verified && await serverVerifySelector(bridge, p.selector),
          selector: p.selector,
          rails: p.rails,
        })));
        return ok({
          status: "picked",
          picked: picks.length,
          arraySelector: arrayXpath ? { type: "xpath", value: arrayXpath, rail: "xpath" } : null,
          generalized: arrayXpath !== null,
          bundles,
        });
      },
    },
    {
      name: "cancel_picker",
      description: "Cancel an in-progress pick_element overlay on the connected tab and remove its highlight. Safe to call when no picker is active.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const res = await bridge.send({ type: "browser_evaluate", expression: PICKER_CANCEL_JS } as BridgeCommand, PICKER_TOOL_TIMEOUTS.cancel_picker)
          .catch((e) => ({ result: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
        return ok((res as { result?: unknown }).result ?? { ok: true });
      },
    },
  ];
}
