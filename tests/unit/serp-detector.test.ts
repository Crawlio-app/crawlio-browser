import { describe, it, expect } from "vitest";
import { isGoogleSerp, extractSearchQuery, SERP_PATTERNS } from "@/extension/serp-detector";

describe("isGoogleSerp", () => {
  it("detects google.com SERP", () => {
    expect(isGoogleSerp("https://www.google.com/search?q=test")).toBe(true);
  });

  it("detects google.co.uk SERP", () => {
    expect(isGoogleSerp("https://www.google.co.uk/search?q=london+weather")).toBe(true);
  });

  it("detects google.com.au SERP", () => {
    expect(isGoogleSerp("https://www.google.com.au/search?q=crawlio")).toBe(true);
  });

  it("detects without www prefix", () => {
    expect(isGoogleSerp("https://google.com/search?q=test")).toBe(true);
  });

  it("detects http (non-https)", () => {
    expect(isGoogleSerp("http://www.google.com/search?q=test")).toBe(true);
  });

  it("rejects google.com homepage (no /search)", () => {
    expect(isGoogleSerp("https://www.google.com/")).toBe(false);
  });

  it("rejects google.com/search without q= parameter", () => {
    expect(isGoogleSerp("https://www.google.com/search?tbm=isch")).toBe(false);
  });

  it("rejects non-Google URLs", () => {
    expect(isGoogleSerp("https://www.bing.com/search?q=test")).toBe(false);
  });

  it("rejects chrome:// URLs", () => {
    expect(isGoogleSerp("chrome://extensions/")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isGoogleSerp("")).toBe(false);
  });

  it("rejects malformed URL", () => {
    expect(isGoogleSerp("not-a-url")).toBe(false);
  });

  it("detects SERP with additional parameters", () => {
    expect(isGoogleSerp("https://www.google.com/search?q=crawlio&hl=en&num=10")).toBe(true);
  });

  it("rejects Google Maps", () => {
    expect(isGoogleSerp("https://www.google.com/maps?q=test")).toBe(false);
  });

  it("rejects Google Images (no /search path)", () => {
    expect(isGoogleSerp("https://www.google.com/imghp")).toBe(false);
  });

  it("detects Google Image search via /search path", () => {
    expect(isGoogleSerp("https://www.google.com/search?q=cats&tbm=isch")).toBe(true);
  });
});

describe("extractSearchQuery", () => {
  it("extracts q= parameter", () => {
    expect(extractSearchQuery("https://www.google.com/search?q=crawlio+browser")).toBe("crawlio browser");
  });

  it("extracts URL-encoded query", () => {
    expect(extractSearchQuery("https://www.google.com/search?q=hello%20world")).toBe("hello world");
  });

  it("returns null for homepage", () => {
    expect(extractSearchQuery("https://www.google.com/")).toBeNull();
  });

  it("returns null for empty q=", () => {
    expect(extractSearchQuery("https://www.google.com/search?q=")).toBeNull();
  });

  it("returns null for whitespace-only q=", () => {
    expect(extractSearchQuery("https://www.google.com/search?q=%20%20")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractSearchQuery("")).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(extractSearchQuery("not-a-url")).toBeNull();
  });

  it("extracts query from google.co.uk", () => {
    expect(extractSearchQuery("https://www.google.co.uk/search?q=test+query&hl=en")).toBe("test query");
  });

  it("trims whitespace from query", () => {
    expect(extractSearchQuery("https://www.google.com/search?q=%20test%20")).toBe("test");
  });
});

describe("SERP_PATTERNS", () => {
  it("has at least one pattern", () => {
    expect(SERP_PATTERNS.length).toBeGreaterThanOrEqual(1);
  });

  it("includes Google pattern", () => {
    expect(SERP_PATTERNS.some(p => p.name === "Google")).toBe(true);
  });
});
