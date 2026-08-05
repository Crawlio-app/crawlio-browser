import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadActionPolicy,
  checkActionPolicy,
  type ActionPolicy,
} from "../src/mcp-server/action-policy.js";

describe("action-policy", () => {
  describe("loadActionPolicy", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "action-policy-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should load a valid allow-default policy", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(policyPath, JSON.stringify({ default: "allow" }));
      const policy = loadActionPolicy(policyPath);
      expect(policy.default).toBe("allow");
    });

    it("should load a valid deny-default policy with allow list", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(
        policyPath,
        JSON.stringify({ default: "deny", allow: ["capture_page", "get_*"] })
      );
      const policy = loadActionPolicy(policyPath);
      expect(policy.default).toBe("deny");
      expect(policy.allow).toEqual(["capture_page", "get_*"]);
    });

    it("should load a policy with deny list", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(
        policyPath,
        JSON.stringify({ default: "allow", deny: ["execute", "browser_evaluate"] })
      );
      const policy = loadActionPolicy(policyPath);
      expect(policy.default).toBe("allow");
      expect(policy.deny).toEqual(["execute", "browser_evaluate"]);
    });

    it("should throw on invalid default value", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(policyPath, JSON.stringify({ default: "maybe" }));
      expect(() => loadActionPolicy(policyPath)).toThrow('must be "allow" or "deny"');
    });

    it("should throw on missing file", () => {
      expect(() =>
        loadActionPolicy(path.join(tempDir, "missing.json"))
      ).toThrow();
    });

    it("should throw on invalid JSON", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(policyPath, "not json");
      expect(() => loadActionPolicy(policyPath)).toThrow();
    });

    it("should throw on non-array allow field", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(
        policyPath,
        JSON.stringify({ default: "allow", allow: "not-array" })
      );
      expect(() => loadActionPolicy(policyPath)).toThrow("must be an array");
    });

    it("should throw on non-array deny field", () => {
      const policyPath = path.join(tempDir, "policy.json");
      fs.writeFileSync(
        policyPath,
        JSON.stringify({ default: "allow", deny: "not-array" })
      );
      expect(() => loadActionPolicy(policyPath)).toThrow("must be an array");
    });
  });

  describe("checkActionPolicy", () => {
    it("should allow all tools with default allow and no deny list", () => {
      const policy: ActionPolicy = { default: "allow" };
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
      expect(checkActionPolicy("execute", policy)).toBe("allow");
      expect(checkActionPolicy("browser_click", policy)).toBe("allow");
      expect(checkActionPolicy("unknown_tool", policy)).toBe("allow");
    });

    it("should deny all tools with default deny and no allow list", () => {
      const policy: ActionPolicy = { default: "deny" };
      expect(checkActionPolicy("capture_page", policy)).toBe("deny");
      expect(checkActionPolicy("execute", policy)).toBe("deny");
      expect(checkActionPolicy("browser_click", policy)).toBe("deny");
    });

    it("should allow tools in explicit allow list with default deny", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["capture_page", "list_tabs"],
      };
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
      expect(checkActionPolicy("list_tabs", policy)).toBe("allow");
      expect(checkActionPolicy("execute", policy)).toBe("deny");
    });

    it("should deny tools in explicit deny list with default allow", () => {
      const policy: ActionPolicy = {
        default: "allow",
        deny: ["execute", "browser_evaluate"],
      };
      expect(checkActionPolicy("execute", policy)).toBe("deny");
      expect(checkActionPolicy("browser_evaluate", policy)).toBe("deny");
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
    });

    it("should support glob matching with get_* pattern", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["get_*"],
      };
      expect(checkActionPolicy("get_cookies", policy)).toBe("allow");
      expect(checkActionPolicy("get_storage", policy)).toBe("allow");
      expect(checkActionPolicy("get_console_logs", policy)).toBe("allow");
      expect(checkActionPolicy("get_dom_snapshot", policy)).toBe("allow");
      expect(checkActionPolicy("get_response_body", policy)).toBe("allow");
      expect(checkActionPolicy("capture_page", policy)).toBe("deny");
    });

    it("should support glob matching with browser_* pattern", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["browser_*"],
      };
      expect(checkActionPolicy("browser_click", policy)).toBe("allow");
      expect(checkActionPolicy("browser_type", policy)).toBe("allow");
      expect(checkActionPolicy("browser_navigate", policy)).toBe("allow");
      expect(checkActionPolicy("browser_snapshot", policy)).toBe("allow");
      expect(checkActionPolicy("capture_page", policy)).toBe("deny");
    });

    it("should support glob matching with detect_* pattern", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["detect_*"],
      };
      expect(checkActionPolicy("detect_framework", policy)).toBe("allow");
      expect(checkActionPolicy("detect_tables", policy)).toBe("allow");
      expect(checkActionPolicy("capture_page", policy)).toBe("deny");
    });

    it("should support glob matching with extract_* pattern", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["extract_*"],
      };
      expect(checkActionPolicy("extract_table", policy)).toBe("allow");
      expect(checkActionPolicy("extract_data", policy)).toBe("allow");
      expect(checkActionPolicy("extract_site", policy)).toBe("allow");
      expect(checkActionPolicy("capture_page", policy)).toBe("deny");
    });

    it("should match glob in deny list", () => {
      const policy: ActionPolicy = {
        default: "allow",
        deny: ["browser_*"],
      };
      expect(checkActionPolicy("browser_click", policy)).toBe("deny");
      expect(checkActionPolicy("browser_navigate", policy)).toBe("deny");
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
    });

    it("should prioritize explicit deny over explicit allow", () => {
      const policy: ActionPolicy = {
        default: "allow",
        allow: ["execute"],
        deny: ["execute"],
      };
      // deny checked first, so deny wins
      expect(checkActionPolicy("execute", policy)).toBe("deny");
    });

    it("should prioritize explicit deny glob over explicit allow glob", () => {
      const policy: ActionPolicy = {
        default: "allow",
        allow: ["browser_*"],
        deny: ["browser_evaluate"],
      };
      // Explicit deny of browser_evaluate overrides browser_* allow
      expect(checkActionPolicy("browser_evaluate", policy)).toBe("deny");
      expect(checkActionPolicy("browser_click", policy)).toBe("allow");
    });

    it("should handle empty allow and deny lists", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: [],
        deny: [],
      };
      expect(checkActionPolicy("capture_page", policy)).toBe("deny");
    });

    it("should not match partial tool names without glob", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["get"],
      };
      // "get" should NOT match "get_cookies" — no glob
      expect(checkActionPolicy("get_cookies", policy)).toBe("deny");
      expect(checkActionPolicy("get", policy)).toBe("allow");
    });

    it("should match wildcard-only pattern", () => {
      const policy: ActionPolicy = {
        default: "deny",
        allow: ["*"],
      };
      // "*" = starts with "" = matches everything
      expect(checkActionPolicy("anything", policy)).toBe("allow");
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
    });
  });

  describe("sample policy files", () => {
    const policiesDir = path.resolve(__dirname, "fixtures/policies");

    it("should load read-only.json", () => {
      const policy = loadActionPolicy(path.join(policiesDir, "read-only.json"));
      expect(policy.default).toBe("deny");
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
      expect(checkActionPolicy("get_cookies", policy)).toBe("allow");
      expect(checkActionPolicy("detect_framework", policy)).toBe("allow");
      expect(checkActionPolicy("browser_snapshot", policy)).toBe("allow");
      expect(checkActionPolicy("browser_click", policy)).toBe("deny");
      expect(checkActionPolicy("execute", policy)).toBe("deny");
      expect(checkActionPolicy("set_cookie", policy)).toBe("deny");
    });

    it("should load interactive.json", () => {
      const policy = loadActionPolicy(path.join(policiesDir, "interactive.json"));
      expect(policy.default).toBe("deny");
      expect(checkActionPolicy("browser_click", policy)).toBe("allow");
      expect(checkActionPolicy("browser_type", policy)).toBe("allow");
      expect(checkActionPolicy("execute", policy)).toBe("allow");
      expect(checkActionPolicy("capture_page", policy)).toBe("allow");
      expect(checkActionPolicy("set_cookie", policy)).toBe("deny");
      expect(checkActionPolicy("set_viewport", policy)).toBe("deny");
    });

    it("should load full.json", () => {
      const policy = loadActionPolicy(path.join(policiesDir, "full.json"));
      expect(policy.default).toBe("allow");
      expect(checkActionPolicy("anything", policy)).toBe("allow");
      expect(checkActionPolicy("execute", policy)).toBe("allow");
      expect(checkActionPolicy("set_cookie", policy)).toBe("allow");
    });
  });
});
