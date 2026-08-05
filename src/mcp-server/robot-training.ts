import { mkdir, readdir, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import type { SelectorRecord } from "@crawlio/selectors";
import type { WebSocketBridge } from "./websocket-bridge.js";
import type { NetworkEntry, RecordingBundleManifest, RecordingSession } from "../shared/types.js";
import { getForgePreludeJs, type ForgedSelectorBundle } from "./selector-kernel.js";

type BridgeCommand = Parameters<WebSocketBridge["send"]>[0];

const STATIC_RESOURCE_TYPES = new Set(["Stylesheet", "Image", "Font", "Media", "Script"]);
const TELEMETRY_URL = /cdn-cgi\/rum|cloudflareinsights|google-analytics|googletagmanager|doubleclick|facebook\.com\/tr/i;

export interface RobotTrainingRun {
  runId: string;
  targetUrl: string;
  outputDir: string;
  tabId: number;
  recordingId?: string;
  startedAt: string;
  status: "recording" | "stopped" | "error";
  lastError?: string;
}

const activeRobotTrainingRuns = new Map<string, RobotTrainingRun>();

export const ROBOT_TRAINING_MONITOR_JS = String.raw`
(() => {
  if (window.__sub_state_uninstall) {
    try { window.__sub_state_uninstall(); } catch (_) {}
  }

  window.__sub_state_log = window.__sub_state_log || [];
  window.__sub_state_id = 0;

  const cssPath = (el) => {
    // Prefer the verified @crawlio/selectors kernel selector (computeXPath +
    // resolvesExactlyTo, injected as window.__crawlioForge); the heuristic chain
    // below is only a fallback when the kernel is unavailable on this page.
    try {
      if (el && el.nodeType === 1 && window.__crawlioForge) {
        const b = window.__crawlioForge.bundle(el);
        if (b && b.selector && b.selector.value) return b.selector.value;
      }
    } catch (_) {}
    if (!el || !el.tagName) return null;
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length) {
        part += "." + Array.from(cur.classList).slice(0, 2).map(c => CSS.escape(c)).join(".");
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };

  const fields = () => {
    const out = {};
    for (const el of document.querySelectorAll("input, textarea, select")) {
      const key = el.id || el.name || cssPath(el);
      if (!key) continue;
      out[key] = {
        value: "value" in el ? el.value : "",
        type: el.type || el.tagName.toLowerCase(),
        checked: "checked" in el ? !!el.checked : undefined,
      };
    }
    return out;
  };

  const visibleButtons = () => Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"))
    .filter(el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    })
    .slice(0, 80)
    .map(el => ({
      selector: cssPath(el),
      tag: el.tagName,
      text: (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120),
      href: el.href || undefined,
    }));

  const storageObject = (storage) => {
    const out = {};
    try {
      for (const k of Object.keys(storage)) out[k] = storage.getItem(k);
    } catch (_) {}
    return out;
  };

  const snap = (reason, extra) => {
    const entry = {
      id: ++window.__sub_state_id,
      ts: Date.now(),
      reason,
      url: location.href,
      title: document.title,
      ss: storageObject(sessionStorage),
      ls: storageObject(localStorage),
      fields: fields(),
      visibleButtons: visibleButtons(),
      focusedSelector: cssPath(document.activeElement),
      scroll: { x: scrollX, y: scrollY },
      extra: extra || null,
    };
    window.__sub_state_log.push(entry);
    return entry;
  };

  const targetInfo = (target) => {
    const info = {
      selector: cssPath(target),
      tag: target?.tagName,
      text: (target?.innerText || target?.textContent || target?.value || target?.getAttribute?.("aria-label") || "").trim().slice(0, 160),
      bundle: null,
    };
    // Forge the verified 5-rail SelectorBundle for the interacted element so the
    // recorded step carries it (xpath/attribute/classChain/textContent/rolePlusText).
    try { if (target && target.nodeType === 1 && window.__crawlioForge) info.bundle = window.__crawlioForge.bundle(target); } catch (_) {}
    return info;
  };

  const onClick = (event) => {
    const info = targetInfo(event.target);
    snap("before-click", info);
    setTimeout(() => snap("after-click", info), 200);
  };
  const onChange = (event) => {
    const info = targetInfo(event.target);
    if ("value" in event.target) info.value = event.target.value;
    snap("input-change", info);
  };
  const onSubmit = (event) => {
    snap("before-submit", targetInfo(event.target));
    setTimeout(() => snap("after-submit", targetInfo(event.target)), 300);
  };
  const onPageShow = () => snap("pageshow", null);
  const onPopState = () => snap("popstate", null);

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("popstate", onPopState);
  snap("init", null);

  window.__sub_state_uninstall = () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("popstate", onPopState);
  };

  return { ok: true, monitor: "robot-training", entries: window.__sub_state_log.length };
})()
`;

/** The page program injected to drive a robot-training capture: the verified
 *  selector forge prelude (the @crawlio/selectors kernel + the 5-rail bundler)
 *  followed by the monitor, so the monitor's cssPath/targetInfo resolve through
 *  window.__crawlioForge (computeXPath, verified by resolvesExactlyTo). */
export function buildRobotTrainingMonitorJs(): string {
  return `${getForgePreludeJs()}\n${ROBOT_TRAINING_MONITOR_JS}`;
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
  return join(process.cwd() || join(homedir(), "Desktop", "crawlio-agent"), "runs", `${slugify(targetUrl)}-${timestamp}`, runId);
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

function networkEntriesFromRecording(session: RecordingSession): NetworkEntry[] {
  const entries: NetworkEntry[] = [];
  for (const page of session.pages ?? []) {
    for (const entry of page.network ?? []) entries.push(entry);
  }
  return entries;
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

function shouldFetchBody(entry: NetworkEntry): boolean {
  if (!entry.requestId) return false;
  if (STATIC_RESOURCE_TYPES.has(entry.resourceType)) return false;
  if (TELEMETRY_URL.test(entry.url)) return false;
  return true;
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
  },
): Promise<Record<string, unknown>> {
  const runId = options.runId || newRunId();
  const outputDir = resolve(options.outputDir || defaultOutputDir(options.url, runId));
  await mkdir(outputDir, { recursive: true });

  const tab = await bridge.send({
    type: "create_tab",
    url: options.url,
    active: options.active !== false,
    connect: true,
  } as BridgeCommand, 20_000) as { tabId?: number; url?: string; title?: string };
  if (typeof tab.tabId !== "number") throw new Error("create_tab did not return a tabId");

  await bridge.send({ type: "start_network_capture" } as BridgeCommand, 5_000);
  const recording = await bridge.send({
    type: "start_recording",
    maxDurationSec: options.maxDurationSec,
    maxInteractions: options.maxInteractions,
  } as BridgeCommand, 10_000) as { sessionId?: string };

  let monitor: unknown = null;
  if (options.injectMonitor !== false) {
    monitor = await bridge.send({
      type: "browser_evaluate",
      expression: buildRobotTrainingMonitorJs(),
    } as BridgeCommand, 10_000);
  }

  const run: RobotTrainingRun = {
    runId,
    targetUrl: options.url,
    outputDir,
    tabId: tab.tabId,
    recordingId: recording.sessionId,
    startedAt: new Date().toISOString(),
    status: "recording",
  };
  activeRobotTrainingRuns.set(runId, run);

  await writeJson(join(outputDir, "manifest.json"), {
    ...buildManifest(run),
    tab,
    monitor,
    status: run.status,
  });

  return {
    ...run,
    tab,
    monitor,
    artifacts: {
      manifest: join(outputDir, "manifest.json"),
    },
  };
}

export async function robotTrainingStatus(
  bridge: WebSocketBridge,
  runId?: string,
): Promise<Record<string, unknown>> {
  const recording = await bridge.send({ type: "get_recording_status" } as BridgeCommand, 5_000).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }));
  const runs = runId
    ? Array.from(activeRobotTrainingRuns.values()).filter(run => run.runId === runId)
    : Array.from(activeRobotTrainingRuns.values());
  return { runs, recording };
}

