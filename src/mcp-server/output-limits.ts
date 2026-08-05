import { envFlagEnabled, isExplicitRawLane } from "./safety-mode.js";

/**
 * Configurable output size limits for context flooding prevention.
 *
 * Prevents a single large page from consuming the entire LLM context window.
 *
 * Enabled by default for agent contexts — character-level truncation.
 * Explicit RE/traffic-analysis lanes can disable it to preserve raw captures.
 *
 * Applied BEFORE content boundaries in the tool response pipeline.
 */

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalSize: number;
  estimatedTokens: number;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 51200;

/**
 * Truncate content to a maximum character count.
 * If truncated, appends a marker showing original vs shown size.
 */
export function truncateOutput(content: string, maxChars: number): TruncationResult {
  const originalSize = content.length;
  const estimatedTokens = Math.ceil(originalSize / 4);

  if (originalSize <= maxChars) {
    return { content, truncated: false, originalSize, estimatedTokens };
  }

  const truncated = content.slice(0, maxChars);
  const shownChars = truncated.length;
  const result = `${truncated}\n[truncated: showing ${shownChars} of ${originalSize} chars]`;

  return {
    content: result,
    truncated: true,
    originalSize,
    estimatedTokens: Math.ceil(result.length / 4),
  };
}

/**
 * Read CRAWLIO_MAX_OUTPUT env var. Returns null only when explicitly disabled
 * or when running in an explicit RE/traffic-analysis lane.
 */
export function getMaxOutput(): number | null {
  const raw = process.env.CRAWLIO_MAX_OUTPUT;
  const flag = envFlagEnabled(process.env, "CRAWLIO_MAX_OUTPUT");
  if (flag === false) return null;
  if (!raw) return isExplicitRawLane() ? null : DEFAULT_MAX_OUTPUT_CHARS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return isExplicitRawLane() ? null : DEFAULT_MAX_OUTPUT_CHARS;
  if (parsed <= 0) return null;
  return parsed;
}
