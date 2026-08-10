import { describe, it, expect, vi } from "vitest";
import { createCodeModeTools } from "@/mcp-server/tools";

/**
 * Errors from a bridge call cross three boundaries before reaching the caller: the host
 * serializes them into an envelope, the worker's decode turns that envelope back into a
 * thrown Error, and postError carries a failure back out of the worker. The structured
 * fields were originally written into the envelope and dropped at every subsequent hop, so
 * code inside execute() could never tell a permission denial from any other failure and the
 * permission-denial branch in the execute handler was unreachable.
 *
 * These run the real worker rather than asserting over source, because "the fields are
 * written" was already true when the feature was broken.
 */
function bridgeThatRejects(error: Error) {
  const send = vi.fn(async (msg: { type: string }) => {
    if (msg.type === "get_connection_status") return { connectedTab: { url: "" } };
    if (msg.type === "browser_evaluate") throw error;
    return { ok: true };
  });
  return { send, isConnected: true, push: vi.fn() };
}

async function runCode(bridge: ReturnType<typeof bridgeThatRejects>, code: string) {
  const tools = await createCodeModeTools(bridge as never, undefined as never);
  const execute = tools.find(t => t.name === "execute")!;
  const result = await execute.handler({ code });
  return { isError: result.isError === true, text: String(result.content[0].text) };
}

describe("structured error fields across the sandbox boundary", () => {
  it("should let code inside execute() read the problem code", async () => {
    const bridge = bridgeThatRejects(
      Object.assign(new Error("tab went away"), { problem: "target_closed" })
    );
    const { text } = await runCode(bridge, `
      try {
        await bridge.send({ type: "browser_evaluate", expression: "1" });
        return { caught: false };
      } catch (err) {
        return { caught: true, problem: err.problem, message: err.message };
      }
    `);
    // Assert on the returned object, not just the presence of the word: the same string
    // would appear if the call had failed outright and been rendered by toolError, which
    // would prove nothing about what the sandboxed code could see.
    expect(text).toContain("\"caught\":true");
    expect(text).toContain("\"problem\":\"target_closed\"");
    expect(text).toContain("tab went away");
  }, 30_000);

  it("should let code inside execute() see a permission denial as such", async () => {
    // This is what makes the permission-denial branch in the execute handler reachable.
    const bridge = bridgeThatRejects(Object.assign(new Error("permission required"), {
      permission_required: true,
      missing: { permissions: ["tabs"] },
      suggestion: "Grant browser access from Crawlio's dedicated onboarding page.",
    }));
    const { text } = await runCode(bridge, `
      try {
        await bridge.send({ type: "browser_evaluate", expression: "1" });
        return { caught: false };
      } catch (err) {
        return { caught: true, denied: err.permission_required === true, missing: err.missing };
      }
    `);
    expect(text).toContain("\"denied\":true");
    expect(text).toContain("tabs");
  }, 30_000);

  it("should surface the problem code to the tool caller when the error escapes", async () => {
    const bridge = bridgeThatRejects(
      Object.assign(new Error("extension not connected"), { problem: "not_connected" })
    );
    const { isError, text } = await runCode(bridge, `
      await bridge.send({ type: "browser_evaluate", expression: "1" });
      return "unreachable";
    `);
    expect(isError).toBe(true);
    expect(text).toContain("not_connected");
  }, 30_000);

  it("should not invent a code for an error that has none", async () => {
    const bridge = bridgeThatRejects(new Error("something ordinary broke"));
    const { isError, text } = await runCode(bridge, `
      await bridge.send({ type: "browser_evaluate", expression: "1" });
      return "unreachable";
    `);
    expect(isError).toBe(true);
    expect(text).toContain("something ordinary broke");
    expect(text).not.toMatch(/\[problem:/);
  }, 30_000);
});
