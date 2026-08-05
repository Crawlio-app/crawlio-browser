import { describe, it, expect } from "vitest";
// Test manifest command definitions
import prodManifest from "../src/extension/manifest.prod.json";
import devManifest from "../src/extension/manifest.dev.json";

describe("keyboard-shortcuts", () => {
  describe("manifest commands", () => {
    it("prod manifest has commands section", () => {
      expect(prodManifest.commands).toBeDefined();
    });

    it("dev manifest has commands section", () => {
      expect(devManifest.commands).toBeDefined();
    });

    const expectedCommands = ["connect-tab", "capture-page", "take-screenshot", "toggle-recording"];

    it("prod manifest defines all 4 commands", () => {
      const commands = Object.keys(prodManifest.commands);
      for (const cmd of expectedCommands) {
        expect(commands).toContain(cmd);
      }
    });

    it("dev manifest defines all 4 commands", () => {
      const commands = Object.keys(devManifest.commands);
      for (const cmd of expectedCommands) {
        expect(commands).toContain(cmd);
      }
    });

    it("each command has a suggested_key with default binding", () => {
      for (const cmd of expectedCommands) {
        const entry = (prodManifest.commands as Record<string, { suggested_key?: { default?: string }; description?: string }>)[cmd];
        expect(entry.suggested_key).toBeDefined();
        expect(entry.suggested_key!.default).toBeTruthy();
      }
    });

    it("each command has a description", () => {
      for (const cmd of expectedCommands) {
        const entry = (prodManifest.commands as Record<string, { description?: string }>)[cmd];
        expect(entry.description).toBeTruthy();
      }
    });

    it("key bindings use Alt+Shift prefix", () => {
      for (const cmd of expectedCommands) {
        const entry = (prodManifest.commands as Record<string, { suggested_key?: { default?: string } }>)[cmd];
        expect(entry.suggested_key!.default).toMatch(/^Alt\+Shift\+/);
      }
    });

    it("prod and dev manifests have identical commands", () => {
      expect(prodManifest.commands).toEqual(devManifest.commands);
    });
  });
});
