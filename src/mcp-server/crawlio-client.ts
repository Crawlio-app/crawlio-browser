import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { CRAWLIO_PORT_FILE } from "../shared/constants.js";

// Crawlio.app writes this local-user capability beside control.port with mode 0600. Keep the
// server-only path here so adding ControlServer auth does not perturb the Chrome extension build.
const CRAWLIO_MCP_TOKEN_FILE = join(dirname(CRAWLIO_PORT_FILE), "mcp.token");

// --- HTTP Resilience ---

interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  timeout: number;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 16000,
  timeout: 30000,
};

// Enrichment is a best-effort sidecar to a successful browser capture. If the optional Crawlio
// app is not running, fail fast instead of adding two full retry ladders to capture_page.
const OPTIONAL_ENRICHMENT_RETRY: RetryConfig = {
  maxRetries: 0,
  baseDelay: 0,
  maxDelay: 0,
  timeout: 1500,
};

enum HTTPError {
  NetworkError = "network_error",
  TimeoutError = "timeout_error",
  ServerError = "server_error",
  ClientError = "client_error",
  RateLimited = "rate_limited",
}

function classifyHTTPError(error: unknown, status?: number): HTTPError {
  if (error instanceof DOMException && error.name === "AbortError") return HTTPError.TimeoutError;
  if (error instanceof TypeError) return HTTPError.NetworkError;
  if (status === 429) return HTTPError.RateLimited;
  if (status === 501) return HTTPError.ClientError;
  if (status && status >= 500) return HTTPError.ServerError;
  if (status && status >= 400) return HTTPError.ClientError;
  return HTTPError.NetworkError;
}

function isRetryable(err: HTTPError): boolean {
  return err !== HTTPError.ClientError;
}

function attachedHTTPError(error: unknown): HTTPError | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { httpError?: unknown }).httpError;
  return Object.values(HTTPError).includes(value as HTTPError) ? value as HTTPError : null;
}

function attachedHTTPStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function shouldTryLegacyEnrichmentEndpoints(status: number | null): boolean {
  // 404/405/501 mean the running app may predate the bundle endpoint. A 5xx can likewise be
  // isolated to that route. Auth, validation, and rate-limit failures apply to the same local app
  // and must not be amplified into four misleading follow-up failures.
  return status === 404 || status === 405 || status === 501 || (status !== null && status >= 500);
}

async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: RetryConfig = DEFAULT_RETRY
): Promise<Response> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await globalThis.fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) return response;

      const classified = classifyHTTPError(null, response.status);
      if (!isRetryable(classified) || attempt === config.maxRetries) {
        throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), {
          httpError: classified,
          status: response.status,
        });
      }

      const retryAfter = response.headers.get("Retry-After");
      const backoff = config.baseDelay * Math.pow(2, attempt);
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const delay = !isNaN(parsed)
        ? Math.min(Math.max(parsed * 1000, backoff), config.maxDelay)
        : Math.min(backoff, config.maxDelay);

      await new Promise(r => setTimeout(r, delay));
    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt === config.maxRetries) throw error;

      // Preserve the classification attached to a non-ok response. Reclassifying that Error as a
      // generic network failure made even a definitive 404 run the whole retry ladder.
      const classified = attachedHTTPError(error) ?? classifyHTTPError(error);
      if (!isRetryable(classified)) throw error;

      const delay = Math.min(config.baseDelay * Math.pow(2, attempt), config.maxDelay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// --- Types ---

interface EnrichmentBundle {
  url: string;
  framework?: unknown;
  networkRequests?: unknown[];
  consoleLogs?: unknown[];
  domSnapshotJSON?: string;
}

export interface CrawlioMcpTokenResolution {
  value: string;
  source: "env:CRAWLIO_MCP_TOKEN" | "disk:mcp.token";
}

function normalizeMcpToken(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value || value.length > 4096 || /[\0-\x1f\x7f]/.test(value)) return null;
  return value;
}

/** Resolve the local ControlServer capability without ever logging or returning it to MCP. */
export async function resolveCrawlioMcpToken(
  env: NodeJS.ProcessEnv = process.env,
  tokenFile = CRAWLIO_MCP_TOKEN_FILE,
): Promise<CrawlioMcpTokenResolution | null> {
  const environment = normalizeMcpToken(env.CRAWLIO_MCP_TOKEN);
  if (environment) return { value: environment, source: "env:CRAWLIO_MCP_TOKEN" };
  try {
    const disk = normalizeMcpToken(await readFile(tokenFile, "utf-8"));
    return disk ? { value: disk, source: "disk:mcp.token" } : null;
  } catch {
    return null;
  }
}

// --- Client ---

export class CrawlioClient {
  private portCache: number | null = null;

  async getPort(): Promise<number> {
    try {
      const content = await readFile(CRAWLIO_PORT_FILE, "utf-8");
      const port = parseInt(content.trim(), 10);
      if (isNaN(port)) throw new Error("Invalid port");
      this.portCache = port;
      return port;
    } catch {
      if (this.portCache) return this.portCache;
      throw new CrawlioUnavailableError(
        `Crawlio not running — port file not found at ${CRAWLIO_PORT_FILE}`
      );
    }
  }

