import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Redirect the module's notion of $HOME to a throwaway directory BEFORE importing telemetry.ts,
// which resolves `~/.crawlio/install-id` once at module load. Without this, exercising rotation
// would delete the developer's real install id as a side effect of running the test suite.
const { TEMP_HOME } = vi.hoisted(() => ({
  TEMP_HOME: `${process.env.TMPDIR?.replace(/\/$/, "") || "/tmp"}/crawlio-telemetry-rotate-${process.pid}`,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEMP_HOME };
});

const { getInstallId, rotateInstallId, installIdPath, telemetryEndpoint } = await import(
  "../../src/mcp-server/telemetry.js"
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterAll(() => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("install id rotation (E2 — deletion must actually work)", () => {
  it("writes the id under the mocked home, not the real one", () => {
    expect(installIdPath()).toBe(join(TEMP_HOME, ".crawlio", "install-id"));
  });

  it("rotate replaces the id with a different, valid, persisted UUID", () => {
    const before = getInstallId();
    expect(before).toMatch(UUID_RE);

    const { previous, next } = rotateInstallId();

    expect(previous).toBe(before);
    expect(next).toMatch(UUID_RE);
    expect(next).not.toBe(before);

    // Persisted, and now the stable value — this is the property GDID lacks: deleting the local
    // copy yields a NEW identifier rather than re-fetching the same server-anchored one.
    expect(existsSync(installIdPath())).toBe(true);
    expect(readFileSync(installIdPath(), "utf8").trim()).toBe(next);
    expect(getInstallId()).toBe(next);
  });

  it("rotating twice yields three distinct ids", () => {
    const a = getInstallId();
    const b = rotateInstallId().next;
    const c = rotateInstallId().next;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("rotating from nothing still produces an id", () => {
    rmSync(installIdPath(), { force: true });
    const { previous, next } = rotateInstallId();
    expect(previous).toBeNull();
    expect(next).toMatch(UUID_RE);
  });

  it("the endpoint is overridable for self-hosting", () => {
    const prev = process.env.CRAWLIO_TELEMETRY_URL;
    try {
      delete process.env.CRAWLIO_TELEMETRY_URL;
      expect(telemetryEndpoint()).toBe("https://worker.crawlio.app");
      process.env.CRAWLIO_TELEMETRY_URL = "https://example.test";
      expect(telemetryEndpoint()).toBe("https://example.test");
    } finally {
      if (prev === undefined) delete process.env.CRAWLIO_TELEMETRY_URL;
      else process.env.CRAWLIO_TELEMETRY_URL = prev;
    }
  });
});
