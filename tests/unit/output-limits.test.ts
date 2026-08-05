import { describe, it, expect, afterEach } from "vitest";
import { truncateOutput, getMaxOutput, DEFAULT_MAX_OUTPUT_CHARS } from "../../src/mcp-server/output-limits.js";

describe("truncateOutput", () => {
  it("returns content unchanged when under limit", () => {
    const result = truncateOutput("hello world", 100);
    expect(result.content).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.originalSize).toBe(11);
  });

  it("returns content unchanged when exactly at limit", () => {
    const content = "a".repeat(50);
    const result = truncateOutput(content, 50);
    expect(result.content).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.originalSize).toBe(50);
  });

  it("truncates at exact character count", () => {
    const content = "a".repeat(200);
    const result = truncateOutput(content, 100);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("a".repeat(100));
    expect(result.content).not.toContain("a".repeat(101));
  });

  it("appends truncation message with original size", () => {
    const content = "x".repeat(500);
    const result = truncateOutput(content, 100);
    expect(result.content).toContain("[truncated: showing 100 of 500 chars]");
  });

  it("reports originalSize correctly", () => {
    const content = "test content that is somewhat long";
    const result = truncateOutput(content, 10);
    expect(result.originalSize).toBe(content.length);
  });

  it("calculates estimatedTokens for non-truncated content", () => {
    const content = "a".repeat(100);
    const result = truncateOutput(content, 200);
    expect(result.estimatedTokens).toBe(Math.ceil(100 / 4));
  });

  it("calculates estimatedTokens for truncated content based on result size", () => {
    const content = "a".repeat(1000);
    const result = truncateOutput(content, 100);
    expect(result.estimatedTokens).toBe(Math.ceil(result.content.length / 4));
  });

  it("handles empty string", () => {
    const result = truncateOutput("", 100);
    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.originalSize).toBe(0);
  });

  it("handles single character truncation boundary", () => {
    const result = truncateOutput("ab", 1);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("a");
    expect(result.content).toContain("[truncated: showing 1 of 2 chars]");
  });
});

describe("getMaxOutput", () => {
  const originalEnv = process.env.CRAWLIO_MAX_OUTPUT;
  const originalMode = process.env.CRAWLIO_CONTEXT_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CRAWLIO_MAX_OUTPUT;
    } else {
      process.env.CRAWLIO_MAX_OUTPUT = originalEnv;
    }
    if (originalMode === undefined) {
      delete process.env.CRAWLIO_CONTEXT_MODE;
    } else {
      process.env.CRAWLIO_CONTEXT_MODE = originalMode;
    }
  });

  it("returns default when env var is unset", () => {
    delete process.env.CRAWLIO_MAX_OUTPUT;
    delete process.env.CRAWLIO_CONTEXT_MODE;
    expect(getMaxOutput()).toBe(DEFAULT_MAX_OUTPUT_CHARS);
  });

  it("returns default when env var is empty string", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "";
    delete process.env.CRAWLIO_CONTEXT_MODE;
    expect(getMaxOutput()).toBe(DEFAULT_MAX_OUTPUT_CHARS);
  });

  it("returns default when env var is not a number", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "abc";
    delete process.env.CRAWLIO_CONTEXT_MODE;
    expect(getMaxOutput()).toBe(DEFAULT_MAX_OUTPUT_CHARS);
  });

  it("returns null when env var is zero", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "0";
    expect(getMaxOutput()).toBeNull();
  });

  it("returns null when env var is negative", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "-100";
    expect(getMaxOutput()).toBeNull();
  });

  it("returns null in explicit RE mode by default", () => {
    delete process.env.CRAWLIO_MAX_OUTPUT;
    process.env.CRAWLIO_CONTEXT_MODE = "traffic-analysis";
    expect(getMaxOutput()).toBeNull();
  });

  it("returns parsed number for valid positive integer", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "50000";
    expect(getMaxOutput()).toBe(50000);
  });

  it("returns parsed number for large values", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "1000000";
    expect(getMaxOutput()).toBe(1000000);
  });

  it("truncates decimal values to integer", () => {
    process.env.CRAWLIO_MAX_OUTPUT = "100.7";
    expect(getMaxOutput()).toBe(100);
  });
});
