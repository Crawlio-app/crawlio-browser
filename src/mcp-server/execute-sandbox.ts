import { Worker } from "node:worker_threads";
import type { WebSocketBridge } from "./websocket-bridge.js";
import type { PolicyEnforcedSender } from "./policy-sender.js";
import { normalizePhaseReport, type PhaseReport } from "../shared/job-progress.js";
import type { CrawlioClient } from "./crawlio-client.js";
import { checkActionPolicy, type ActionPolicy } from "./action-policy.js";

const MAX_CODE_SIZE = 50 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_SLEEP_MS = 30_000;
const SYNC_EXECUTION_TIMEOUT_MS = readPositiveInt("CRAWLIO_EXECUTE_SANDBOX_SYNC_TIMEOUT_MS", 1000);
const ASYNC_EXECUTION_TIMEOUT_MS = readPositiveInt("CRAWLIO_EXECUTE_SANDBOX_ASYNC_TIMEOUT_MS", 120000);
const SYNC_RESPONSE_BYTES = MAX_OUTPUT_BYTES + 4096;
// Reused for every sync host-call response written into the SharedArrayBuffer — a fresh
// TextEncoder per write is pure allocation churn on a hot path.
const SHARED_SYNC_ENCODER = new TextEncoder();

const SANDBOX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { TextDecoder, TextEncoder } = require("node:util");

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let nextHostCallID = 0;
const pendingHostCalls = new Map();

function hardenHostCallable(fn) {
  Object.setPrototypeOf(fn, null);
  Object.defineProperty(fn, "constructor", { value: undefined, configurable: false });
  return Object.freeze(fn);
}

