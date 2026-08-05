import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  files: string[]; license: string; version: string;
};

/**
 * What ships on npm is governed by the `files` allowlist, and omissions are invisible until
 * a user hits them. Apache-2.0 §4(d) requires redistributions to carry the NOTICE file;
 * npm auto-includes LICENSE but nothing else, so NOTICE shipped missing until this was
 * caught by inspecting an actual `npm pack` listing.
 */
describe("published package contents", () => {
  it("should ship the Apache NOTICE and third-party attributions", () => {
    expect(pkg.files).toContain("NOTICE");
    expect(pkg.files).toContain("THIRD_PARTY_NOTICES.md");
  });

  it("should ship the MIT license of the separately-licensed selector package", () => {
    // packages/selectors is MIT because it ports MIT and BSD-3 code; its LICENSE carries
    // those attributions and must travel with the dist output that is published.
    expect(pkg.files).toContain("packages/selectors/LICENSE");
    expect(pkg.files.some(f => f.startsWith("packages/selectors/dist"))).toBe(true);
  });

  it("should declare Apache-2.0 and ship a matching LICENSE", () => {
    expect(pkg.license).toBe("Apache-2.0");
    const license = readFileSync(resolve(ROOT, "LICENSE"), "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
  });

  it("should ship everything the CLI needs at runtime", () => {
    // A missing entry here does not fail any build — it fails on a user's machine.
    for (const required of [
      "bin/crawlio-browser.js",
      "dist/mcp-server/",
      "server.json",
      "skills/",
      "packages/semantic-grounding/dist/",
    ]) {
      expect(pkg.files, `${required} missing from files allowlist`).toContain(required);
    }
  });

  it("should rebuild every dist directory the allowlist ships, before publishing", () => {
    // A shipped dist/ that the publish path does not rebuild goes out stale — which already
    // happened once: the server bundle published as 1.7.1 while everything else said 1.8.0.
    // packages/semantic-grounding has no build script of its own and no prepare hook, so
    // nothing else would ever produce its output on a fresh clone.
    const prepublish = (pkg as unknown as { scripts: Record<string, string> }).scripts.prepublishOnly;
    const shippedDists = pkg.files.filter(f => f.includes("dist"));
    expect(shippedDists.length).toBeGreaterThan(0);

    const builds: Record<string, string> = {
      "dist/mcp-server/": "build:server",
      "packages/selectors/dist/": "build:selectors",
      "packages/semantic-grounding/dist/": "build:semantic-grounding",
    };
    for (const dist of shippedDists) {
      const script = builds[dist];
      expect(script, `no known build script for shipped ${dist}`).toBeTruthy();
      expect(prepublish, `prepublishOnly does not run ${script} for ${dist}`).toContain(script);
    }
  });

  it("should verify versions and run the suite before publishing", () => {
    const prepublish = (pkg as unknown as { scripts: Record<string, string> }).scripts.prepublishOnly;
    expect(prepublish).toContain("check:versions");
    expect(prepublish).toContain("typecheck");
    expect(prepublish).toContain("test");
  });

  it("should not ship internal tooling or private tests", () => {
    const forbidden = ["docs", ".claude", ".crawlio", "tests/private", "scripts/export-oss.mjs"];
    for (const entry of pkg.files) {
      for (const bad of forbidden) {
        expect(entry.startsWith(bad), `${entry} would publish ${bad}`).toBe(false);
      }
    }
  });
});
