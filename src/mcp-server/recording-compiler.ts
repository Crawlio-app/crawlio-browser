import { createHash, randomUUID } from "node:crypto";
import type { RecordingSession, RecordingInteraction } from "../shared/types.js";
// --- Public API ---

interface CompileOptions {
  name: string;
  description?: string;
}

export interface CompileResult {
  skillMarkdown: string;
  name: string;
  pageCount: number;
  interactionCount: number;
}

export function compileRecording(session: RecordingSession, options: CompileOptions): CompileResult {
  const name = sanitizeSkillName(options.name);
  const totalInteractions = session.pages.reduce((sum, p) => sum + p.interactions.length, 0);
  const description = options.description ?? `Replay of a recorded browser session (${session.pages.length} pages, ${totalInteractions} interactions).`;

  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`name: ${name}`);
  lines.push(`description: ${description}`);
  lines.push("allowed-tools: mcp__crawlio-browser__search, mcp__crawlio-browser__execute, mcp__crawlio-browser__connect_tab");
  lines.push("---");
  lines.push("");

  // Title
  const title = options.name.trim() || "Unnamed Skill";
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Replay of a recorded browser session (${session.pages.length} pages, ${totalInteractions} interactions).`);
  lines.push("");

  // Prerequisites
  lines.push("## Prerequisites");
  lines.push("");
  lines.push("Connect to a browser tab before running:");
  lines.push("");
  lines.push("```");
  lines.push(`connect_tab({ url: ${JSON.stringify(session.metadata.initialUrl)} })`);
  lines.push("```");
  lines.push("");

  // Pages
  for (let i = 0; i < session.pages.length; i++) {
    const page = session.pages[i];
    const pageLabel = page.title || page.url;
    lines.push(`## Page ${i + 1}: ${pageLabel}`);
    lines.push("");
    lines.push("```js");
    for (const interaction of page.interactions) {
      lines.push(compileInteraction(interaction));
    }
    lines.push("```");
    lines.push("");

    // Checkpoint between pages (not after last)
    if (i < session.pages.length - 1) {
      lines.push("```js");
      lines.push("await sleep(1000)");
      lines.push("await smart.snapshot()");
      lines.push("```");
      lines.push("");
    }
  }

  // Session Info
  lines.push("## Session Info");
  lines.push("");
  lines.push(`- **Recorded**: ${session.startedAt}`);
  lines.push(`- **Duration**: ${session.duration}s`);
  lines.push(`- **Stop reason**: ${session.metadata.stopReason}`);
  lines.push("");

  return {
    skillMarkdown: lines.join("\n"),
    name,
    pageCount: session.pages.length,
    interactionCount: totalInteractions,
  };
}

// --- Interaction compiler ---

/** Protocol fields to strip from recorded args before emitting */
const STRIP_KEYS = new Set(["type", "id", "_internal"]);

function filterArgs(args: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!STRIP_KEYS.has(k)) filtered[k] = v;
  }
  return filtered;
}

function resolveSelector(args: Record<string, unknown>): string | undefined {
  const sel = args.selector ?? args.ref;
  return typeof sel === "string" ? sel : undefined;
}

