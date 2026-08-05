import { readFile } from "fs/promises";
import { CRAWLIO_PORT_FILE } from "../shared/constants.js";

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
        throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), { httpError: classified });
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

      const classified = classifyHTTPError(error);
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
      throw new Error(
        `Crawlio not running — port file not found at ${CRAWLIO_PORT_FILE}`
      );
    }
  }

  private async fetch(path: string, options?: RequestInit): Promise<Response> {
    const port = await this.getPort();
    const url = `http://127.0.0.1:${port}${path}`;
    return fetchWithRetry(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  }

  async getStatus(): Promise<unknown> {
    const res = await this.fetch("/status");
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
  ): Promise<void> {
    const bundle: EnrichmentBundle = { url, ...data };
    try {
      const res = await this.fetch("/enrichment/bundle", {
        method: "POST",
        body: JSON.stringify(bundle),
      });
      if (res.ok) return;
      // Any non-ok status (404, 500, etc.) — fall through to individual POSTs
    } catch {
      // Network error — fall through to individual POSTs
    }
    // Fallback: individual POSTs (parallel, best-effort — allSettled so one failure doesn't kill the rest)
    const posts: Promise<Response>[] = [];
    if (data.framework) posts.push(this.fetch("/enrichment/framework", { method: "POST", body: JSON.stringify({ url, framework: data.framework }) }));
    if (data.networkRequests?.length) posts.push(this.fetch("/enrichment/network", { method: "POST", body: JSON.stringify({ url, networkRequests: data.networkRequests }) }));
    if (data.consoleLogs?.length) posts.push(this.fetch("/enrichment/console", { method: "POST", body: JSON.stringify({ url, consoleLogs: data.consoleLogs }) }));
    if (data.domSnapshotJSON) posts.push(this.fetch("/enrichment/dom", { method: "POST", body: JSON.stringify({ url, domSnapshotJSON: data.domSnapshotJSON }) }));
    const results = await Promise.allSettled(posts);
    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[CrawlioClient] Enrichment POST failed:", r.reason);
      }
    }
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
