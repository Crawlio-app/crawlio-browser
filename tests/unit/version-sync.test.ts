import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkScript = resolve(fileURLToPath(import.meta.url), "../../../scripts/check-version-sync.mjs");

/**
 * crawlio-browser@1.7.0 was published and then deprecated ("version bump was
 * premature, extension stays at 1.6.1"), and 1.7.1 repeated it — shipping with
 * manifest.prod.json at 1.7.0 and manifest.dev.json at 1.6.5 — because the
 * four-version rule lived only in a skill doc a human had to read. These tests
 * pin the executable gate that now runs in prepublishOnly.
 */
describe("check-version-sync — publish gate", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      dir = null;
    }
  });

  function fakeRepo(versions: {
    pkg: string; constants: string; prod: string; dev: string; server: string; dist?: string;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "crawlio-version-sync-"));
    mkdirSync(join(root, "src", "shared"), { recursive: true });
    mkdirSync(join(root, "src", "extension"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: versions.pkg }));
    writeFileSync(join(root, "src/shared/constants.ts"), `export const PKG_VERSION = "${versions.constants}";\n`);
    writeFileSync(join(root, "src/extension/manifest.prod.json"), JSON.stringify({ version: versions.prod }));
    writeFileSync(join(root, "src/extension/manifest.dev.json"), JSON.stringify({ version: versions.dev }));
    writeFileSync(join(root, "server.json"), JSON.stringify({ version: versions.server }));
    if (versions.dist !== undefined) {
      mkdirSync(join(root, "dist", "extension"), { recursive: true });
      writeFileSync(join(root, "dist/extension/manifest.json"), JSON.stringify({ version: versions.dist }));
    }
    return root;
  }

  function run(root: string): { code: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [checkScript], {
        env: { ...process.env, CRAWLIO_VERSION_CHECK_ROOT: root },
        encoding: "utf8",
        stdio: "pipe",
      });
      return { code: 0, output: stdout };
    } catch (error) {
      const err = error as { status?: number; stderr?: string; stdout?: string };
      return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  it("passes when every surface agrees", () => {
    dir = fakeRepo({ pkg: "1.7.1", constants: "1.7.1", prod: "1.7.1", dev: "1.7.1", server: "1.7.1", dist: "1.7.1" });
    const { code, output } = run(dir);
    expect(code).toBe(0);
    expect(output).toContain("version sync OK");
  });

  it("fails on the exact drift that shipped in 1.7.1", () => {
    dir = fakeRepo({ pkg: "1.7.1", constants: "1.7.1", prod: "1.7.0", dev: "1.6.5", server: "1.7.1", dist: "1.6.6" });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("manifest.prod.json is 1.7.0, expected 1.7.1");
    expect(output).toContain("manifest.dev.json is 1.6.5, expected 1.7.1");
    expect(output).toContain("dist/extension/manifest.json is 1.6.6, expected 1.7.1");
  });

  it("fails when the extension was never rebuilt, so a stale build cannot ship silently", () => {
    dir = fakeRepo({ pkg: "1.7.2", constants: "1.7.2", prod: "1.7.2", dev: "1.7.2", server: "1.7.2" });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("dist/extension/manifest.json is missing");
    expect(output).toContain("npm run build:extension");
  });

  it("catches a drifting PKG_VERSION constant", () => {
    dir = fakeRepo({ pkg: "1.8.0", constants: "1.7.1", prod: "1.8.0", dev: "1.8.0", server: "1.8.0", dist: "1.8.0" });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("constants.ts is 1.7.1, expected 1.8.0");
  });
});
