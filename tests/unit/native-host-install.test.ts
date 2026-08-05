import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const installScript = resolve(fileURLToPath(import.meta.url), "../../../bin/native-host/install.mjs");

/**
 * Regression for the macOS-TCC / ephemeral-npx bug: Chrome silently refuses to EXEC a
 * native-messaging host located under ~/Desktop, ~/Documents, or ~/Downloads (and an `npx`
 * package dir can be GC'd), so the host MUST be staged into a stable, non-TCC location and
 * the manifest must point THERE — never at the package's own bin/native-host.
 */
describe("native-host install — staging location (TCC / ephemeral-npx fix)", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = null; } });

  it("stages host + provision OUTSIDE the package dir and points the manifest at the staged wrapper", () => {
    dir = mkdtempSync(join(tmpdir(), "crawlio-nm-"));
    execFileSync(process.execPath, [installScript], { env: { ...process.env, CRAWLIO_NM_DIR: dir }, stdio: "pipe" });

    const manifest = JSON.parse(readFileSync(join(dir, "com.crawlio.agent.json"), "utf8"));
    const stagedWrapper = join(dir, "native-host", "crawlio-native-host");

    // manifest points at the STAGED wrapper, not the package's bin/native-host
    expect(manifest.path).toBe(stagedWrapper);
    expect(manifest.path).not.toContain("bin/native-host/crawlio-native-host");
    expect(existsSync(stagedWrapper)).toBe(true);
    expect(existsSync(join(dir, "native-host", "host.mjs"))).toBe(true);
    expect(existsSync(join(dir, "native-host", "provision.mjs"))).toBe(true);

    // the wrapper execs the STAGED host (not the package copy)
    expect(readFileSync(stagedWrapper, "utf8")).toContain(join(dir, "native-host", "host.mjs"));

    // store id still present, so Web Store installs are covered
    expect(manifest.allowed_origins.some((o: string) => o.includes("amkgjk"))).toBe(true);
  });
});
