import { mkdir, readdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import type { SelectorRecord } from "@crawlio/selectors";
import type { WebSocketBridge } from "./websocket-bridge.js";
import type { NetworkEntry, RecordingBundleManifest, RecordingSession } from "../shared/types.js";
import type { ForgedSelectorBundle } from "./selector-kernel.js";
import { buildResidentTrainingMonitorScript } from "../extension/injected/resident-training-monitor.js";

type BridgeCommand = Parameters<WebSocketBridge["send"]>[0];

/**
 * Compatibility export for callers that inspect the page-program expression budget. Installation
 * now happens inside the extension so collection survives an MCP restart; the returned program is
 * the same resident monitor that the extension injects, with storage values disabled by default.
 */
export function buildRobotTrainingMonitorJs(): string {
  return buildResidentTrainingMonitorScript(false);
}

export interface RobotTrainingRun {
  runId: string;
  targetUrl: string;
  outputDir: string;
  tabId: number;
  recordingId?: string;
  startedAt: string;
  status: "recording" | "stopped" | "interrupted" | "error";
  lastError?: string;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "robot-training";
}

function newRunId(): string {
  return `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultOutputDir(targetUrl: string, runId: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  // process.cwd() never returns an empty string — it throws if the working directory was
  // removed underneath the process. So a `||` fallback here could never run; only a catch can.
  let base: string;
  try {
    base = process.cwd();
  } catch {
    base = homedir();
  }
  return join(base, "runs", `${slugify(targetUrl)}-${timestamp}`, runId);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf-8");
}

function headerEntries(headers?: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers ?? {}).map(([k, v]) => [k, String(v)]);
}

function hostFor(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

function bodyForRequest(entry: NetworkEntry): string | null {
  return typeof entry.requestBody === "string" && entry.requestBody.length > 0 ? entry.requestBody : null;
}

function bodyForResponse(bodyRecord: unknown): string | null {
  if (!bodyRecord || typeof bodyRecord !== "object") return null;
  const body = (bodyRecord as { body?: unknown; base64Encoded?: unknown }).body;
  const base64Encoded = (bodyRecord as { base64Encoded?: unknown }).base64Encoded;
  return typeof body === "string" && base64Encoded !== true ? body : null;
}

function buildFlowsJsonl(network: NetworkEntry[], bodies: Record<string, unknown>): string {
  const lines = network
    .filter(entry => entry.url && entry.method && entry.status > 0)
    .map(entry => {
      const responseBody = entry.requestId ? bodyForResponse(bodies[entry.requestId]) : null;
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        request: {
          method: entry.method,
          url: entry.url,
          headers: headerEntries(entry.requestHeaders),
          body: bodyForRequest(entry),
        },
        response: {
          status: entry.status,
          headers: entry.mimeType ? [["content-type", entry.mimeType]] : [],
          body: responseBody,
        },
        latency_ms: Math.max(0, Math.round(entry.durationMs || 0)),
        tls_sni: hostFor(entry.url),
      });
    });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function interactionCount(session: RecordingSession): number {
  return session.pages?.reduce((sum, page) => sum + (page.interactions?.length ?? 0), 0) ?? 0;
}

function stateChangingCount(network: NetworkEntry[]): number {
  return network.filter(entry => !["GET", "HEAD", "OPTIONS"].includes(entry.method.toUpperCase())).length;
}

function bodyPolicyFromBodies(bodies: Record<string, unknown>, captureBody: boolean): RecordingBundleManifest["bodyPolicy"] {
  const truncated = Object.values(bodies).some(record => {
    if (!record || typeof record !== "object") return false;
    const body = (record as { body?: unknown }).body;
    return typeof body === "string" && body.includes("[truncated]");
  });
  return { captureBody, truncated };
}

function buildManifest(
  run: RobotTrainingRun,
  overrides: {
    stoppedAt?: string;
    recording?: RecordingSession;
    network?: NetworkEntry[];
    bodies?: Record<string, unknown>;
    stateLog?: unknown[];
    flows?: number;
    warnings?: string[];
  } = {},
): RecordingBundleManifest {
  const recording = overrides.recording;
  const network = overrides.network ?? [];
  const bodies = overrides.bodies ?? {};
  const stateLog = overrides.stateLog ?? [];
  return {
    id: run.runId,
    schemaVersion: "crawlio.recordingBundle.v1",
    targetURL: run.targetUrl,
    producer: "chrome",
    fidelity: "cdpFull",
    startedAt: run.startedAt,
    stoppedAt: overrides.stoppedAt,
    createdAt: run.startedAt,
    privacy: "local-sensitive",
    bodyPolicy: bodyPolicyFromBodies(bodies, Object.keys(bodies).length > 0),
    counts: {
      pages: recording?.pages?.length ?? 0,
      interactions: recording ? interactionCount(recording) : 0,
      networkEntries: network.length,
      bodyRecords: Object.keys(bodies).length,
      stateEvents: stateLog.length,
      flows: overrides.flows ?? 0,
    },
    artifacts: {
      manifest: "manifest.json",
      rawDump: "raw-dump.json",
      recording: "recording.json",
      network: "network.json",
      bodies: "bodies.json",
      stateLog: "state-log.json",
      state: "state.json",
      causalGraph: "causal-graph.json",
      causalMarkdown: "CAUSAL.md",
      recipe: "recipe.json",
      registry: "REGISTRY.md",
      flows: "flows.jsonl",
      openapi: "api.openapi.yaml",
    },
    warnings: overrides.warnings ?? [],
  };
}

function buildCausalGraph(run: RobotTrainingRun, recording: RecordingSession, network: NetworkEntry[], stateLog: unknown[]): Record<string, unknown> {
  const interactions = Math.max(1, interactionCount(recording));
  return {
    schemaVersion: "crawlio.causalGraph.v1",
    bundleId: run.runId,
    summary: {
      interactions: interactionCount(recording),
      networkEntries: network.length,
      stateEvents: stateLog.length,
      stateChangingCalls: stateChangingCount(network),
    },
    edges: network.map((entry, index) => ({
      from: `interaction:${Math.min(index + 1, interactions)}`,
      to: `network:${index + 1}`,
      method: entry.method,
      url: entry.url,
      requestId: entry.requestId,
    })),
  };
}

function buildCausalMarkdown(run: RobotTrainingRun, recording: RecordingSession, network: NetworkEntry[], stateLog: unknown[]): string {
  return [
    "# Recording Causal Graph",
    "",
    `Bundle: ${run.runId}`,
    "Producer: chrome",
    "Fidelity: cdpFull",
    "",
    `- Interactions: ${interactionCount(recording)}`,
    `- Network entries: ${network.length}`,
    `- State events: ${stateLog.length}`,
    `- State-changing calls: ${stateChangingCount(network)}`,
    "",
    "Response bodies were fetched before `stop_network_capture` for canonical replay and synthesis.",
  ].join("\n");
}

/** Narrow a forged primary selector to the kernel's `SelectorRecord` shape. */
function toSelectorRecord(sel: ForgedSelectorBundle["selector"]): SelectorRecord | null {
  return sel ? { type: sel.type, value: sel.value } : null;
}

/** Pull the forged 5-rail bundles the monitor captured at interaction time, in
 *  chronological order, so they line up with the recorded interaction steps. */
function bundlesFromStateLog(stateLog: unknown[]): Array<ForgedSelectorBundle | null> {
  const INTERACTION_REASONS = new Set(["before-click", "input-change", "before-submit"]);
  const out: Array<ForgedSelectorBundle | null> = [];
  for (const entry of stateLog) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { reason?: unknown; extra?: unknown };
    if (typeof e.reason !== "string" || !INTERACTION_REASONS.has(e.reason)) continue;
    const bundle = e.extra && typeof e.extra === "object" ? (e.extra as { bundle?: unknown }).bundle : null;
    out.push(bundle && typeof bundle === "object" ? (bundle as ForgedSelectorBundle) : null);
  }
  return out;
}

function buildRecipe(
  run: RobotTrainingRun,
  recording: RecordingSession,
  bundles: Array<ForgedSelectorBundle | null> = [],
): Record<string, unknown> {
  const steps: Array<Record<string, unknown>> = [];
  let interactionIndex = 0;
  for (const page of recording.pages ?? []) {
    steps.push({ kind: "navigate", url: page.url });
    for (const interaction of page.interactions ?? []) {
      const bundle = bundles[interactionIndex++] ?? null;
      steps.push({
        kind: interaction.tool,
        source: interaction.source ?? "unknown",
        pageUrl: interaction.pageUrl,
        args: interaction.args,
        // M3: every recorded step carries a verified selector + the 5-rail bundle.
        selector: toSelectorRecord(bundle?.selector ?? null),
        verified: bundle?.verified ?? false,
        rails: bundle?.rails ?? null,
      });
    }
  }
  return {
    schemaVersion: "crawlio.recipe.v1",
    bundleId: run.runId,
    targetURL: run.targetUrl,
    fidelity: "cdpFull",
    steps,
  };
}

function buildRegistryMarkdown(run: RobotTrainingRun, recording: RecordingSession): string {
  const lines = ["# Button Registry", "", `Bundle: ${run.runId}`, ""];
  let index = 1;
  for (const page of recording.pages ?? []) {
    for (const interaction of page.interactions ?? []) {
      lines.push(`- ${index}. ${interaction.tool} ${interaction.pageUrl}`);
      index++;
    }
  }
  if (index === 1) lines.push("- No interactions were captured.");
  return lines.join("\n");
}

const OPENAPI_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * Build a conservative OpenAPI draft from captured same-origin HTTP exchanges.
 *
 * JSON is valid YAML 1.2, so serializing this object into `api.openapi.yaml` avoids a YAML
 * dependency while keeping the artifact directly consumable. Values and body examples are
 * intentionally omitted: the extension has already redacted capture data, and a contract draft
 * needs shapes/endpoints rather than another copy of potentially sensitive payloads.
 */
function buildOpenApiDraft(run: RobotTrainingRun, network: NetworkEntry[]): Record<string, unknown> {
  const target = new URL(run.targetUrl);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const entry of network) {
    let url: URL;
    try { url = new URL(entry.url); } catch { continue; }
    const method = entry.method.toLowerCase();
    if (url.origin !== target.origin || !OPENAPI_METHODS.has(method) || entry.status <= 0) continue;

    const path = url.pathname || "/";
    const pathItem = paths[path] ?? (paths[path] = {});
    let operation = pathItem[method] as Record<string, unknown> | undefined;
    if (!operation) {
      const queryNames = [...new Set([...url.searchParams.keys()])];
      const operationIdSuffix = path
        .replace(/[^a-zA-Z0-9]+(.)/g, (_whole, next: string) => next.toUpperCase())
        .replace(/[^a-zA-Z0-9]/g, "") || "root";
      operation = {
        operationId: `${method}${operationIdSuffix[0].toUpperCase()}${operationIdSuffix.slice(1)}`,
        summary: `Captured ${entry.method.toUpperCase()} ${path}`,
        ...(queryNames.length ? {
          parameters: queryNames.map((name) => ({
            name,
            in: "query",
            required: false,
            schema: { type: "string" },
          })),
        } : {}),
        responses: {},
      };
      pathItem[method] = operation;
    }

    const responses = operation.responses as Record<string, unknown>;
    const status = String(Math.round(entry.status));
    const responseMime = entry.mimeType || "application/octet-stream";
    responses[status] = {
      description: `Captured HTTP ${status}`,
      content: {
        [responseMime]: {
          schema: { type: /json/i.test(responseMime) ? "object" : "string" },
        },
      },
    };

    if (entry.requestBody && !["get", "head"].includes(method) && !operation.requestBody) {
      const firstBodyCharacter = entry.requestBody.trimStart()[0];
      const requestMime = Object.entries(entry.requestHeaders ?? {})
        .find(([key]) => key.toLowerCase() === "content-type")?.[1]
        ?? (["{", "["].includes(firstBodyCharacter) ? "application/json" : "application/octet-stream");
      operation.requestBody = {
        required: true,
        content: {
          [requestMime]: {
            schema: { type: /json/i.test(requestMime) ? "object" : "string" },
          },
        },
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: { title: `Crawlio Recording ${run.runId}`, version: "1.0.0" },
    servers: [{ url: target.origin }],
    paths,
    "x-crawlio-draft": true,
    "x-crawlio-source-bundle": run.runId,
  };
}

export async function robotTrainingStart(
  bridge: WebSocketBridge,
  options: {
    url: string;
    runId?: string;
    outputDir?: string;
    maxDurationSec?: number;
    maxInteractions?: number;
    active?: boolean;
    injectMonitor?: boolean;
    captureStorageValues?: boolean;
  },
): Promise<Record<string, unknown>> {
  const runId = options.runId || newRunId();
  const outputDir = resolve(options.outputDir || defaultOutputDir(options.url, runId));
  await mkdir(outputDir, { recursive: true });

  const resident = await bridge.send({
    type: "robot_training_start",
    url: options.url,
    runId,
    outputDir,
    maxDurationSec: options.maxDurationSec,
    maxInteractions: options.maxInteractions,
    active: options.active !== false,
    injectMonitor: options.injectMonitor !== false,
    captureStorageValues: options.captureStorageValues === true,
  } as BridgeCommand, 30_000) as {
    tabId?: number;
    recordingId?: string;
    startedAt?: string;
    status?: RobotTrainingRun["status"];
    monitor?: unknown;
    [key: string]: unknown;
  };
  if (typeof resident.tabId !== "number") throw new Error("resident robot training did not return a tabId");

  const run: RobotTrainingRun = {
    runId,
    targetUrl: typeof resident.targetUrl === "string" ? resident.targetUrl : options.url,
    outputDir,
    tabId: resident.tabId,
    recordingId: resident.recordingId,
    startedAt: resident.startedAt ?? new Date().toISOString(),
    status: resident.status ?? "recording",
  };

  await writeJson(join(outputDir, "manifest.json"), {
    ...buildManifest(run),
    resident: true,
    bridgeRequiredForCollection: false,
    monitor: resident.monitor ?? null,
    status: run.status,
  });

  return {
    ...resident,
    ...run,
    artifacts: {
      manifest: join(outputDir, "manifest.json"),
    },
  };
}

export async function robotTrainingStatus(
  bridge: WebSocketBridge,
  runId?: string,
): Promise<Record<string, unknown>> {
  return bridge.send(
    { type: "robot_training_status", ...(runId ? { runId } : {}) } as BridgeCommand,
    10_000,
  ) as Promise<Record<string, unknown>>;
}

/** Delete one stopped resident record in Chrome. Canonical bundle files are deliberately preserved. */
export async function robotTrainingClear(
  bridge: WebSocketBridge,
  options: { runId: string; confirm: true },
): Promise<Record<string, unknown>> {
  return bridge.send({
    type: "robot_training_clear",
    runId: options.runId,
    confirm: options.confirm,
  } as BridgeCommand, 10_000) as Promise<Record<string, unknown>>;
}

export async function robotTrainingStop(
  bridge: WebSocketBridge,
  options: {
    runId: string;
    fetchBodies?: boolean;
    closeTab?: boolean;
  },
): Promise<Record<string, unknown>> {
  const exported = await bridge.send({
    type: "robot_training_stop",
    runId: options.runId,
    fetchBodies: options.fetchBodies !== false,
    closeTab: options.closeTab === true,
  } as BridgeCommand, 90_000) as {
    run?: {
      runId?: string;
      targetUrl?: string;
      outputDir?: string;
      tabId?: number;
      recordingId?: string;
      startedAt?: string;
      stoppedAt?: string;
      status?: RobotTrainingRun["status"];
      lastError?: string;
    };
    recording?: RecordingSession;
    network?: NetworkEntry[];
    bodies?: Record<string, unknown>;
    state?: Record<string, unknown>;
    stateLog?: unknown[];
  };
  const view = exported.run;
  if (!view || typeof view.tabId !== "number" || !view.startedAt || !exported.recording) {
    throw new Error(`resident robot training run '${options.runId}' returned an incomplete export`);
  }
  const targetUrl = view.targetUrl ?? exported.recording.metadata.initialUrl;
  const run: RobotTrainingRun = {
    runId: view.runId ?? options.runId,
    targetUrl,
    outputDir: resolve(view.outputDir ?? defaultOutputDir(targetUrl, options.runId)),
    tabId: view.tabId,
    recordingId: view.recordingId,
    startedAt: view.startedAt,
    status: view.status ?? "stopped",
    lastError: view.lastError,
  };
  await mkdir(run.outputDir, { recursive: true });

  try {
    const recording = exported.recording;
    const network = Array.isArray(exported.network) ? exported.network : [];
    const bodies = exported.bodies ?? {};
    const stateLog = Array.isArray(exported.stateLog) ? exported.stateLog : [];
    const state = exported.state ?? {};
    const rawDump = { recording, network, bodies, stateLog, ...state };
    const flowsJsonl = buildFlowsJsonl(network, bodies);
    const flowCount = flowsJsonl.trim() ? flowsJsonl.trim().split(/\n+/).length : 0;
    const causalGraph = buildCausalGraph(run, recording, network, stateLog);
    const recipe = buildRecipe(run, recording, bundlesFromStateLog(stateLog));
    const openapi = buildOpenApiDraft(run, network);

    await writeJson(join(run.outputDir, "raw-dump.json"), rawDump);
    await writeJson(join(run.outputDir, "recording.json"), recording);
    await writeJson(join(run.outputDir, "network.json"), network);
    await writeJson(join(run.outputDir, "bodies.json"), bodies);
    await writeJson(join(run.outputDir, "state-log.json"), stateLog);
    await writeJson(join(run.outputDir, "state.json"), state);
    await writeFile(join(run.outputDir, "flows.jsonl"), flowsJsonl, "utf-8");
    await writeJson(join(run.outputDir, "causal-graph.json"), causalGraph);
    await writeText(join(run.outputDir, "CAUSAL.md"), buildCausalMarkdown(run, recording, network, stateLog));
    await writeJson(join(run.outputDir, "recipe.json"), recipe);
    await writeText(join(run.outputDir, "REGISTRY.md"), buildRegistryMarkdown(run, recording));
    // JSON is valid YAML 1.2 and preserves exact escaping for captured paths/header media types.
    await writeText(join(run.outputDir, "api.openapi.yaml"), JSON.stringify(openapi, null, 2));

    const stoppedAt = view.stoppedAt ?? recording.stoppedAt ?? new Date().toISOString();
    await writeJson(join(run.outputDir, "manifest.json"), {
      ...buildManifest(run, { stoppedAt, recording, network, bodies, stateLog, flows: flowCount }),
      status: run.status,
      resident: true,
      bridgeRequiredForCollection: false,
    });

    return {
      runId: run.runId,
      outputDir: run.outputDir,
      status: run.status,
      resident: true,
      recording: {
        id: recording.id,
        pages: recording.pages?.length ?? 0,
        interactions: recording.pages?.reduce((sum, page) => sum + (page.interactions?.length ?? 0), 0) ?? 0,
      },
      network: {
        total: network.length,
        withBodies: Object.keys(bodies).length,
        flowsJsonl: flowsJsonl.trim() ? join(run.outputDir, "flows.jsonl") : null,
      },
      stateLog: { entries: stateLog.length },
      artifacts: await robotTrainingArtifacts({ outputDir: run.outputDir }),
    };
  } catch (err) {
    run.status = "error";
    run.lastError = err instanceof Error ? err.message : String(err);
    await writeJson(join(run.outputDir, "manifest.json"), {
      ...buildManifest(run, { warnings: [run.lastError] }),
      status: run.status,
      lastError: run.lastError,
      resident: true,
    }).catch(() => undefined);
    throw err;
  }
}

export async function robotTrainingArtifacts(options: { outputDir: string }): Promise<Record<string, unknown>> {
  const outputDir = resolve(options.outputDir);
  const entries = await readdir(outputDir);
  const artifacts = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(outputDir, entry);
    const info = await stat(fullPath);
    return {
      name: entry,
      path: fullPath,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      kind: basename(entry).replace(/\.[^.]+$/, ""),
    };
  }));
  return { outputDir, artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name)) };
}