function compileInteraction(interaction: RecordingInteraction): string {
  const args = filterArgs(interaction.args);
  const tool = interaction.tool;

  switch (tool) {
    case "browser_navigate": {
      const url = args.url as string ?? "";
      return `await smart.navigate(${JSON.stringify(url)})`;
    }

    case "browser_click": {
      const sel = resolveSelector(args) ?? "";
      return `await smart.click(${JSON.stringify(sel)})`;
    }

    case "browser_type": {
      const sel = resolveSelector(args) ?? "";
      const text = args.text as string ?? "";
      if (args.clearFirst) {
        return `await smart.type(${JSON.stringify(sel)}, ${JSON.stringify(text)}, { clearFirst: true })`;
      }
      return `await smart.type(${JSON.stringify(sel)}, ${JSON.stringify(text)})`;
    }

    case "browser_evaluate": {
      const expr = args.expression as string ?? "";
      return `await smart.evaluate(${JSON.stringify(expr)})`;
    }

    case "browser_press_key": {
      const bridgeArgs = { type: "browser_press_key", ...args };
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_hover": {
      const sel = resolveSelector(args);
      const bridgeArgs = { type: "browser_hover", ...args };
      if (sel) {
        return `await smart.waitFor(${JSON.stringify(sel)})\nawait bridge.send(${JSON.stringify(bridgeArgs)})`;
      }
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_select_option": {
      const sel = resolveSelector(args);
      const bridgeArgs = { type: "browser_select_option", ...args };
      if (sel) {
        return `await smart.waitFor(${JSON.stringify(sel)})\nawait bridge.send(${JSON.stringify(bridgeArgs)})`;
      }
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_scroll": {
      const bridgeArgs = { type: "browser_scroll", ...args };
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_double_click": {
      const sel = resolveSelector(args);
      const bridgeArgs = { type: "browser_double_click", ...args };
      if (sel) {
        return `await smart.waitFor(${JSON.stringify(sel)})\nawait bridge.send(${JSON.stringify(bridgeArgs)})`;
      }
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_drag": {
      const bridgeArgs = { type: "browser_drag", ...args };
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_fill_form": {
      const bridgeArgs = { type: "browser_fill_form", ...args };
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    case "browser_file_upload": {
      const sel = resolveSelector(args);
      const bridgeArgs = { type: "browser_file_upload", ...args };
      if (sel) {
        return `await smart.waitFor(${JSON.stringify(sel)})\nawait bridge.send(${JSON.stringify(bridgeArgs)})`;
      }
      return `await bridge.send(${JSON.stringify(bridgeArgs)})`;
    }

    // User interaction tools (captured from manual browser events)
    case "user_click": {
      const sel = args.selector as string ?? "";
      return `await smart.click(${JSON.stringify(sel)})`;
    }

    case "user_type": {
      const sel = args.selector as string ?? "";
      const text = args.text as string ?? "";
      return `await smart.type(${JSON.stringify(sel)}, ${JSON.stringify(text)})`;
    }

    case "user_keypress": {
      const key = args.key as string ?? "";
      return `await bridge.send(${JSON.stringify({ type: "browser_press_key", key })})`;
    }

    default:
      return `// Unknown tool: ${tool.replace(/[\r\n]/g, " ").slice(0, 100)}`;
  }
}

// --- Helpers ---

export function sanitizeSkillName(raw: string): string {
  let name = raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")       // spaces/underscores → hyphens
    .replace(/[^a-z0-9-]/g, "")    // strip non-alphanumeric (except hyphens)
    .replace(/-{2,}/g, "-")        // collapse consecutive hyphens
    .replace(/^-+|-+$/g, "");      // trim edge hyphens

  if (name.length > 50) name = name.slice(0, 50).replace(/-+$/, "");
  if (!name) name = "unnamed-skill";

  return name;
}

// --- Forged claim (LACS EpistemicHandle mirror) ----------------------------
//
// A completed recording is more than bundle JSON on disk: it is forged into a
// durable claim that flows into the same noun the Swift side uses — a
// `.record` / `.skill` EpistemicHandle. This mirrors CrawlioCore's
// ArtifactStore.capture→forge: a SHA-256 contentDigest over the body (Law 1,
// content idempotence), a semanticHash over (artifactType, parents, metadata),
// and a status that only moves up (ephemeral → forged → canonical, Law 2). The
// extension stays thin — it forges and emits; persisting/canonicalizing the
// claim is the LACS/MCP substrate's job (see setForgeSink).

/** Lifecycle status of a forged claim; monotonic under LACS Law 2. */
export type ForgedClaimStatus = "ephemeral" | "forged" | "canonical";

/** The LACS noun a compiled recording lands as. */
export type ForgedClaimArtifactType = "record" | "skill";

/** Soul side of the claim — deterministic identity + lineage (governs Law 2). */
export interface ForgedClaimSoul {
  handleId: string;
  createdAt: string;                       // ISO 8601
  semanticHash: string;                    // sha256 over (artifactType, parents, metadata)
  contentDigest: string;                   // sha256 over body bytes (Law 1)
  artifactType: ForgedClaimArtifactType;
  authorKey: string;
  status: ForgedClaimStatus;
  parents: string[];
  tags: string[];
  version: number;
  registrableDomain?: string;
}

/** Body side of the claim — payload + provenance (governs Law 1 via contentDigest). */
export interface ForgedClaimBody {
  mediaType: string;
  sizeBytes: number;
  summary?: string;
  metadata: Record<string, string>;        // provenance, string-valued like the Swift Body.metadata
}

/** A forged `.record`/`.skill` claim re-rooting a compiled recording. */
export interface ForgedRecordingClaim {
  soul: ForgedClaimSoul;
  body: ForgedClaimBody;
  /** Compiled skill markdown this claim forges — for the substrate to persist/render as a livePage. */
  content: string;
}

export interface ForgeOptions {
  /** Defaults to "skill" — the compiled body is a SKILL.md. Pass "record" for the raw bundle handle. */
  artifactType?: ForgedClaimArtifactType;
  parents?: string[];
  tags?: string[];
  sessionId?: string;
}

function contentDigest(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function semanticHash(
  artifactType: ForgedClaimArtifactType,
  parents: string[],
  metadata: Record<string, string>,
): string {
  // Canonical form mirrors CrawlioCore HandleHashing.semanticHash: metadata as a
  // sorted [key, value] array and the outer object's keys in lexicographic order,
  // so byte-equal inputs yield byte-equal digests regardless of insertion order.
  const sortedMetadata = Object.keys(metadata)
    .sort()
    .map((key) => [key, metadata[key] ?? ""]);
  const canonical = { artifactType, metadata: sortedMetadata, parents };
  return contentDigest(JSON.stringify(canonical));
}

function hostOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a forged `.record`/`.skill` claim from a compiled recording — the same
 * EpistemicHandle noun the Swift `RecordingCompiler`/`ArtifactStore` produce.
 * `contentDigest`/`semanticHash` are deterministic over the inputs (Law 1
 * idempotence); `handleId`/`createdAt` regenerate per forge, exactly as Swift's
 * capture does. `compileRecording`'s bundle output is untouched — this is the
 * forge path alongside it.
 */
export function buildForgedRecordingClaim(
  result: CompileResult,
  session: RecordingSession,
  options: ForgeOptions = {},
): ForgedRecordingClaim {
  const artifactType = options.artifactType ?? "skill";
  const parents = options.parents ?? [];
  const content = result.skillMarkdown;

  const metadata: Record<string, string> = {
    source: "browser",
    producer: "crawlio-agent",
    tool: "compileRecording",
    skillName: result.name,
    sessionId: options.sessionId ?? session.id,
    seedUrl: session.metadata.initialUrl,
    stopReason: session.metadata.stopReason,
    startedAt: session.startedAt,
    durationSec: String(session.duration),
    pageCount: String(result.pageCount),
    interactionCount: String(result.interactionCount),
    ...(session.stoppedAt ? { stoppedAt: session.stoppedAt } : {}),
  };

  const host = hostOf(session.metadata.initialUrl);
  const soul: ForgedClaimSoul = {
    handleId: `hdl_${Date.now().toString(36)}_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    semanticHash: semanticHash(artifactType, parents, metadata),
    contentDigest: contentDigest(content),
    artifactType,
    authorKey: process.env.CRAWLIO_AUTHOR_KEY ?? "crawlio-agent",
    status: "forged",
    parents,
    tags: options.tags ?? [],
    version: 1,
    ...(host ? { registrableDomain: host } : {}),
  };

  const body: ForgedClaimBody = {
    mediaType: "text/markdown",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    summary: `Forged ${artifactType} from a recorded browser session (${result.pageCount} pages, ${result.interactionCount} interactions).`,
    metadata,
  };

  return { soul, body, content };
}

/**
 * Sink the LACS/MCP substrate (the app) registers to receive forged recording
 * claims. The extension stays thin: it forges + emits; the substrate persists
 * and canonicalizes. Absent a sink the forge path degrades to a pure return
 * value (offline-first).
 */
export type ForgeSink = (claim: ForgedRecordingClaim) => void | Promise<void>;

let forgeSink: ForgeSink | null = null;

export function setForgeSink(sink: ForgeSink | null): void {
  forgeSink = sink;
}

/**
 * Forge a compiled recording into a `.record`/`.skill` claim and hand it to the
 * registered substrate with provenance. Returns the forged claim whether or not
 * a sink is wired, so callers keep a handle to the claim either way.
 */
export async function forgeRecordingClaim(
  result: CompileResult,
  session: RecordingSession,
  options: ForgeOptions = {},
): Promise<ForgedRecordingClaim> {
  const claim = buildForgedRecordingClaim(result, session, options);
  if (forgeSink) {
    await forgeSink(claim);
  }
  return claim;
}

