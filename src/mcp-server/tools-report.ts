// Read-only tool surface report — `crawlio-browser tools`.
//
// Answers "what can this thing actually touch?" without connecting anything. Dispatched in
// index.ts BEFORE the WebSocketBridge is constructed, so it can never start a server, bind a
// port, or attach a debugger — the same discipline doctor.ts follows.
//
// This matters more here than for a typical MCP server: installing this one grants an agent
// the debugger permission on a browser holding live logged-in sessions. Being able to read the
// exact surface before configuring a client is the difference between trusting a number in a
// README and checking it.
import { PKG_VERSION } from "../shared/constants.js";
import { describeSurface, type SurfaceDescription, type ToolSummary } from "./surface.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** First sentence, or a hard truncation — full text is a `--json` away. */
function synopsis(description: string, width: number): string {
  const firstSentence = /^(.*?[.!?])(\s|$)/.exec(description.trim());
  const text = (firstSentence ? firstSentence[1] : description).replace(/\s+/g, " ").trim();
  return text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`;
}

function renderList(tools: readonly ToolSummary[], synopsisWidth: number): string[] {
  const nameWidth = Math.max(...tools.map((t) => t.name.length));
  return tools
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `  ${t.name.padEnd(nameWidth)}  ${dim(synopsis(t.description, synopsisWidth))}`);
}

export function renderSurfaceReport(surface: SurfaceDescription, full: boolean): string {
  const out: string[] = [];
  const shown = full ? surface.full : surface.code;

  out.push("");
  out.push(`  ${bold("Crawlio Browser Tool Surface")} ${dim("v" + PKG_VERSION)}`);
  out.push("");
  out.push(
    full
      ? `  ${bold("full mode")} ${dim("(--full)")} — ${shown.length} tools`
      : `  ${bold("code mode")} ${dim("(default)")} — ${shown.length} tools`
  );
  out.push("");
  out.push(...renderList(shown, full ? 62 : 96));
  out.push("");

  if (!full) {
    // The point of code mode: the catalog is searchable without being resident in context.
    out.push(
      `  ${dim(`search covers ${surface.catalog.total} commands ` +
        `(${surface.catalog.browser} browser + ${surface.catalog.crawlioHttp} Crawlio HTTP), ` +
        `reachable from execute without entering the tool list`)}`
    );
    const { core, higherOrder, namespaces } = surface.smart;
    out.push(
      `  ${dim(`execute scope: smart with ${core.length} core and ${higherOrder.length} ` +
        `higher-order methods, plus up to ${namespaces.length} framework namespaces ` +
        `attached per page`)}`
    );
    out.push("");
    out.push(`  ${dim("all " + surface.full.length + " individual tools: crawlio-browser tools --full")}`);
  } else {
    out.push(`  ${dim("default (code mode) exposes " + surface.code.length + ": crawlio-browser tools")}`);
  }

  out.push(`  ${dim("machine-readable: crawlio-browser tools --json")}`);
  out.push("");
  return out.join("\n");
}

/**
 * Entry point for the `tools` subcommand. Read-only; returns the process exit code.
 * Always 0 — this reports a surface, it does not judge one.
 */
export async function runTools(argv: readonly string[] = []): Promise<number> {
  const surface = await describeSurface();
  const full = argv.includes("--full");

  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      schema: "ai.crawlio.browser-surface.v1",
      version: PKG_VERSION,
      ...surface,
    }, null, 2));
  } else {
    console.log(renderSurfaceReport(surface, full));
  }
  return 0;
}
