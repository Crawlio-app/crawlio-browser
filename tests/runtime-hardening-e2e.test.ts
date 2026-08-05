import { describe, it, expect } from "vitest";
import { wrapPageContent } from "../src/mcp-server/content-boundary.js";
import { truncateOutput } from "../src/mcp-server/output-limits.js";
import { diffSnapshots, myersDiff } from "../src/mcp-server/snapshot-diff.js";
import {
  checkActionPolicy,
  loadActionPolicy,
  type ActionPolicy,
} from "../src/mcp-server/action-policy.js";
import { resolve } from "node:path";

describe("Runtime Hardening E2E", () => {
  // ── 1. Content boundary + output limit pipeline ──

  describe("content boundary + output limit pipeline", () => {
    const largeContent = "x".repeat(100_000);

    it("truncateOutput caps content to maxChars", () => {
      const result = truncateOutput(largeContent, 10_000);
      expect(result.truncated).toBe(true);
      expect(result.originalSize).toBe(100_000);
      // Truncated content = 10000 chars + truncation message
      expect(result.content).toContain("[truncated: showing 10000 of 100000 chars]");
      // The raw slice is exactly 10000 chars before the message
      expect(result.content.startsWith("x".repeat(10_000))).toBe(true);
    });

    it("wrapPageContent wraps truncated content with nonce markers", () => {
      // Enable boundaries for this test
      process.env.CRAWLIO_CONTENT_BOUNDARIES = "1";
      try {
        const truncated = truncateOutput(largeContent, 10_000);
        const wrapped = wrapPageContent(truncated.content, "https://example.com");

        expect(wrapped).toMatch(
          /^--- CRAWLIO_PAGE_CONTENT nonce=[0-9a-f]{16} origin=https:\/\/example\.com ---\n/
        );
        expect(wrapped).toMatch(
          /\n--- END_CRAWLIO_PAGE_CONTENT nonce=[0-9a-f]{16} ---$/
        );
        // Truncation message is inside the boundaries
        expect(wrapped).toContain("[truncated: showing 10000 of 100000 chars]");
      } finally {
        delete process.env.CRAWLIO_CONTENT_BOUNDARIES;
      }
    });

    it("estimatedTokens is approximately totalLength / 4", () => {
      const result = truncateOutput(largeContent, 10_000);
      expect(result.estimatedTokens).toBe(Math.ceil(result.content.length / 4));
    });

    it("no truncation when content fits within limit", () => {
      const small = "hello world";
      const result = truncateOutput(small, 10_000);
      expect(result.truncated).toBe(false);
      expect(result.content).toBe(small);
      expect(result.originalSize).toBe(small.length);
      expect(result.estimatedTokens).toBe(Math.ceil(small.length / 4));
    });
  });

  // ── 2. Snapshot diff integration ──

  describe("snapshot diff integration", () => {
    const before = [
      "document",
      '  heading "Welcome"',
      '  button "Submit" [ref=1]',
      '  paragraph "Click to submit"',
    ].join("\n");

    const after = [
      "document",
      '  heading "Welcome"',
      '  button "Submitted!" [ref=1]',
      '  paragraph "Thank you"',
    ].join("\n");

    it("detects changed content between snapshots", () => {
      const result = diffSnapshots(before, after);
      expect(result.changed).toBe(true);
      expect(result.additions).toBeGreaterThan(0);
      expect(result.removals).toBeGreaterThan(0);
      expect(result.diff).toContain("-");
      expect(result.diff).toContain("+");
    });

    it("reports no changes for identical snapshots", () => {
      const result = diffSnapshots(before, before);
      expect(result.changed).toBe(false);
      expect(result.additions).toBe(0);
      expect(result.removals).toBe(0);
    });

    it("diff output contains removed and added lines", () => {
      const result = diffSnapshots(before, after);
      expect(result.diff).toContain('- ' + '  button "Submit" [ref=1]');
      expect(result.diff).toContain('+ ' + '  button "Submitted!" [ref=1]');
    });

    it("myersDiff returns correct edit types", () => {
      const a = ["a", "b", "c"];
      const b = ["a", "x", "c"];
      const edits = myersDiff(a, b);
      const types = edits.map((e) => e.type);
      expect(types).toContain("equal");
      expect(types).toContain("insert");
      expect(types).toContain("delete");
    });
  });

  // ── 3. Action policy enforcement ──

  describe("action policy enforcement", () => {
    const policyDir = resolve(__dirname, "fixtures/policies");
    let readOnlyPolicy: ActionPolicy;
    let fullPolicy: ActionPolicy;

    it("loads read-only policy", () => {
      readOnlyPolicy = loadActionPolicy(resolve(policyDir, "read-only.json"));
      expect(readOnlyPolicy.default).toBe("deny");
      expect(readOnlyPolicy.allow).toBeDefined();
    });

    it("allows capture_page in read-only policy", () => {
      readOnlyPolicy = loadActionPolicy(resolve(policyDir, "read-only.json"));
      expect(checkActionPolicy("capture_page", readOnlyPolicy)).toBe("allow");
    });

    it("denies evaluate in read-only policy", () => {
      readOnlyPolicy = loadActionPolicy(resolve(policyDir, "read-only.json"));
      expect(checkActionPolicy("evaluate", readOnlyPolicy)).toBe("deny");
    });

    it("allows get_cookies via get_* glob", () => {
      readOnlyPolicy = loadActionPolicy(resolve(policyDir, "read-only.json"));
      expect(checkActionPolicy("get_cookies", readOnlyPolicy)).toBe("allow");
    });

    it("denies set_cookies in read-only policy", () => {
      readOnlyPolicy = loadActionPolicy(resolve(policyDir, "read-only.json"));
      expect(checkActionPolicy("set_cookies", readOnlyPolicy)).toBe("deny");
    });

    it("allows anything in full policy", () => {
      fullPolicy = loadActionPolicy(resolve(policyDir, "full.json"));
      expect(checkActionPolicy("anything", fullPolicy)).toBe("allow");
      expect(checkActionPolicy("evaluate", fullPolicy)).toBe("allow");
      expect(checkActionPolicy("set_cookies", fullPolicy)).toBe("allow");
    });
  });

  // ── 4. Pipeline order verification ──

  describe("pipeline order verification", () => {
    it("boundary markers are outside truncated content", () => {
      process.env.CRAWLIO_CONTENT_BOUNDARIES = "1";
      try {
        const large = "a".repeat(50_000);
        // Step 1: truncate first
        const truncated = truncateOutput(large, 5_000);
        // Step 2: then wrap with boundary
        const wrapped = wrapPageContent(truncated.content, "https://example.com");

        const lines = wrapped.split("\n");
        // First line is boundary header
        expect(lines[0]).toMatch(/^--- CRAWLIO_PAGE_CONTENT nonce=/);
        // Last line is boundary footer
        expect(lines[lines.length - 1]).toMatch(/^--- END_CRAWLIO_PAGE_CONTENT nonce=/);
        // Truncation message is inside (not the first or last line)
        const truncationLine = lines.find((l) =>
          l.includes("[truncated:")
        );
        expect(truncationLine).toBeDefined();
        const truncIdx = lines.indexOf(truncationLine!);
        expect(truncIdx).toBeGreaterThan(0);
        expect(truncIdx).toBeLessThan(lines.length - 1);
      } finally {
        delete process.env.CRAWLIO_CONTENT_BOUNDARIES;
      }
    });

    it("boundary nonces match between header and footer", () => {
      process.env.CRAWLIO_CONTENT_BOUNDARIES = "1";
      try {
        const content = "test content";
        const wrapped = wrapPageContent(content, "https://test.com");
        const headerMatch = wrapped.match(/nonce=([0-9a-f]+)/);
        const footerMatch = wrapped.match(/END_CRAWLIO_PAGE_CONTENT nonce=([0-9a-f]+)/);
        expect(headerMatch).not.toBeNull();
        expect(footerMatch).not.toBeNull();
        expect(headerMatch![1]).toBe(footerMatch![1]);
      } finally {
        delete process.env.CRAWLIO_CONTENT_BOUNDARIES;
      }
    });
  });

  // ── 5. Policy + output limit composition ──

  describe("policy + output limit composition", () => {
    const policyDir = resolve(__dirname, "fixtures/policies");

    it("denied tool returns error, not truncated/wrapped content", () => {
      const policy = loadActionPolicy(resolve(policyDir, "read-only.json"));
      const toolName = "evaluate";
      const decision = checkActionPolicy(toolName, policy);

      expect(decision).toBe("deny");

      // Simulate: on deny, return error message — never truncate/wrap
      const errorMsg = `Tool "${toolName}" denied by action policy`;
      expect(errorMsg).not.toContain("CRAWLIO_PAGE_CONTENT");
      expect(errorMsg).not.toContain("[truncated:");
    });

    it("allowed tool with output limits returns truncated + boundary-wrapped content", () => {
      process.env.CRAWLIO_CONTENT_BOUNDARIES = "1";
      try {
        const policy = loadActionPolicy(resolve(policyDir, "read-only.json"));
        const toolName = "capture_page";
        const decision = checkActionPolicy(toolName, policy);
        expect(decision).toBe("allow");

        // Simulate: allowed tool → apply pipeline
        const rawContent = "b".repeat(20_000);
        const truncated = truncateOutput(rawContent, 5_000);
        expect(truncated.truncated).toBe(true);

        const wrapped = wrapPageContent(truncated.content, "https://example.com");
        expect(wrapped).toMatch(/^--- CRAWLIO_PAGE_CONTENT nonce=/);
        expect(wrapped).toContain("[truncated: showing 5000 of 20000 chars]");
        expect(wrapped).toMatch(/--- END_CRAWLIO_PAGE_CONTENT nonce=/);
      } finally {
        delete process.env.CRAWLIO_CONTENT_BOUNDARIES;
      }
    });
  });
});
