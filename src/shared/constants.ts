import { homedir } from "os";
import { join } from "path";

// Single source of truth — bump here, tests enforce sync with package.json
export const PKG_VERSION = "1.9.0";

// CRAWLIO_WS_PORT relocates the whole 10-slot range (tests/dev isolation).
// The extension only discovers the default range (background.ts WS_PORT_END),
// so production deployments must leave it unset.
const wsPortOverride = Number.parseInt(process.env.CRAWLIO_WS_PORT ?? "", 10);
export const WS_PORT = Number.isInteger(wsPortOverride) && wsPortOverride > 0 ? wsPortOverride : 9333;
export const WS_PORT_MAX = WS_PORT + 9;    // end of port range (inclusive) — 10 slots
export const WS_HOST = "127.0.0.1";

// Bridge discovery directory — each running server writes a JSON file here
export const BRIDGE_DIR = join(homedir(), ".crawlio", "bridges");

export const CRAWLIO_PORT_FILE = join(
  homedir(),
  "Library",
  "Logs",
  "Crawlio",
  "control.port"
);

export const TIMEOUTS = {
  WS_COMMAND: 30_000,       // 30s for most commands
  NETWORK_CAPTURE: 120_000, // 2min for network capture
  SCREENSHOT: 10_000,       // 10s
  RECONNECT: 3_000,         // 3s reconnect delay
  CODE_EXECUTE: 120_000,    // 2min for code-mode execute()
} as const;

// Bridge heartbeat — tuned for heavy execute sessions
export const WS_HEARTBEAT_INTERVAL = 20_000;  // 20s between pings
export const WS_STALE_THRESHOLD = 90_000;     // 90s before declaring stale
export const WS_RECONNECT_GRACE = 5_000;      // 5s grace period before rejecting pending commands
