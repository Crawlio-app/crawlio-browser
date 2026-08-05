import { describe, it, expect } from "vitest";
import type { NetworkCaptureState } from "@/extension/sensors/network-sensor";

describe("NetworkCaptureState", () => {
  it("can create initial state", () => {
    const state: NetworkCaptureState = {
      capturing: false,
      entries: new Map(),
    };
    expect(state.capturing).toBe(false);
    expect(state.entries.size).toBe(0);
  });

  it("tracks entries by requestId", () => {
    const state: NetworkCaptureState = {
      capturing: true,
      entries: new Map(),
    };
    state.entries.set("req-1", {
      url: "https://example.com/api",
      method: "GET",
      status: 200,
      mimeType: "application/json",
      size: 1024,
      transferSize: 512,
      durationMs: 150,
      resourceType: "XHR",
      _startTime: Date.now(),
    });
    expect(state.entries.has("req-1")).toBe(true);
    expect(state.entries.get("req-1")!.status).toBe(200);
  });

  it("supports multiple concurrent entries", () => {
    const state: NetworkCaptureState = {
      capturing: true,
      entries: new Map(),
    };
    state.entries.set("req-1", {
      url: "https://example.com/a",
      method: "GET",
      status: 200,
      mimeType: "text/html",
      size: 0,
      transferSize: 0,
      durationMs: 0,
      resourceType: "Document",
      _startTime: 0,
    });
    state.entries.set("req-2", {
      url: "https://example.com/b",
      method: "POST",
      status: 201,
      mimeType: "application/json",
      size: 0,
      transferSize: 0,
      durationMs: 0,
      resourceType: "XHR",
      _startTime: 0,
    });
    expect(state.entries.size).toBe(2);
  });

  it("can simulate loading failed entry", () => {
    const state: NetworkCaptureState = {
      capturing: true,
      entries: new Map(),
    };
    state.entries.set("req-fail", {
      url: "https://example.com/missing",
      method: "GET",
      status: -1,
      mimeType: "",
      size: 0,
      transferSize: 0,
      durationMs: 0,
      resourceType: "XHR",
      _startTime: 0,
    });
    expect(state.entries.get("req-fail")!.status).toBe(-1);
  });
});
