// The sizes this project advertises, derived rather than asserted.
//
// Every number here comes from invoking the real builders and measuring what they return.
// Nothing counts source text and nothing restates a constant, because hand-maintained counts
// are exactly what drifted: the README carried four different tool counts at once and the
// full-mode startup banner claimed 114 while exposing 145.
//
// This runs with no browser, no extension and no network. That is not a limitation to work
// around — it is the property that lets `crawlio-browser tools` report the surface before a
// user connects anything, which is the point of the command.

import {
  createTools,
  createCodeModeTools,
  buildCatalog,
  buildSmartObject,
  makePolicyEnforcingBridge,
  SMART_CORE_KEYS,
  SMART_NAMESPACE_TRIGGERS,
} from "./tools.js";
import type { WebSocketBridge } from "./websocket-bridge.js";
import type { CrawlioClient } from "./crawlio-client.js";

export interface ToolSummary {
  name: string;
  description: string;
}

export interface SurfaceDescription {
  /** Tools a client sees with `--full`. */
  full: ToolSummary[];
  /** Tools a client sees by default (code mode). */
  code: ToolSummary[];
  /**
   * What `search` indexes: every full-mode tool plus the Crawlio HTTP endpoints.
   *
   * `names` carries the whole set, not just the size, because prose has to be checked against it.
   * A skill that tells the model to call something is only correct if that something is in here,
   * and the Crawlio HTTP commands (reached through `crawlio.api()` rather than `bridge.send()`)
   * are just as callable as the browser tools — a checker that knew only the MCP tool list would
   * flag every one of them.
   */
  catalog: { total: number; browser: number; crawlioHttp: number; names: string[] };
  /**
   * The `smart` object at its maximum extent — every namespace present at once, which no
   * single real page produces. Reported as "up to N" for that reason.
   */
  smart: { core: string[]; higherOrder: string[]; namespaces: string[] };
}

/**
 * A bridge that answers framework detection and refuses everything else.
 *
 * `buildSmartObject` asks the page what it is before deciding which namespaces to attach, so
 * describing the maximal surface means answering that one question with every trigger at once.
 * Any other command is a bug — a surface description must never reach a browser — so this
 * rejects loudly instead of returning a plausible empty result that would silently undercount.
 */
function inertBridge(): Pick<WebSocketBridge, "send"> {
  const send = (command: unknown): Promise<unknown> => {
    const type = (command as { type?: unknown } | null | undefined)?.type;
    if (type === "detect_framework") {
      return Promise.resolve({
        detections: SMART_NAMESPACE_TRIGGERS.map((name) => ({ name, confidence: "high" })),
      });
    }
    return Promise.reject(
      new Error(`describeSurface must not reach the browser (attempted: ${String(type)})`)
    );
  };
  return { send } as unknown as Pick<WebSocketBridge, "send">;
}

function summarize(tools: Array<{ name: string; description: string }>): ToolSummary[] {
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

export async function describeSurface(): Promise<SurfaceDescription> {
  // Tool builders only need these to close over for their handlers, and describing the surface
  // reads name, description and schema without ever invoking one.
  const bridge = inertBridge() as unknown as WebSocketBridge;
  const crawlio = {} as unknown as CrawlioClient;

  const full = createTools(bridge, crawlio);
  const code = createCodeModeTools(bridge, crawlio);
  const catalog = buildCatalog(full);

  // Minted through the one sanctioned path, so the policy brand keeps its meaning.
  const smart = await buildSmartObject(makePolicyEnforcingBridge(inertBridge(), () => null));

  // Namespaces are objects grouping framework accessors; higher-order methods are callables.
  // Splitting on that rather than on a name list means a method added either way is counted
  // without anyone remembering to update a list.
  const attached = Object.keys(smart).filter((k) => !SMART_CORE_KEYS.has(k));

  return {
    full: summarize(full),
    code: summarize(code),
    catalog: {
      total: catalog.length,
      browser: full.length,
      crawlioHttp: catalog.length - full.length,
      names: catalog.map((c) => c.name).sort(),
    },
    smart: {
      core: Object.keys(smart).filter((k) => SMART_CORE_KEYS.has(k)).sort(),
      higherOrder: attached.filter((k) => typeof smart[k] === "function").sort(),
      namespaces: attached.filter((k) => typeof smart[k] === "object" && smart[k] !== null).sort(),
    },
  };
}
