import type { NetworkEntry } from "../shared/types";
import type { NetworkEntryInternal } from "./sensors/network-sensor";

type NetworkMapEntry = Omit<NetworkEntryInternal, "_startTime"> & {
  _startTime?: number;
  _seq?: number;
};

const SENSITIVE_KEY_PATTERNS = /password|token|secret|api[_-]?key|auth(?:orization|_token|_key|_secret)|credential|bearer|cookie/i;
const SENSITIVE_URL_KEY_PATTERNS = /password|passcode|token|secret|api[_-]?key|access[_-]?key|auth|credential|bearer|cookie|session|^(?:code|key|sid|jwt)$/i;
// CDP preserves header casing. Referer/Referrer therefore needs the same case-insensitive
// treatment as ordinary URL-shaped object fields before a resident capture enters IndexedDB.
const URL_FIELD_KEY_PATTERN = /^(?:url|uri|href|referer|referrer)$|(?:Url|URL|Uri|URI|Href)$/i;

const SENSITIVE_VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /^[A-Fa-f0-9]{32,}$/, // Hex credential (32+ chars)
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // Base64 (40+ chars)
  /^sk-[A-Za-z0-9]{20,}/, // OpenAI key
  /^ghp_[A-Za-z0-9]{20,}/, // GitHub PAT
  /^xoxb-[A-Za-z0-9-]+/, // Slack bot token
  /^AKIA[0-9A-Z]{16}/, // AWS access key ID
  /^ASIA[0-9A-Z]{16}/, // AWS temporary access key ID
];

const MAX_STRING_LENGTH = 1000;

export function sanitizeUrlValue(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY_PATTERNS.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    const hash = url.hash.slice(1);
    if (hash.includes("=")) {
      const fragment = new URLSearchParams(hash);
      for (const key of [...fragment.keys()]) {
        if (SENSITIVE_URL_KEY_PATTERNS.test(key)) fragment.set(key, "[REDACTED]");
      }
      url.hash = fragment.toString();
    }
    return url.href;
  } catch {
    return value.replace(
      /([?&#](?:password|passcode|token|secret|api[_-]?key|access[_-]?key|auth|credential|bearer|cookie|session|code|key|sid|jwt)=)[^&#]*/gi,
      "$1[REDACTED]",
    );
  }
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth limit]";

  if (typeof value === "string") {
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(value)) return "[REDACTED]";
    }
    if (value.length > MAX_STRING_LENGTH) {
      return value.slice(0, MAX_STRING_LENGTH) + `... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERNS.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof val === "string" && URL_FIELD_KEY_PATTERN.test(key)) {
        sanitized[key] = sanitizeUrlValue(val);
      } else {
        sanitized[key] = sanitizeValue(val, depth + 1);
      }
    }
    return sanitized;
  }

  return value;
}

/** Redact credentials embedded in serialized JSON/form bodies before they enter resident IDB. */
export function sanitizeTextPayload(value: string, contentType = ""): string {
  const capped = value.slice(0, 100_000);
  try {
    const parsed = JSON.parse(capped) as unknown;
    return JSON.stringify(sanitizeValue(parsed));
  } catch { /* not JSON */ }

  // URL-encoded request bodies are common for login forms. Only treat the string as a form when
  // it has key/value syntax; otherwise URLSearchParams would turn arbitrary text into one key.
  const looksLikeForm = /application\/x-www-form-urlencoded/i.test(contentType)
    || /^[^<>{}\s=&]+=[^&]*(?:&[^<>{}\s=&]+=[^&]*)*$/.test(capped);
  if (looksLikeForm) {
    try {
      const form = new URLSearchParams(capped);
      if ([...form.keys()].length > 0) {
        for (const key of [...form.keys()]) {
          const values = form.getAll(key);
          form.delete(key);
          for (const item of values) form.append(key, SENSITIVE_KEY_PATTERNS.test(key) ? "[REDACTED]" : String(sanitizeValue(item)));
        }
        return form.toString();
      }
    } catch { /* fall through to conservative text replacement */ }
  }

  return String(sanitizeValue(capped))
    .replace(/((?:password|token|secret|api[_-]?key|authorization|credential|cookie)\s*[=:]\s*)[^&\s,;]+/gi, "$1[REDACTED]");
}

export function sanitizeNetworkEntry(
  entry: NetworkMapEntry & { requestId: string },
): NetworkEntry & { requestId: string } {
  const contentType = Object.entries(entry.requestHeaders ?? {})
    .find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  const copy: NetworkMapEntry = {
    ...entry,
    url: sanitizeUrlValue(entry.url),
    requestHeaders: entry.requestHeaders ? { ...entry.requestHeaders } : undefined,
    requestBody: typeof entry.requestBody === "string"
      ? sanitizeTextPayload(entry.requestBody, contentType)
      : entry.requestBody,
  };
  return sanitizeValue(copy) as NetworkEntry & { requestId: string };
}
