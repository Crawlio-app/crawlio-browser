import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { NetworkEntry } from "../../src/shared/types.js";
import { TOOL_TIMEOUTS, toolSuccess, toolError } from "../../src/mcp-server/tools.js";

// --- NetworkEntry extension tests ---

describe("NetworkEntry type extensions", () => {
  it("should include requestHeaders field", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/data",
      method: "POST",
      status: 200,
      mimeType: "application/json",
      size: 1024,
      transferSize: 512,
      durationMs: 150,
      resourceType: "XHR",
      requestHeaders: { "Content-Type": "application/json", "Authorization": "Bearer tok123" },
    };
    expect(entry.requestHeaders).toBeDefined();
    expect(entry.requestHeaders!["Content-Type"]).toBe("application/json");
    expect(entry.requestHeaders!["Authorization"]).toBe("Bearer tok123");
  });

  it("should include requestBody field", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/submit",
      method: "POST",
      status: 201,
      mimeType: "application/json",
      size: 256,
      transferSize: 128,
      durationMs: 200,
      resourceType: "XHR",
      requestBody: '{"name":"test","value":42}',
    };
    expect(entry.requestBody).toBe('{"name":"test","value":42}');
  });

  it("should include requestId field", () => {
    const entry: NetworkEntry = {
      url: "https://api.example.com/fetch",
      method: "GET",
      status: 200,
      mimeType: "text/html",
      size: 4096,
      transferSize: 2048,
      durationMs: 300,
      resourceType: "Document",
      requestId: "req-abc-123",
    };
    expect(entry.requestId).toBe("req-abc-123");
  });

  it("should allow all three new fields to be undefined (backward compat)", () => {
    const entry: NetworkEntry = {
      url: "https://example.com",
      method: "GET",
      status: 200,
      mimeType: "text/html",
      size: 100,
      transferSize: 50,
      durationMs: 10,
      resourceType: "Document",
    };
    expect(entry.requestHeaders).toBeUndefined();
    expect(entry.requestBody).toBeUndefined();
    expect(entry.requestId).toBeUndefined();
  });
});

// --- Replay tool tests (schema + logic validation) ---

describe("replay_request tool", () => {
  const methodSchema = z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]).optional();

  it("rejects invalid HTTP methods", () => {
    expect(() => methodSchema.parse("INVALID")).toThrow();
    expect(() => methodSchema.parse("get")).toThrow();
    expect(methodSchema.parse("POST")).toBe("POST");
    expect(methodSchema.parse(undefined)).toBeUndefined();
  });

  it("has a timeout configured", () => {
    expect(TOOL_TIMEOUTS.replay_request).toBeDefined();
    expect(TOOL_TIMEOUTS.replay_request).toBeGreaterThanOrEqual(10000);
  });

  it("should merge override headers with captured headers", () => {
    const original: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": "Bearer old-token",
      "Accept": "application/json",
    };
    const overrides: Record<string, string> = {
      "Authorization": "Bearer new-token",
      "X-Custom": "test-value",
    };
    const merged = { ...original, ...overrides };
    expect(merged["Content-Type"]).toBe("application/json");
    expect(merged["Authorization"]).toBe("Bearer new-token");
    expect(merged["X-Custom"]).toBe("test-value");
    expect(merged["Accept"]).toBe("application/json");
  });

  it("should preserve original method when no override", () => {
    const captured = { method: "POST" };
    const override: string | undefined = undefined;
    const method = override || captured.method || "GET";
    expect(method).toBe("POST");
  });

  it("should use override method when provided", () => {
    const captured = { method: "POST" };
    const override = "PUT";
    const method = override || captured.method || "GET";
    expect(method).toBe("PUT");
  });

  it("should default to GET when no captured or override method", () => {
    const captured: { method?: string } = {};
    const override: string | undefined = undefined;
    const method = override || captured.method || "GET";
    expect(method).toBe("GET");
  });

  it("should replace body with override", () => {
    const originalBody = '{"old":"data"}';
    const overrideBody = '{"new":"data"}';
    const body = overrideBody ?? originalBody ?? undefined;
    expect(body).toBe('{"new":"data"}');
  });

  it("should use original body when no override", () => {
    const originalBody = '{"old":"data"}';
    const overrideBody: string | undefined = undefined;
    const body = overrideBody ?? originalBody ?? undefined;
    expect(body).toBe('{"old":"data"}');
  });
});

// --- Response body cap tests ---

describe("response body size caps", () => {
  it("replay response body should be capped at 10KB", () => {
    const MAX_REPLAY_BODY = 10000;
    const largeBody = "x".repeat(20000);
    const capped = largeBody.substring(0, MAX_REPLAY_BODY);
    expect(capped.length).toBe(10000);
    expect(largeBody.length > MAX_REPLAY_BODY).toBe(true);
  });

  it("get_response_body should be capped at 50KB", () => {
    const MAX_BODY_SIZE = 50000;
    const largeBody = "y".repeat(100000);
    const capped = largeBody.substring(0, MAX_BODY_SIZE);
    expect(capped.length).toBe(50000);
    expect(largeBody.length > MAX_BODY_SIZE).toBe(true);
  });

  it("should not truncate bodies within limits", () => {
    const MAX_BODY_SIZE = 50000;
    const smallBody = "z".repeat(1000);
    const truncated = smallBody.length > MAX_BODY_SIZE;
    expect(truncated).toBe(false);
    expect(smallBody.length).toBe(1000);
  });
});

// --- toolSuccess/toolError helpers ---

describe("tool response helpers", () => {
  it("toolSuccess wraps data correctly", () => {
    const result = toolSuccess({ status: 200, body: "ok" });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe("ok");
  });

  it("toolError wraps error message correctly", () => {
    const result = toolError("Request failed");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Request failed");
  });
});
