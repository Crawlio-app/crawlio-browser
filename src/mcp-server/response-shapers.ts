// Response shaping layer — compress raw extension data for AI context efficiency
// Imported by tools.ts, applied per-tool. Extension stays untouched.

import type { NetworkEntry, ConsoleEntry, CookieEntry, DOMNode, PageCapture } from "../shared/types.js";

// --- Helpers ---

export function truncateUrl(url: string, max = 120): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 3) + "...";
}

// --- list_tabs ---

interface TabEntry {
  tabId: number;
  url: string;
  title: string;
  windowId?: number;
  active?: boolean;
  connected?: boolean;
  [key: string]: unknown;
}

export function shapeListTabs(data: { tabs: TabEntry[]; connectedTabId?: number | null } | TabEntry[]): unknown {
  const raw = Array.isArray(data) ? { tabs: data, connectedTabId: null } : data;
  return {
    connectedTabId: raw.connectedTabId ?? null,
    tabs: raw.tabs.map(t => ({
      id: t.tabId,
      title: t.title,
      url: truncateUrl(t.url),
      ...(t.active ? { active: true } : {}),
    })),
  };
}

// --- connect_tab ---

interface DomainResult {
  domain: string;
  success: boolean;
  error?: string;
}

export function shapeConnectTab(data: Record<string, unknown>): unknown {
  const shaped: Record<string, unknown> = {
    tabId: data.tabId,
    url: typeof data.url === "string" ? truncateUrl(data.url) : data.url,
    title: data.title,
  };

  // Check domainState for required domain failures
  const ds = data.domainState as { required?: DomainResult[]; optional?: DomainResult[] } | undefined;
  if (ds?.required) {
    const failed = ds.required.filter(d => !d.success);
    if (failed.length > 0) {
      shaped.ok = false;
      shaped.failedDomains = failed.map(d => d.domain);
    } else {
      shaped.ok = true;
    }
  } else {
    shaped.ok = true;
  }

  return shaped;
}

// --- capture_page ---

function summarizeDom(node: DOMNode): { nodeCount: number; forms: number; links: number; images: number; inputs: number } {
  const stats = { nodeCount: 0, forms: 0, links: 0, images: 0, inputs: 0 };
  const walk = (n: DOMNode) => {
    stats.nodeCount++;
    const tag = n.tag?.toLowerCase();
    if (tag === "form") stats.forms++;
    else if (tag === "a") stats.links++;
    else if (tag === "img") stats.images++;
    else if (tag === "input" || tag === "textarea" || tag === "select") stats.inputs++;
    if (n.children) n.children.forEach(walk);
  };
  walk(node);
  return stats;
}

export function shapeCapturePage(data: PageCapture): unknown {
  const shaped: Record<string, unknown> = {
    url: truncateUrl(data.url),
    title: data.title,
    capturedAt: data.capturedAt,
  };

  if (data.framework) {
    shaped.framework = data.framework;
  }

  // Network summary
  if (data.networkRequests) {
    const entries = data.networkRequests;
    const failed = entries.filter(e => e.status >= 400 || e.status === 0);
    const byType: Record<string, number> = {};
    for (const e of entries) {
      const t = e.resourceType || "other";
      byType[t] = (byType[t] || 0) + 1;
    }
    shaped.network = {
      total: entries.length,
      failed: failed.length,
      byType,
      errors: failed.slice(0, 10).map(e => ({
        url: truncateUrl(e.url, 80),
        status: e.status,
        method: e.method,
      })),
    };
  }

  // Console summary
  if (data.consoleLogs) {
    const entries = data.consoleLogs;
    const errors = entries.filter(e => e.level === "error");
    const warnings = entries.filter(e => e.level === "warning");
    shaped.console = {
      total: entries.length,
      errors: errors.slice(0, 10).map(e => ({ level: e.level, text: e.text.slice(0, 200) })),
      warnings: warnings.length,
      info: entries.filter(e => e.level === "info").length,
      debug: entries.filter(e => e.level === "debug").length,
    };
  }

  // Cookie summary
  if (data.cookies) {
    shaped.cookies = {
      total: data.cookies.length,
      names: data.cookies.map(c => c.name),
    };
  }

  // DOM summary
  if (data.domSnapshot) {
    shaped.dom = summarizeDom(data.domSnapshot);
  }

  return shaped;
}

// --- console logs ---

export function shapeConsoleLogs(entries: ConsoleEntry[]): unknown {
  const errors = entries.filter(e => e.level === "error");
  const warnings = entries.filter(e => e.level === "warning");
  const cappedErrors = errors.slice(0, 50).map(e => ({
    text: e.text.slice(0, 300),
    url: e.url ? truncateUrl(e.url, 80) : null,
    lineNumber: e.lineNumber,
  }));
  return {
    total: entries.length,
    errors: cappedErrors,
    ...(errors.length > 50 ? { totalErrors: errors.length, errorsTruncated: true } : {}),
    warnings: warnings.slice(0, 10).map(e => ({
      text: e.text.slice(0, 200),
    })),
    info: entries.filter(e => e.level === "info").length,
    debug: entries.filter(e => e.level === "debug").length,
  };
}

// --- network log ---

export function shapeNetworkLog(entries: NetworkEntry[]): unknown {
  const failed = entries.filter(e => e.status >= 400 || e.status === 0);
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const e of entries) {
    const bucket = e.status === 0 ? "0xx" : `${Math.floor(e.status / 100)}xx`;
    byStatus[bucket] = (byStatus[bucket] || 0) + 1;
    const t = e.resourceType || "other";
    byType[t] = (byType[t] || 0) + 1;
  }

  // Top 5 slowest requests
  const slowest = [...entries]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(e => ({
      url: truncateUrl(e.url, 80),
      durationMs: e.durationMs,
      status: e.status,
    }));

  const cappedFailed = failed.slice(0, 20).map(e => ({
    url: truncateUrl(e.url, 80),
    status: e.status,
    method: e.method,
  }));
  return {
    total: entries.length,
    failed: cappedFailed,
    ...(failed.length > 20 ? { totalFailed: failed.length, failedTruncated: true } : {}),
    byStatus,
    byType,
    slowest,
  };
}

// --- cookies ---

export function shapeCookies(data: { cookies: CookieEntry[]; fallbackUsed?: boolean }): unknown {
  return {
    total: data.cookies.length,
    fallbackUsed: data.fallbackUsed ?? false,
    cookies: data.cookies.map(c => ({
      name: c.name,
      domain: c.domain,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
  };
}

// --- interaction tools ---

export function shapeInteraction(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;

  const shaped: Record<string, unknown> = {};

  // Keep: action, selector, url, title, text, key, message, snapshot,
  //        previousValue, newValue, filesCount, success
  const keep = [
    "action", "selector", "ref", "url", "title", "text", "key",
    "message", "snapshot", "previousValue", "newValue", "filesCount",
    "success", "filled", "submitted",
  ];
  for (const k of keep) {
    if (d[k] !== undefined) shaped[k] = d[k];
  }

  // Truncate URL if present
  if (typeof shaped.url === "string") {
    shaped.url = truncateUrl(shaped.url as string);
  }

  return shaped;
}