function normalizeForResult(value, seen = new WeakSet()) {
  if (value === undefined) return {};
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => normalizeForResult(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeForResult(item, seen);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

function postError(error) {
  const payload = {
    type: "error",
    name: error && typeof error.name === "string" ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
  if (error && typeof error === "object") {
    for (const key of ["problem", "permission_required", "missing", "suggestion"]) {
      if (error[key] !== undefined) payload[key] = error[key];
    }
  }
  parentPort.postMessage(payload);
}

parentPort.on("message", message => {
  if (!message || message.type !== "hostCallResponse") return;
  const resolve = pendingHostCalls.get(message.id);
  if (!resolve) return;
  pendingHostCalls.delete(message.id);
  resolve(String(message.envelope));
});

const hostCall = hardenHostCallable((channel, pathJson, argsJson) => {
  const id = ++nextHostCallID;
  return new Promise(resolve => {
    pendingHostCalls.set(id, resolve);
    parentPort.postMessage({ type: "hostCall", id, channel, pathJson, argsJson });
  });
});

const hostCallSync = hardenHostCallable((channel, pathJson, argsJson) => {
  const sab = new SharedArrayBuffer(8 + workerData.syncResponseBytes);
  const header = new Int32Array(sab, 0, 2);
  parentPort.postMessage({ type: "hostCallSync", channel, pathJson, argsJson, sab });
  Atomics.wait(header, 0, 0);
  const byteLength = Atomics.load(header, 1);
  return decoder.decode(new Uint8Array(sab, 8, byteLength));
});

async function run() {
  const sandbox = Object.create(null);
  sandbox.__hostCall = hostCall;
  sandbox.__hostCallSync = hostCallSync;
  sandbox.__timeouts = workerData.timeouts;
  sandbox.__smartShape = workerData.smartShape;

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(workerData.bootstrap, context, { timeout: workerData.syncTimeoutMs });

  const script = new vm.Script('"use strict"; (async () => { ' + workerData.code + ' })()', {
    filename: "crawlio_execute_sandbox.js",
  });
  const value = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
  parentPort.postMessage({ type: "result", resultJson: JSON.stringify({ value: normalizeForResult(value) }) });
}

run().catch(postError);
`;

const ALLOWED_CRAWLIO_METHODS = new Set([
  "api",
  "getStatus",
  "startCrawl",
  "getEnrichment",
  "getCrawledURLs",
  "postEnrichment",
]);

const FORBIDDEN_CRAWLIO_PATH = /(?:^https?:|\/\/|api\.crawlio\.app|grounding|classification|classify|rerank|repair|perception|judgment|cortex|model|inference)/i;
const SYNC_SMART_PATHS = new Set(["finding", "findings", "clearFindings"]);

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function serializeEnvelope(value: unknown): string {
  const json = JSON.stringify({ ok: true, value: value ?? {} });
  if (Buffer.byteLength(json, "utf8") > MAX_OUTPUT_BYTES) {
    return JSON.stringify({ ok: true, value: `${json.slice(0, MAX_OUTPUT_BYTES)}... [result truncated]` });
  }
  return json;
}

// Errors crossing the sandbox boundary are flattened to a message, which used to drop the
// structured fields the bridge attaches — so a permission denial or a typed failure raised
// inside execute() code arrived indistinguishable from any other error. Carry an allowlist.
const ERROR_DETAIL_KEYS = ["problem", "permission_required", "missing", "suggestion"] as const;

function serializeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const payload: Record<string, unknown> = { ok: false, error: message };
  if (error && typeof error === "object") {
    const source = error as Record<string, unknown>;
    for (const key of ERROR_DETAIL_KEYS) {
      if (source[key] !== undefined) payload[key] = source[key];
    }
  }
  return JSON.stringify(payload);
}

function parseArgs(argsJson: string): unknown[] {
  const parsed = JSON.parse(argsJson) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Sandbox host call args must be an array");
  return parsed;
}

function parsePath(pathJson: string): string[] {
  const parsed = JSON.parse(pathJson) as unknown;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) {
    throw new Error("Sandbox host call path must be a string array");
  }
  return parsed;
}

function assertBridgeCommand(
  command: unknown,
  allowedBridgeTypes: Set<string>,
  actionPolicy: ActionPolicy | null,
): asserts command is Record<string, unknown> {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("bridge.send command must be an object");
  }
  const type = (command as Record<string, unknown>).type;
  if (typeof type !== "string") {
    throw new Error(`bridge.send command type denied in execute sandbox: ${String(type)}`);
  }
  if (actionPolicy && checkActionPolicy(type, actionPolicy) === "deny") {
    throw new Error(`bridge.send command type denied by action policy in execute sandbox: ${type}`);
  }
  if (!allowedBridgeTypes.has(type)) {
    throw new Error(`bridge.send command type denied in execute sandbox: ${type}`);
  }
}

function assertCrawlioPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path.startsWith("/") || FORBIDDEN_CRAWLIO_PATH.test(path)) {
    throw new Error(`crawlio.api destination denied in execute sandbox: ${String(path)}`);
  }
}

function getSmartTarget(smart: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = smart;
  for (const part of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function smartShape(value: unknown, path: string[] = []): unknown {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const shape: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const nextPath = [...path, key];
    if (typeof item === "function") {
      shape[key] = SYNC_SMART_PATHS.has(nextPath.join(".")) ? "sync-function" : "async-function";
    } else if (item && typeof item === "object") {
      shape[key] = smartShape(item, nextPath);
    }
  }
  return shape;
}

export interface ExecuteSandboxGlobals {
  bridge: PolicyEnforcedSender;
  crawlio: CrawlioClient;
  sleep: (ms: number) => Promise<void>;
  timeouts: Record<string, number>;
  smart: Record<string, unknown>;
  compileRecording: (...args: unknown[]) => unknown;
  ocrScreenshot: (...args: unknown[]) => Promise<unknown>;
  /**
   * Persist bulk data to a confined on-disk artifacts directory (sandbox -> host -> disk),
   * so large results never have to flow through the tool `return` value / assistant context.
   * The host implementation confines the path and caps the size. Returns { path, bytes }.
   */
  saveArtifact?: (name: string, contents: string, opts?: { append?: boolean }) => Promise<{ path: string; bytes: number }>;
  /**
   * Called when sandboxed code reports a phase. Absent for foreground runs, where the caller is
   * already blocked on the result and has nothing to poll.
   */
  onProgress?: (report: PhaseReport) => void;
  allowedBridgeTypes: Set<string>;
  actionPolicy?: ActionPolicy | null;
  /** Optional cancellation for background jobs — aborting terminates the worker + rejects the run. */
  signal?: AbortSignal;
}

export interface ExecuteSandboxResult {
  value: unknown;
  console: string[];
}

type SandboxWorkerMessage =
  | { type: "result"; resultJson: string }
  | { type: "error"; name?: string; message?: string }
  | { type: "hostCall"; id: number; channel: string; pathJson: string; argsJson: string }
  | { type: "hostCallSync"; channel: string; pathJson: string; argsJson: string; sab: SharedArrayBuffer };

function buildBootstrap(): string {
  return `
    (function(hostCall, hostCallSync, timeouts, smartShape) {
      const decode = (envelopeJson) => {
        const envelope = JSON.parse(envelopeJson);
        if (!envelope.ok) {
          // Reattach the structured fields serializeError put in the envelope. Without
          // this, code running inside execute() can never see why a call failed — a
          // permission denial arrives indistinguishable from any other error.
          const err = new Error(envelope.error || "Sandbox host call failed");
          for (const key of ["problem", "permission_required", "missing", "suggestion"]) {
            if (envelope[key] !== undefined) err[key] = envelope[key];
          }
          throw err;
        }
        return envelope.value;
      };
      const callHost = async (channel, path, args) =>
        decode(await hostCall(channel, JSON.stringify(path), JSON.stringify(args)));
      const deepFreeze = (value) => {
        if (!value || typeof value !== "object") return value;
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
        return value;
      };
      const buildSmart = (shape, path) => {
        const target = {};
        for (const [key, value] of Object.entries(shape || {})) {
          if (value === "sync-function") {
            Object.defineProperty(target, key, {
              enumerable: true,
              value: (...args) => decode(hostCallSync("smart", JSON.stringify(path.concat(key)), JSON.stringify(args))),
            });
          } else if (value === "async-function") {
            Object.defineProperty(target, key, {
              enumerable: true,
              value: async (...args) => callHost("smart", path.concat(key), args),
            });
          } else {
            Object.defineProperty(target, key, {
              enumerable: true,
              value: buildSmart(value, path.concat(key)),
            });
          }
        }
        return deepFreeze(target);
      };
      globalThis.bridge = deepFreeze({
        send: async (command, timeout) => callHost("bridge", ["send"], [command, timeout]),
      });
      globalThis.crawlio = deepFreeze({
        api: async (...args) => callHost("crawlio", ["api"], args),
        getStatus: async (...args) => callHost("crawlio", ["getStatus"], args),
        startCrawl: async (...args) => callHost("crawlio", ["startCrawl"], args),
        getEnrichment: async (...args) => callHost("crawlio", ["getEnrichment"], args),
        getCrawledURLs: async (...args) => callHost("crawlio", ["getCrawledURLs"], args),
        postEnrichment: async (...args) => callHost("crawlio", ["postEnrichment"], args),
      });
      globalThis.sleep = async (ms) => callHost("sleep", [], [ms]);
      // Report which phase a long job is in. Fire-and-forget from the caller's point of view:
      // a progress line that fails to land must never take the run down with it.
      globalThis.reportPhase = async (phase, percent) => {
        try { await callHost("progress", [], [phase, percent]); } catch { /* progress is advisory */ }
      };
      // SECURITY: rebuild TIMEOUTS as a CONTEXT-realm, null-prototype
      // object. The incoming timeouts is a WORKER-realm object; exposing it let
      // sandbox code reach TIMEOUTS.constructor.constructor = the worker realm's
      // Function (NOT bound by this context's codeGeneration:{strings:false}) -> host RCE.
      const __timeoutsSafe = Object.create(null);
      for (const __k of Object.keys(timeouts || {})) __timeoutsSafe[__k] = Number(timeouts[__k]);
      globalThis.TIMEOUTS = Object.freeze(__timeoutsSafe);
      globalThis.smart = buildSmart(smartShape, []);
      globalThis.compileRecording = (...args) => decode(hostCallSync("compileRecording", "[]", JSON.stringify(args)));
      globalThis.ocrScreenshot = (...args) => callHost("ocrScreenshot", [], args);
      // Persist bulk data to disk without routing it through the tool return value.
      globalThis.saveArtifact = (name, contents, opts) => callHost("saveArtifact", [], [name, contents, opts]);
      globalThis.console = deepFreeze({
        log: (...args) => callHost("console", ["log"], args),
        info: (...args) => callHost("console", ["info"], args),
        warn: (...args) => callHost("console", ["warn"], args),
        error: (...args) => callHost("console", ["error"], args),
        debug: (...args) => callHost("console", ["debug"], args),
      });
      delete globalThis.__hostCall;
      delete globalThis.__hostCallSync;
      delete globalThis.__timeouts;
      delete globalThis.__smartShape;
      delete globalThis.process;
      delete globalThis.require;
      delete globalThis.module;
      delete globalThis.exports;
      delete globalThis.Buffer;
      delete globalThis.fetch;
      delete globalThis.Function;
      delete globalThis.eval;
      delete globalThis.SharedArrayBuffer;
      delete globalThis.WebAssembly;
      Error.prepareStackTrace = undefined;
    })(__hostCall, __hostCallSync, __timeouts, __smartShape);
  `;
}

async function runHostCall(
  globals: ExecuteSandboxGlobals,
  consoleLines: string[],
  channel: string,
  pathJson: string,
  argsJson: string,
): Promise<string> {
  try {
    const path = parsePath(pathJson);
    const args = parseArgs(argsJson);
    switch (channel) {
      case "bridge": {
        if (path[0] !== "send") throw new Error(`bridge path denied: ${path.join(".")}`);
        const [command, timeout] = args;
        assertBridgeCommand(command, globals.allowedBridgeTypes, globals.actionPolicy ?? null);
        const result = await globals.bridge.send(command as Parameters<WebSocketBridge["send"]>[0], typeof timeout === "number" ? timeout : undefined);
        return serializeEnvelope(result);
      }
      case "crawlio": {
        const method = path[0];
        if (!method || !ALLOWED_CRAWLIO_METHODS.has(method)) throw new Error(`crawlio method denied: ${String(method)}`);
        if (method === "api") assertCrawlioPath(args[1]);
        const fn = globals.crawlio[method as keyof CrawlioClient];
        if (typeof fn !== "function") throw new Error(`crawlio method unavailable: ${method}`);
        const result = await (fn as (...items: unknown[]) => Promise<unknown>).apply(globals.crawlio, args);
        return serializeEnvelope(result);
      }
      case "sleep": {
        const ms = typeof args[0] === "number" ? args[0] : 0;
        await globals.sleep(Math.min(Math.max(0, ms), MAX_SLEEP_MS));
        return serializeEnvelope(undefined);
      }
      case "progress": {
        // Advisory only — normalize, hand to the host, and never fail the call. A job whose
        // progress reporting throws would be a job killed by its own telemetry.
        const report = normalizePhaseReport(args[0], args[1], Date.now());
        if (report) globals.onProgress?.(report);
        return serializeEnvelope(undefined);
      }
      case "smart": {
        const target = getSmartTarget(globals.smart, path);
        if (typeof target !== "function") throw new Error(`smart path unavailable: ${path.join(".")}`);
        const owner = path.length > 1 ? getSmartTarget(globals.smart, path.slice(0, -1)) : globals.smart;
        const result = await (target as (...items: unknown[]) => Promise<unknown>).apply(owner, args);
        return serializeEnvelope(result);
      }
      case "compileRecording":
        return serializeEnvelope(await globals.compileRecording(...args));
      case "ocrScreenshot":
        return serializeEnvelope(await globals.ocrScreenshot(...args));
      case "saveArtifact": {
        if (!globals.saveArtifact) throw new Error("saveArtifact is unavailable in this sandbox");
        const [name, contents, opts] = args;
        if (typeof name !== "string") throw new Error("saveArtifact(name, contents, opts?): name must be a string");
        const body = typeof contents === "string" ? contents : JSON.stringify(contents ?? "");
        const append = !!(opts && typeof opts === "object" && (opts as Record<string, unknown>).append === true);
        return serializeEnvelope(await globals.saveArtifact(name, body, { append }));
      }
      case "console":
        consoleLines.push(args.map(String).join(" "));
        return serializeEnvelope(undefined);
      default:
        throw new Error(`Sandbox host channel denied: ${channel}`);
    }
  } catch (error) {
    return serializeError(error);
  }
}

function runHostCallSync(
  globals: ExecuteSandboxGlobals,
  channel: string,
  pathJson: string,
  argsJson: string,
): string {
  try {
    const path = parsePath(pathJson);
    const args = parseArgs(argsJson);
    if (channel === "compileRecording") return serializeEnvelope(globals.compileRecording(...args));
    if (channel === "smart") {
      if (!SYNC_SMART_PATHS.has(path.join("."))) throw new Error(`Sandbox sync smart path denied: ${path.join(".")}`);
      const target = getSmartTarget(globals.smart, path);
      if (typeof target !== "function") throw new Error(`smart path unavailable: ${path.join(".")}`);
      const owner = path.length > 1 ? getSmartTarget(globals.smart, path.slice(0, -1)) : globals.smart;
      return serializeEnvelope((target as (...items: unknown[]) => unknown).apply(owner, args));
    }
    throw new Error(`Sandbox sync channel denied: ${channel}`);
  } catch (error) {
    return serializeError(error);
  }
}

function writeSharedResponse(sab: SharedArrayBuffer, envelope: string): void {
  const header = new Int32Array(sab, 0, 2);
  const output = new Uint8Array(sab, 8);
  let encoded = SHARED_SYNC_ENCODER.encode(envelope);
  if (encoded.byteLength > output.byteLength) {
    encoded = SHARED_SYNC_ENCODER.encode(serializeError(new Error("Sandbox sync host response exceeded output limit")));
  }
  output.set(encoded);
  Atomics.store(header, 1, encoded.byteLength);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

export async function executeSandboxedCode(code: string, globals: ExecuteSandboxGlobals): Promise<ExecuteSandboxResult> {
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_SIZE) {
    throw new Error(`Code size exceeds limit (${MAX_CODE_SIZE} bytes)`);
  }

  const consoleLines: string[] = [];
  const worker = new Worker(SANDBOX_WORKER_SOURCE, {
    eval: true,
    workerData: {
      bootstrap: buildBootstrap(),
      code,
      smartShape: smartShape(globals.smart),
      syncResponseBytes: SYNC_RESPONSE_BYTES,
      syncTimeoutMs: SYNC_EXECUTION_TIMEOUT_MS,
      timeouts: JSON.parse(JSON.stringify(globals.timeouts)),
    },
  });

  return await new Promise<ExecuteSandboxResult>((resolve, reject) => {
    let settled = false;
    let pendingHostCalls = 0;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (progressTimer) clearTimeout(progressTimer);
      worker.removeAllListeners();
    };

    const fail = (error: Error) => {
      if (settled) return;
      cleanup();
      void worker.terminate();
      reject(error);
    };

    const complete = (value: unknown) => {
      if (settled) return;
      cleanup();
      void worker.terminate();
      resolve({ value: value ?? {}, console: consoleLines });
    };

    const armProgressTimer = () => {
      if (progressTimer) clearTimeout(progressTimer);
      if (pendingHostCalls > 0 || settled) return;
      progressTimer = setTimeout(() => {
        fail(new Error(`Code execution timeout (${SYNC_EXECUTION_TIMEOUT_MS}ms without sandbox progress)`));
      }, SYNC_EXECUTION_TIMEOUT_MS);
    };

    const hardTimer = setTimeout(() => {
      fail(new Error(`Code execution timeout (${ASYNC_EXECUTION_TIMEOUT_MS}ms)`));
    }, ASYNC_EXECUTION_TIMEOUT_MS);

    // cancel_job → controller.abort() terminates the worker and rejects this run.
    if (globals.signal) {
      if (globals.signal.aborted) { fail(new Error("cancelled")); return; }
      globals.signal.addEventListener("abort", () => fail(new Error("cancelled")), { once: true });
    }

    worker.on("message", (message: SandboxWorkerMessage) => {
      if (settled) return;
      if (message.type === "result") {
        try {
          const parsed = JSON.parse(message.resultJson) as { value?: unknown };
          complete(parsed.value ?? {});
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (message.type === "error") {
        const text = message.message ?? "Sandbox worker failed";
        const err = message.name === "SyntaxError" ? new SyntaxError(text) : new Error(text);
        const wire = message as unknown as Record<string, unknown>;
        for (const key of ["problem", "permission_required", "missing", "suggestion"]) {
          if (wire[key] !== undefined) (err as unknown as Record<string, unknown>)[key] = wire[key];
        }
        fail(err);
        return;
      }
      if (message.type === "hostCallSync") {
        const envelope = runHostCallSync(globals, message.channel, message.pathJson, message.argsJson);
        writeSharedResponse(message.sab, envelope);
        armProgressTimer();
        return;
      }
      if (message.type === "hostCall") {
        pendingHostCalls += 1;
        if (progressTimer) clearTimeout(progressTimer);
        void runHostCall(globals, consoleLines, message.channel, message.pathJson, message.argsJson)
          .then(envelope => {
            pendingHostCalls -= 1;
            if (!settled) worker.postMessage({ type: "hostCallResponse", id: message.id, envelope });
            armProgressTimer();
          })
          .catch(error => {
            pendingHostCalls -= 1;
            if (!settled) worker.postMessage({ type: "hostCallResponse", id: message.id, envelope: serializeError(error) });
            armProgressTimer();
          });
      }
    });
    worker.on("error", error => fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", code => {
      if (settled) return;
      // A worker that exits without ever posting a result — even cleanly (code 0) — would
      // otherwise leave this promise hanging until the 120s hard timer. Fail fast instead.
      fail(new Error(code === 0 ? "sandbox worker exited without result" : `Sandbox worker exited with code ${code}`));
    });

    armProgressTimer();
  });
}
