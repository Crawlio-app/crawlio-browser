import { describe, it, expect } from "vitest";
import { normalizeURL, urlKey, isSameURL } from "@/shared/url-normalize";

describe("normalizeURL", () => {
  it("strips fragment", () => {
    expect(normalizeURL("https://example.com/page#section")).toBe("https://example.com/page");
  });

  it("strips trailing slash", () => {
    expect(normalizeURL("https://example.com/page/")).toBe("https://example.com/page");
  });

  it("preserves root slash", () => {
    expect(normalizeURL("https://example.com/")).toBe("https://example.com/");
  });

  it("sorts query parameters", () => {
    expect(normalizeURL("https://example.com/?b=2&a=1")).toBe("https://example.com/?a=1&b=2");
  });

  it("removes default port 80", () => {
    expect(normalizeURL("http://example.com:80/page")).toBe("http://example.com/page");
  });

  it("removes default port 443", () => {
    expect(normalizeURL("https://example.com:443/page")).toBe("https://example.com/page");
  });

  it("decodes unreserved percent-encoded characters", () => {
    expect(normalizeURL("https://example.com/%41%42")).toBe("https://example.com/AB");
  });

  it("preserves reserved percent-encoded characters", () => {
    expect(normalizeURL("https://example.com/%2F")).toBe("https://example.com/%2F");
  });

  it("returns original on invalid URL", () => {
    expect(normalizeURL("not-a-url")).toBe("not-a-url");
  });
});

describe("isSameURL", () => {
  it("matches URLs with different fragments", () => {
    expect(isSameURL("https://example.com#a", "https://example.com#b")).toBe(true);
  });

  it("matches URLs with different query order", () => {
    expect(isSameURL("https://example.com?b=2&a=1", "https://example.com?a=1&b=2")).toBe(true);
  });
});

describe("urlKey", () => {
  it("produces consistent key", () => {
    expect(urlKey("https://example.com/page#section")).toBe(urlKey("https://example.com/page"));
  });
});
