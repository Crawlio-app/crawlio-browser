import { describe, it, expect } from "vitest";
import { telemetryEnabled, getInstallId } from "../../src/mcp-server/telemetry.js";

describe("telemetry (anonymous, opt-out)", () => {
  it("is ON by default and OFF for 0/false/off/no (case-insensitive)", () => {
    expect(telemetryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(telemetryEnabled({ CRAWLIO_TELEMETRY: "" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    for (const v of ["0", "false", "off", "no", "FALSE", "Off", "  NO  "]) {
      expect(telemetryEnabled({ CRAWLIO_TELEMETRY: v } as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
    for (const v of ["1", "true", "on", "yes", "enabled"]) {
      expect(telemetryEnabled({ CRAWLIO_TELEMETRY: v } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it("getInstallId returns a stable anonymous UUID across calls", () => {
    const a = getInstallId();
    const b = getInstallId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).toBe(b); // cached + persisted → stable
  });
});
