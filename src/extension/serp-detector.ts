// Pure SERP detection module — no Chrome API calls, fully testable.

/** Google SERP URL pattern — matches google.com, google.co.uk, google.com.au, etc.
 * Requires /search? with a q= parameter, which is what distinguishes a results page from
 * the homepage or any other google.* path. */
const GOOGLE_SERP_REGEX = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/search\?/i;

export interface SerpPattern {
  name: string;
  test: (url: string) => boolean;
}

/** Compiled SERP patterns — Google for now, extensible for Bing/Yahoo/DDG later */
export const SERP_PATTERNS: SerpPattern[] = [
  {
    name: "Google",
    test: (url: string) => GOOGLE_SERP_REGEX.test(url) && extractSearchQuery(url) !== null,
  },
];

/** Check if a URL is a Google SERP page */
export function isGoogleSerp(url: string): boolean {
  if (!url) return false;
  return SERP_PATTERNS.some(p => p.test(url));
}

/** Extract the search query (q= parameter) from a Google SERP URL.
 * Returns null if URL is not a SERP or has no query. */
export function extractSearchQuery(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q");
    return q && q.trim().length > 0 ? q.trim() : null;
  } catch {
    return null;
  }
}
