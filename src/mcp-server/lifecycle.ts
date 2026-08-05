export const DEFAULT_STDIO_TOOL_IDLE_EXIT_MS = 10 * 60 * 1000;
export const DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS = 5 * 60 * 1000;
export const ROBOT_STDIO_TOOL_IDLE_EXIT_MS = 2 * 60 * 60 * 1000;
export const ROBOT_STDIO_STARTUP_IDLE_EXIT_MS = 15 * 60 * 1000;
export const MONITOR_STDIO_TOOL_IDLE_EXIT_MS = 0;
export const MONITOR_STDIO_STARTUP_IDLE_EXIT_MS = 0;

export type LifecycleLane = "default" | "robot" | "monitor";
export type StdioIdleReason = "disabled" | "active_request" | "startup_idle" | "tool_idle" | "within_limit";

export interface StdioLifecycleConfig {
  lane: LifecycleLane;
  toolIdleExitMs: number;
  startupIdleExitMs: number;
}

export interface StdioIdleState {
  now: number;
  serverStartedAt: number;
  lastToolActivity: number | null;
  activeMcpRequests: number;
  toolIdleExitMs: number;
  startupIdleExitMs: number;
}

export interface StdioIdleDecision {
  shouldExit: boolean;
  reason: StdioIdleReason;
  idleMs: number;
  limitMs: number | null;
}

export function parseDurationEnv(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallbackMs;
  return value;
}

function normalizeLifecycleLane(raw: string | undefined): LifecycleLane | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "default" || value === "stdio" || value === "ephemeral") return "default";
  if (value === "robot" || value === "robots" || value === "training") return "robot";
  if (value === "monitor" || value === "monitors" || value === "watch") return "monitor";
  return null;
}

function readArgValue(argv: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equalsMatch = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsMatch) return equalsMatch.slice(equalsPrefix.length);

  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  return undefined;
}

export function resolveLifecycleLane(
  argv: string[],
  env: Record<string, string | undefined>,
): LifecycleLane {
  if (argv.includes("--monitor")) return "monitor";
  if (argv.includes("--robot")) return "robot";

  const cliLane = normalizeLifecycleLane(readArgValue(argv, "--lifecycle-lane"));
  if (cliLane) return cliLane;

  const envLane = normalizeLifecycleLane(env.CRAWLIO_LIFECYCLE_LANE ?? env.CRAWLIO_LANE);
  return envLane ?? "default";
}

function defaultsForLane(lane: LifecycleLane): Omit<StdioLifecycleConfig, "lane"> {
  if (lane === "robot") {
    return {
      toolIdleExitMs: ROBOT_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: ROBOT_STDIO_STARTUP_IDLE_EXIT_MS,
    };
  }
  if (lane === "monitor") {
    return {
      toolIdleExitMs: MONITOR_STDIO_TOOL_IDLE_EXIT_MS,
      startupIdleExitMs: MONITOR_STDIO_STARTUP_IDLE_EXIT_MS,
    };
  }
  return {
    toolIdleExitMs: DEFAULT_STDIO_TOOL_IDLE_EXIT_MS,
    startupIdleExitMs: DEFAULT_STDIO_STARTUP_IDLE_EXIT_MS,
  };
}

export function resolveStdioLifecycleConfig(
  argv: string[],
  env: Record<string, string | undefined>,
): StdioLifecycleConfig {
  const lane = resolveLifecycleLane(argv, env);
  const defaults = defaultsForLane(lane);
  const toolIdleExitMs = parseDurationEnv(env.CRAWLIO_STDIO_IDLE_EXIT_MS, defaults.toolIdleExitMs);
  const startupIdleExitMs = toolIdleExitMs === 0
    ? 0
    : parseDurationEnv(env.CRAWLIO_STDIO_STARTUP_IDLE_EXIT_MS, defaults.startupIdleExitMs);

  return { lane, toolIdleExitMs, startupIdleExitMs };
}

export function decideStdioIdleExit(state: StdioIdleState): StdioIdleDecision {
  if (state.toolIdleExitMs === 0) {
    return { shouldExit: false, reason: "disabled", idleMs: 0, limitMs: null };
  }

  if (state.activeMcpRequests > 0) {
    return { shouldExit: false, reason: "active_request", idleMs: 0, limitMs: null };
  }

  const hasToolActivity = state.lastToolActivity !== null;
  const idleBase = hasToolActivity ? state.lastToolActivity! : state.serverStartedAt;
  const limitMs = hasToolActivity ? state.toolIdleExitMs : state.startupIdleExitMs;
  const idleMs = Math.max(0, state.now - idleBase);

  if (limitMs === 0) {
    return { shouldExit: false, reason: "disabled", idleMs, limitMs: null };
  }

  if (idleMs >= limitMs) {
    return {
      shouldExit: true,
      reason: hasToolActivity ? "tool_idle" : "startup_idle",
      idleMs,
      limitMs,
    };
  }

  return { shouldExit: false, reason: "within_limit", idleMs, limitMs };
}
