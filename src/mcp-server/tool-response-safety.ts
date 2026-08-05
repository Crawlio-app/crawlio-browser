import { BINARY_CAPABLE_TOOLS, BINARY_PAGE_SOURCED_TOOLS, isContentBoundariesEnabled, PAGE_SOURCED_TOOLS, stripSystemReminders, wrapPageContent } from "./content-boundary.js";
import { getMaxOutput, truncateOutput } from "./output-limits.js";
import { isRedactionEnabled, REDACTED_PAGE_SOURCED_TOOLS, redactToolText } from "./redact.js";

export interface ToolContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResponseEnvelope {
  content: ToolContentItem[];
  isError?: boolean;
}

export interface ToolResponseSafetyOptions {
  toolName: string;
  response: ToolResponseEnvelope;
  resolveOrigin?: () => Promise<string>;
}

/**
 * A content item is a declared-binary payload when its text is a JSON object with
 * `base64Encoded: true` (e.g. get_response_body of an image) AND a base64-shaped
 * body. Such items must skip truncation and content-boundary wrapping, which would
 * corrupt the base64 stream. Redaction already preserves the binary
 * body field (see redact.ts).
 *
 * The caller must additionally confirm the tool is binary-capable before trusting
 * this — the `base64Encoded` flag is page-forgeable on every other tool, and
 * skipping reminder-stripping for a forged flag would let an injected
 * `<system-reminder>` survive.
 */
function isBinaryPayloadText(text: string): boolean {
  if (!text.trimStart().startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return false;
    const record = parsed as Record<string, unknown>;
    if (record.base64Encoded !== true) return false;
    const payload = [record.body, record.data, record.content].find(v => typeof v === "string");
    if (typeof payload !== "string") return false;
    const compact = payload.replace(/\s+/g, "");
    return compact.length === 0 || (compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact));
  } catch {
    return false;
  }
}

export async function applyToolResponseSafety(options: ToolResponseSafetyOptions): Promise<ToolResponseEnvelope> {
  const { toolName, response } = options;
  const isPageSourced = PAGE_SOURCED_TOOLS.has(toolName);
  const isBinaryPageSourced = BINARY_PAGE_SOURCED_TOOLS.has(toolName);
  // Only a binary-capable tool's `base64Encoded` flag is trustworthy. For every
  // other tool the flag is page-forgeable, so we never let it skip redaction,
  // truncation, or reminder-stripping.
  const binaryTrusted = BINARY_CAPABLE_TOOLS.has(toolName);

  // Redact secrets before any page-sourced output reaches downstream agent context.
  if (isRedactionEnabled() && REDACTED_PAGE_SOURCED_TOOLS.has(toolName)) {
    for (const item of response.content) {
      if (item.type === "text" && item.text) {
        item.text = redactToolText(item.text, binaryTrusted);
      }
    }
  }

  // Apply output limits to successful page-sourced tool output.
  const maxOutput = getMaxOutput();
  if (!response.isError && maxOutput !== null && isPageSourced && !isBinaryPageSourced) {
    for (const item of response.content) {
      if (item.type === "text" && item.text && !(binaryTrusted && isBinaryPayloadText(item.text))) {
        item.text = truncateOutput(item.text, maxOutput).content;
      }
    }
  }

  // Strip forged system reminders and apply content boundaries to page-sourced output.
  if (isPageSourced && !isBinaryPageSourced) {
    let origin = "unknown";
    const boundariesEnabled = isContentBoundariesEnabled();
    if (boundariesEnabled && options.resolveOrigin) {
      try {
        origin = await options.resolveOrigin();
      } catch {
        // Fall back to "unknown" origin.
      }
    }
    for (const item of response.content) {
      if (item.type === "text" && item.text && !(binaryTrusted && isBinaryPayloadText(item.text))) {
        item.text = boundariesEnabled ? wrapPageContent(item.text, origin) : stripSystemReminders(item.text);
      }
    }
  }

  return response;
}
