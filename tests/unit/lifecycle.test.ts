import { describe, expect, it } from "vitest";
import {
  DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
  DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
  MONITOR_STDIO_TOOL_IDLE_EXIT_MS,
  ROBOT_STDIO_STARTUP_IDLE_EXIT_MS,
  ROBOT_STDIO_TOOL_IDLE_EXIT_MS,
  decideStdioIdleExit,
  parseDurationEnv,
  resolveLifecycleLane,
  resolveStdioLifecycleConfig,
} from "@/mcp-server/lifecycle";

describe("MCP stdio lifecycle", () => {
  it("uses sane default idle limits", () => {
    expect(DEFAULT_STDIO_TOOL_IDLE_EXIT_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS).toBe(5 * 60 * 1000);
    expect(ROBOT_STDIO_TOOL_IDLE_EXIT_MS).toBe(2 * 60 * 60 * 1000);
    expect(ROBOT_STDIO_STARTUP_IDLE_EXIT_MS).toBe(15 * 60 * 1000);
    expect(MONITOR_STDIO_TOOL_IDLE_EXIT_MS).toBe(0);
  });

  it("falls back for missing, invalid, or negative duration env values", () => {
    expect(parseDurationEnv(undefined, 123)).toBe(123);
    expect(parseDurationEnv("", 123)).toBe(123);
    expect(parseDurationEnv("nope", 123)).toBe(123);
    expect(parseDurationEnv("-1", 123)).toBe(123);
    expect(parseDurationEnv("0", 123)).toBe(0);
    expect(parseDurationEnv("456", 123)).toBe(456);
  });

  it("exits unused stdio servers after startup idle limit", () => {
    const decision = decideStdioIdleExit({
      now: 6 * 60 * 1000,
      serverStartedAt: 0,
      lastToolActivity: null,
      activeMcpRequests: 0,
      toolIdleExitMs: DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
    });

    expect(decision).toMatchObject({
      shouldExit: true,
      reason: "startup_idle",
      limitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
    });
  });

  it("exits after tool inactivity even if the MCP client process is still alive", () => {
    const decision = decideStdioIdleExit({
      now: 20 * 60 * 1000,
      serverStartedAt: 0,
      lastToolActivity: 9 * 60 * 1000,
      activeMcpRequests: 0,
      toolIdleExitMs: DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
    });

    expect(decision).toMatchObject({
      shouldExit: true,
      reason: "tool_idle",
      limitMs: DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
    });
  });

  it("does not exit while a tool request is active", () => {
    const decision = decideStdioIdleExit({
      now: 60 * 60 * 1000,
      serverStartedAt: 0,
      lastToolActivity: 0,
      activeMcpRequests: 1,
      toolIdleExitMs: DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
    });

    expect(decision).toMatchObject({
      shouldExit: false,
      reason: "active_request",
    });
  });

  it("supports disabling stdio idle exit with a zero tool idle limit", () => {
    const decision = decideStdioIdleExit({
      now: 60 * 60 * 1000,
      serverStartedAt: 0,
      lastToolActivity: 0,
      activeMcpRequests: 0,
      toolIdleExitMs: 0,
      startupIdleExitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
    });

    expect(decision).toMatchObject({
      shouldExit: false,
      reason: "disabled",
      limitMs: null,
    });
  });

  it("resolves lifecycle lanes from CLI flags and shell variables", () => {
    expect(resolveLifecycleLane([], {})).toBe("default");
    expect(resolveLifecycleLane(["--robot"], {})).toBe("robot");
    expect(resolveLifecycleLane(["--monitor"], {})).toBe("monitor");
    expect(resolveLifecycleLane(["--lifecycle-lane", "robot"], {})).toBe("robot");
    expect(resolveLifecycleLane(["--lifecycle-lane=monitor"], {})).toBe("monitor");
    expect(resolveLifecycleLane([], { CRAWLIO_LIFECYCLE_LANE: "robots" })).toBe("robot");
    expect(resolveLifecycleLane([], { CRAWLIO_LANE: "watch" })).toBe("monitor");
    expect(resolveLifecycleLane([], { CRAWLIO_LIFECYCLE_LANE: "unknown" })).toBe("default");
  });

  it("resolves default, robot, and monitor stdio lifecycle configs", () => {
    expect(resolveStdioLifecycleConfig([], {})).toEqual({
      lane: "default",
      toolIdleExitMs: DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
    });

    expect(resolveStdioLifecycleConfig(["--robot"], {})).toEqual({
      lane: "robot",
      toolIdleExitMs: ROBOT_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: ROBOT_STDIO_STARTUP_IDLE_EXIT_MS,
    });

    expect(resolveStdioLifecycleConfig(["--monitor"], {})).toEqual({
      lane: "monitor",
      toolIdleExitMs: 0,
      startupIdleExitMs: 0,
    });
  });

  it("lets explicit timeout variables override lane defaults", () => {
    expect(resolveStdioLifecycleConfig(["--robot"], {
      CRAWLIO_STDIO_IDLE_EXIT_MS: "1234",
      CRAWLIO_STDIO_STARTUP_IDLE_EXIT_MS: "567",
    })).toEqual({
      lane: "robot",
      toolIdleExitMs: 1234,
      startupIdleExitMs: 567,
    });
  });

  it("sets startup idle to disabled when tool idle is disabled", () => {
    expect(resolveStdioLifecycleConfig(["--robot"], {
      CRAWLIO_STDIO_IDLE_EXIT_MS: "0",
      CRAWLIO_STDIO_STARTUP_IDLE_EXIT_MS: "999",
    })).toEqual({
      lane: "robot",
      toolIdleExitMs: 0,
      startupIdleExitMs: 0,
    });
  });
});
