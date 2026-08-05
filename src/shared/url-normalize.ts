/**
 * URL normalization following RFC 3986.
 * Chain: parse -> strip fragment -> strip trailing slash -> decode percent ->
 *        lowercase scheme/host -> sort query params -> remove default ports
 */

export function normalizeURL(url: string): string {
  try {
    const parsed = new URL(url);

    // 1. Strip fragment
    parsed.hash = "";

    // 2. Lowercase scheme and hostname (URL constructor already does this)

    // 3. Remove default ports
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }

    // 4. Sort query parameters
    const sorted = new URLSearchParams(
      [...parsed.searchParams.entries()].sort()
    );
    parsed.search = sorted.toString() ? `?${sorted.toString()}` : "";

    // 5. Strip trailing slash (except root path "/")
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;

    // 6. Decode percent-encoded unreserved characters
    return decodeUnreservedPercent(parsed.toString());
  } catch {
    return url;
  }
}

/**
 * Decode percent-encoded unreserved characters (RFC 3986 section 2.3).
 */
function decodeUnreservedPercent(url: string): string {
  return url.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => {
    const code = parseInt(hex, 16);
    // Unreserved: ALPHA / DIGIT / "-" / "." / "_" / "~"
    if (
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e
    ) {
      return String.fromCharCode(code);
    }
    return match;
  });
}

/** Generate a URL key for Map lookups. */
export function urlKey(url: string): string {
  return normalizeURL(url);
}

/** Compare two URLs for equivalence after normalization. */
export function isSameURL(a: string, b: string): boolean {
  return normalizeURL(a) === normalizeURL(b);
}