  private async fetch(path: string, options?: RequestInit, retry?: RetryConfig): Promise<Response> {
    const port = await this.getPort();
    const url = `http://127.0.0.1:${port}${path}`;
    const headers = new Headers(options?.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const auth = await resolveCrawlioMcpToken();
    if (auth) {
      if (!headers.has("X-Crawlio-MCP-Token")) headers.set("X-Crawlio-MCP-Token", auth.value);
      // Current ControlServer accepts its same local-user MCP capability as the master Bearer.
      // Supplying both headers satisfies its transport gate and its optional per-agent auth gate.
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.value}`);
    }
    return fetchWithRetry(url, {
      ...options,
      headers,
    }, retry);
  }

  /**
   * Engine state and progress counters.
   *
   * `since` returns only what changed after that sequence number, which is how a poller avoids
   * re-reading the whole status each tick. It was documented on the HTTP surface but unreachable
   * from the MCP tool, so the two were listed as separate catalog entries under one name.
   */
  async getStatus(since?: number): Promise<unknown> {
    const path = typeof since === "number" ? `/status?since=${encodeURIComponent(String(since))}` : "/status";
    const res = await this.fetch(path);
    return res.json();
  }

  async startCrawl(url: string): Promise<unknown> {
    const res = await this.fetch("/start", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    return res.json();
  }

  async postFramework(url: string, framework: unknown): Promise<void> {
    await this.fetch("/enrichment/framework", {
      method: "POST",
      body: JSON.stringify({ url, framework }),
    });
  }

  async postNetworkRequests(url: string, networkRequests: unknown[]): Promise<void> {
    await this.fetch("/enrichment/network", {
      method: "POST",
      body: JSON.stringify({ url, networkRequests }),
    });
  }

  async postConsoleLogs(url: string, consoleLogs: unknown[]): Promise<void> {
    await this.fetch("/enrichment/console", {
      method: "POST",
      body: JSON.stringify({ url, consoleLogs }),
    });
  }

  async postDomSnapshot(url: string, domSnapshotJSON: string): Promise<void> {
    await this.fetch("/enrichment/dom", {
      method: "POST",
      body: JSON.stringify({ url, domSnapshotJSON }),
    });
  }

  async postEnrichment(
    url: string,
    data: { framework?: unknown; networkRequests?: unknown[]; consoleLogs?: unknown[]; domSnapshotJSON?: string }
  ): Promise<boolean> {
    const bundle: EnrichmentBundle = { url, ...data };
    try {
      const res = await this.fetch("/enrichment/bundle", {
        method: "POST",
        body: JSON.stringify(bundle),
      }, OPTIONAL_ENRICHMENT_RETRY);
      if (res.ok) return true;
      if (!shouldTryLegacyEnrichmentEndpoints(res.status)) return false;
    } catch (error) {
      // No local app (ECONNREFUSED) or an unresponsive one cannot be repaired by POSTing the same
      // payload to four more paths. This is an optional integration, so degrade quietly and tell
      // callers nothing was sent. HTTP endpoint errors still use the legacy individual fallback.
      const classified = attachedHTTPError(error) ?? classifyHTTPError(error);
      if (classified === HTTPError.NetworkError || classified === HTTPError.TimeoutError) return false;
      if (!shouldTryLegacyEnrichmentEndpoints(attachedHTTPStatus(error))) return false;
    }
    // Fallback: individual POSTs (parallel, best-effort — allSettled so one failure doesn't kill the rest)
    const posts: Promise<Response>[] = [];
    if (data.framework) posts.push(this.fetch("/enrichment/framework", { method: "POST", body: JSON.stringify({ url, framework: data.framework }) }, OPTIONAL_ENRICHMENT_RETRY));
    if (data.networkRequests?.length) posts.push(this.fetch("/enrichment/network", { method: "POST", body: JSON.stringify({ url, networkRequests: data.networkRequests }) }, OPTIONAL_ENRICHMENT_RETRY));
    if (data.consoleLogs?.length) posts.push(this.fetch("/enrichment/console", { method: "POST", body: JSON.stringify({ url, consoleLogs: data.consoleLogs }) }, OPTIONAL_ENRICHMENT_RETRY));
    if (data.domSnapshotJSON) posts.push(this.fetch("/enrichment/dom", { method: "POST", body: JSON.stringify({ url, domSnapshotJSON: data.domSnapshotJSON }) }, OPTIONAL_ENRICHMENT_RETRY));
    const results = await Promise.allSettled(posts);
    // Legacy enrichment is optional and its success is returned explicitly. Rejections here must
    // not print stack traces that make an otherwise successful browser capture look like an MCP
    // failure; callers that care can inspect `enrichmentSent`.
    return results.some((result) => result.status === "fulfilled" && result.value.ok);
  }

  async getEnrichment(url?: string): Promise<unknown> {
    const query = url ? `?url=${encodeURIComponent(url)}` : "";
    const res = await this.fetch(`/enrichment${query}`);
    return res.json();
  }

  async getCrawledURLs(params?: { status?: string; type?: string; limit?: number; offset?: number }): Promise<unknown> {
    const q: string[] = [];
    if (params?.status) q.push(`status=${encodeURIComponent(params.status)}`);
    if (params?.type) q.push(`type=${encodeURIComponent(params.type)}`);
    if (params?.limit) q.push(`limit=${params.limit}`);
    if (params?.offset) q.push(`offset=${params.offset}`);
    const res = await this.fetch(`/crawled-urls${q.length ? "?" + q.join("&") : ""}`);
    return res.json();
  }

  /** Generic HTTP method — replaces execute_api for code-mode callers.
   *  e.g. crawlio.api("GET", "/status"), crawlio.api("POST", "/export", { format: "zip" }) */
  async api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const res = await this.fetch(path, {
      method: method.toUpperCase(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: text }; }
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
}

/** Expected local state when the optional Crawlio desktop app is not running. */
export class CrawlioUnavailableError extends Error {
  readonly code = "CRAWLIO_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "CrawlioUnavailableError";
  }
}

export function isCrawlioUnavailableError(error: unknown): error is CrawlioUnavailableError {
  return error instanceof CrawlioUnavailableError
    || (typeof error === "object" && error !== null
      && (error as { code?: unknown }).code === "CRAWLIO_UNAVAILABLE");
}