export async function robotTrainingStop(
  bridge: WebSocketBridge,
  options: {
    runId: string;
    fetchBodies?: boolean;
    closeTab?: boolean;
  },
): Promise<Record<string, unknown>> {
  const run = activeRobotTrainingRuns.get(options.runId);
  if (!run) throw new Error(`robot training run '${options.runId}' not found`);

  try {
    const stateEval = await bridge.send({
      type: "browser_evaluate",
      expression: "window.__sub_state_log || []",
    } as BridgeCommand, 10_000) as { result?: unknown };
    const stateLog = Array.isArray(stateEval.result) ? stateEval.result : [];

    const recording = await bridge.send({ type: "stop_recording" } as BridgeCommand, 10_000) as RecordingSession;
    const recordingNetwork = networkEntriesFromRecording(recording);
    const bodies: Record<string, unknown> = {};
    if (options.fetchBodies !== false) {
      for (const entry of recordingNetwork) {
        if (!shouldFetchBody(entry)) continue;
        try {
          bodies[entry.requestId as string] = await bridge.send({
            type: "get_response_body",
            requestId: entry.requestId,
          } as BridgeCommand, 10_000);
        } catch (err) {
          bodies[entry.requestId as string] = {
            url: entry.url,
            method: entry.method,
            status: entry.status,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    const network = await bridge.send({ type: "stop_network_capture" } as BridgeCommand, 60_000) as NetworkEntry[];
    const consoleLogs = await bridge.send({ type: "get_console_logs" } as BridgeCommand, 5_000).catch(() => []);
    const cookies = await bridge.send({ type: "get_cookies" } as BridgeCommand, 5_000).catch(() => ({ cookies: [] }));
    const finalMetaEval = await bridge.send({
      type: "browser_evaluate",
      expression: `(() => ({
        url: location.href,
        title: document.title,
        ts: new Date().toISOString(),
        cookies: document.cookie,
        localStorage: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
        sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)]))
      }))()`,
    } as BridgeCommand, 10_000).catch(() => ({ result: null })) as { result?: unknown };

    const state = { consoleLogs, cookies, finalMeta: finalMetaEval.result ?? null };
    const rawDump = { recording, network, bodies, stateLog, ...state };
    const flowsJsonl = buildFlowsJsonl(network, bodies);
    const flowCount = flowsJsonl.trim() ? flowsJsonl.trim().split(/\n+/).length : 0;
    const causalGraph = buildCausalGraph(run, recording, network, stateLog);
    const recipe = buildRecipe(run, recording, bundlesFromStateLog(stateLog));
    const openapi = [
      "openapi: 3.1.0",
      "info:",
      `  title: Crawlio Recording ${run.runId}`,
      "  version: 1.0.0",
      "paths: {}",
    ].join("\n");

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
    await writeText(join(run.outputDir, "api.openapi.yaml"), openapi);

    run.status = "stopped";
    activeRobotTrainingRuns.delete(run.runId);
    const stoppedAt = new Date().toISOString();
    await writeJson(join(run.outputDir, "manifest.json"), {
      ...buildManifest(run, {
        stoppedAt,
        recording,
        network,
        bodies,
        stateLog,
        flows: flowCount,
      }),
      status: run.status,
    });

    if (options.closeTab === true) {
      await bridge.send({ type: "close_tab", tabId: run.tabId } as BridgeCommand, 5_000).catch(() => null);
    }

    return {
      runId: run.runId,
      outputDir: run.outputDir,
      status: run.status,
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
