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
    plugin?: string; claudePlugin?: string; lock?: string; lockRoot?: string; publicMirror?: boolean;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "crawlio-version-sync-"));
    mkdirSync(join(root, "src", "shared"), { recursive: true });
    mkdirSync(join(root, "src", "extension"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: versions.pkg }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({
      version: versions.lock ?? versions.pkg,
      packages: { "": { version: versions.lockRoot ?? versions.lock ?? versions.pkg } },
    }));
    writeFileSync(join(root, "src/shared/constants.ts"), `export const PKG_VERSION = "${versions.constants}";\n`);
    writeFileSync(join(root, "src/extension/manifest.prod.json"), JSON.stringify({ version: versions.prod }));
    writeFileSync(join(root, "src/extension/manifest.dev.json"), JSON.stringify({ version: versions.dev }));
    writeFileSync(join(root, "server.json"), JSON.stringify({ version: versions.server }));
    if (versions.dist !== undefined) {
      mkdirSync(join(root, "dist", "extension"), { recursive: true });
      writeFileSync(join(root, "dist/extension/manifest.json"), JSON.stringify({ version: versions.dist }));
    }
    if (!versions.publicMirror) {
      // The plugin manifests default to agreeing, so a test that says nothing about them is
      // testing the surface it named rather than tripping over one it did not. The private-only
      // exporter is the explicit context marker that keeps both manifests mandatory.
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts/export-oss.mjs"), "// private source marker\n");
      writeFileSync(join(root, "plugin.json"), JSON.stringify({ version: versions.plugin ?? versions.pkg }));
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ version: versions.claudePlugin ?? versions.pkg }));
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

  it("validates the seven versioned surfaces retained by the sanitized public mirror", () => {
    dir = fakeRepo({
      pkg: "1.11.0", constants: "1.11.0", prod: "1.11.0", dev: "1.11.0", server: "1.11.0",
      dist: "1.11.0", publicMirror: true,
    });
    const { code, output } = run(dir);
    expect(code).toBe(0);
    expect(output).toContain("all 7 surfaces at 1.11.0");
  });

  it("covers the plugin manifests, which drifted to 2.0.0 while nothing checked them", () => {
    // .claude-plugin/plugin.json sat at 2.0.0 against a 1.10.0 package for as long as it was
    // outside this gate — the same failure the gate exists for, one file over.
    dir = fakeRepo({
      pkg: "1.10.0", constants: "1.10.0", prod: "1.10.0", dev: "1.10.0", server: "1.10.0",
      dist: "1.10.0", plugin: "2.0.0", claudePlugin: "2.0.0",
    });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("plugin.json is 2.0.0, expected 1.10.0");
    expect(output).toContain(".claude-plugin/plugin.json is 2.0.0, expected 1.10.0");
  });

  it("rejects a stale package lock and disagreement between its two root version fields", () => {
    dir = fakeRepo({
      pkg: "1.11.0", constants: "1.11.0", prod: "1.11.0", dev: "1.11.0", server: "1.11.0",
      dist: "1.11.0", lock: "1.8.0", lockRoot: "1.7.1",
    });
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain("package-lock.json is unreadable");
    expect(output).toContain("top-level version 1.8.0 disagrees with packages[\"\"].version 1.7.1");
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
