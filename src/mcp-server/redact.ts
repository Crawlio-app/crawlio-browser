import { BINARY_PAGE_SOURCED_TOOLS, PAGE_SOURCED_TOOLS } from "./content-boundary.js";
import { envFlagEnabled, isExplicitRawLane, type SafetyEnv } from "./safety-mode.js";

const MAX_REDACTION_BYTES = 51200;
const MAX_DEPTH = 8;
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:password|passwd|pwd|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session|cookie|csrf)/i;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_KEY_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|oauth|session|csrf)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)["']?[^"'\s;,&}]{6,}/gi;
// Same as API_KEY_ASSIGNMENT but for percent-encoded `=` (`%3D`), so URL-encoded
// values like `?data=api_key%3Dsecret` are caught regardless of the outer key.
const URL_ENCODED_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|oauth|session|csrf)[A-Za-z0-9_.-]*)(%3[Dd])([^"'\s;,&}]{6,})/gi;
const COOKIE_PAIR = /\b([A-Za-z0-9_.-]*(?:sid|session|token|auth|csrf|xsrf|jwt|cookie)[A-Za-z0-9_.-]*)=([^;\s,]{6,})/gi;
// High-precision vendor secret token shapes. These are unambiguous credential
// markers, so they are redacted even when they appear as a bare value under a
// benign key (where the key-name and assignment heuristics never fire).
// NOTE: the OpenAI/Anthropic `sk-` family now ships hyphenated prefixes
// (`sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`, `sk-ant-…`). The legacy
// `sk-[A-Za-z0-9]{20,}` alternative stops at the first hyphen, so those keys
// leaked verbatim (verified live via get_storage/browser_evaluate). The
// prefixed alternative below is tried first; the legacy one still covers
// classic `sk-` + 48-char keys.
const PROVIDER_SECRET = /(?<![A-Za-z0-9])(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|sk-(?:proj|svcacct|admin|ant)[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[A-Za-z0-9._-]{20,})/g;
const BASE64_SECRET = /\b[A-Za-z0-9+/]{24,}={0,2}\b/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REDACTED_PAGE_SOURCED_TOOLS = new Set(
  [...PAGE_SOURCED_TOOLS].filter(tool => !BINARY_PAGE_SOURCED_TOOLS.has(tool))
);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isLikelyDataUriToken(source: string, offset: number): boolean {
  const prefix = source.slice(Math.max(0, offset - 32), offset).toLowerCase();
  return /data:[^,;]+;base64,$/.test(prefix);
}

function looksLikeBase64Secret(match: string, source: string, offset: number): boolean {
  if (isLikelyDataUriToken(source, offset)) return false;
  if (match.length < 32) return false;
  if (!/[A-Za-z]/.test(match)) return false;
  if (/^[a-f0-9]+$/i.test(match)) return false;
  if (/[0-9+/=]/.test(match)) return true;
  return shannonEntropy(match) >= 3.8;
}

// Whole-value heuristic for a standalone opaque high-entropy token (e.g. a secret
// stored under a benign key like { value: "xy_..." }). Applied ONLY to complete
// string VALUES in the structural pass — never to substrings of prose — and it
// deliberately preserves known non-secret shapes (pure-hex
// digests, UUIDs, version strings, data:/http(s) URIs).
function looksLikeOpaqueSecretValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 32 || v.length > 512) return false;
  if (/\s/.test(v)) return false;
  if (!/^[A-Za-z0-9_+/=.-]+$/.test(v)) return false;
  if (/^[a-f0-9]+$/i.test(v)) return false;           // pure hex digest / git SHA / content hash
  if (UUID.test(v)) return false;
  if (/^\d+(?:\.\d+)+$/.test(v)) return false;          // dotted version / number
  if (/^https?:\/\//i.test(v) || v.toLowerCase().startsWith("data:")) return false;
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false; // require letter AND digit
  return shannonEntropy(v) >= 3.6;
}

// Keys that carry a declared-binary body alongside a `base64Encoded` sibling.
const BINARY_PAYLOAD_KEYS: readonly string[] = ["body", "data", "content"];

// A genuine binary payload (image / PDF body from CDP) is strict base64. A forged
// secret like "ghp_…" or an injected JSON blob contains characters outside the
// base64 alphabet (or a non-multiple-of-4 length) and fails this check, so it is
// redacted normally even on a binary-capable tool. Whitespace is tolerated.
function isLikelyBase64Payload(value: string): boolean {
  const compact = value.replace(/\s+/g, "");
  if (compact.length === 0) return true;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

export function isRedactionEnabled(env: SafetyEnv = process.env): boolean {
  const explicit = envFlagEnabled(env, "CRAWLIO_REDACT_SECRETS");
  if (explicit !== null) return explicit;
  if (isExplicitRawLane(env)) return false;
  return true;
}

function redactString(value: string): string {
  if (byteLength(value) > MAX_REDACTION_BYTES) {
    value = value.slice(0, MAX_REDACTION_BYTES) + "[truncated-before-redaction]";
  }
  return value
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, REDACTED)
    .replace(PROVIDER_SECRET, REDACTED)
    .replace(API_KEY_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(URL_ENCODED_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(COOKIE_PAIR, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BASE64_SECRET, (match, offset: number, source: string) => {
      if (looksLikeBase64Secret(match, source, offset)) return REDACTED;
      return match;
    });
}

function redactRecursive(value: unknown, depth: number, seen: WeakSet<object>, allowBinary: boolean): unknown {
  if (depth > MAX_DEPTH) return "[REDACTION_DEPTH_LIMIT]";
  if (typeof value === "string") {
    // Re-parse string values that are themselves JSON (double-encoded payloads),
    // so secrets nested inside a stringified object are still redacted.
    const trimmed = value.trim();
    if (depth < MAX_DEPTH && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          // A nested JSON-encoded payload is never the trusted top-level binary
          // envelope, so binary-preservation never propagates into it.
          return JSON.stringify(redactRecursive(parsed, depth + 1, seen, false));
        }
      } catch {
        // Not JSON — fall through to string redaction.
      }
    }
    if (looksLikeOpaqueSecretValue(value)) return REDACTED;
    return redactString(value);
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => redactRecursive(item, depth + 1, seen, false));
  }
  // Preserve a declared-binary payload verbatim (e.g. get_response_body of an
  // image), which must not be mangled by value-level secret heuristics. Honored
  // ONLY when (a) the caller is a tool whose `base64Encoded` flag is
  // CDP-sourced and trustworthy (`allowBinary`), (b) this is the TOP-LEVEL
  // envelope (`depth === 0`) rather than a nested object, and (c) the payload is
  // actually base64-shaped. Otherwise the flag is page-forgeable and is ignored,
  // so `{ content, base64Encoded: true }` from browser_evaluate — or a nested
  // forged flag inside a genuine binary body — is still redacted.
  const record = value as Record<string, unknown>;
  const payloadKey = BINARY_PAYLOAD_KEYS.find(key => typeof record[key] === "string");
  const isBinaryPayload =
    allowBinary &&
    depth === 0 &&
    record.base64Encoded === true &&
    payloadKey !== undefined &&
    isLikelyBase64Payload(record[payloadKey] as string);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isBinaryPayload && BINARY_PAYLOAD_KEYS.includes(key)) {
      output[key] = item;
    } else if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
    } else {
      output[key] = redactRecursive(item, depth + 1, seen, false);
    }
  }
  return output;
}

/**
 * Redact secrets from an arbitrary value. `allowBinary` may be set ONLY by a
 * caller that knows the value came from a tool whose `base64Encoded` flag is
 * CDP-sourced (see BINARY_CAPABLE_TOOLS) — it permits preserving a genuine
 * top-level binary body. It defaults to false so every other caller redacts
 * unconditionally.
 */
export function redactSecrets(value: unknown, allowBinary = false): unknown {
  return redactRecursive(value, 0, new WeakSet<object>(), allowBinary);
}

export function redactToolText(text: string, allowBinary = false): string {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text), allowBinary));
  } catch {
    return redactString(text);
  }
}
