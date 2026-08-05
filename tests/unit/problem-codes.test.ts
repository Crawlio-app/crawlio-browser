import { describe, it, expect } from "vitest";
import { PROBLEM_CODES, isProblemCode } from "../../src/shared/protocol";
import { toolError, problemOf } from "../../src/mcp-server/tools";
import { MessageQueue } from "../../src/mcp-server/websocket-bridge";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("isProblemCode", () => {
  it("should accept every declared code", () => {
    for (const code of PROBLEM_CODES) expect(isProblemCode(code)).toBe(true);
  });

  it("should reject unknown strings and non-strings", () => {
    for (const value of ["nope", "", null, undefined, 42, {}]) {
      expect(isProblemCode(value)).toBe(false);
    }
  });

  it("should cover the extension's CDP classifications", () => {
    // background.ts classifyCDPError returns exactly these; they must round-trip on the wire.
    for (const code of ["disconnected", "target_closed", "target_crashed", "not_found",
      "invalid_param", "internal_error", "timeout", "unknown"]) {
      expect(isProblemCode(code)).toBe(true);
    }
  });
});

describe("problemOf", () => {
  it("should read a code the bridge attached to a rejected command", () => {
    expect(problemOf(Object.assign(new Error("gone"), { problem: "disconnected" }))).toBe("disconnected");
  });

  it("should ignore an unrecognized code rather than leaking it", () => {
    expect(problemOf(Object.assign(new Error("x"), { problem: "made_up" }))).toBeUndefined();
  });

  it("should return undefined for plain errors and non-objects", () => {
    expect(problemOf(new Error("plain"))).toBeUndefined();
    expect(problemOf("string error")).toBeUndefined();
    expect(problemOf(null)).toBeUndefined();
  });
});

describe("problem-code coverage in the extension", () => {
  // background.ts is a browser IIFE bundle and cannot be imported here, so assert over its
  // source. Refusals that return a response literal bypass the handleCommand catch — the
  // only place classifyProblem runs — so each one has to carry its own code or the
  // declared code is never actually emitted.
  const SOURCE = readFileSync(resolve(__dirname, "../../src/extension/background.ts"), "utf8");

  it("should tag every site-opt-out refusal", () => {
    const refusals = SOURCE.split("\n").filter(l => l.includes("error: OPT_OUT_ERROR"));
    expect(refusals.length).toBeGreaterThan(0);
    for (const line of refusals) {
      expect(line, line.trim()).toContain('problem: "opt_out"');
    }
  });

  it("should derive a code for anything thrown into the command catch", () => {
    expect(SOURCE).toContain("response.problem = classifyProblem(e, msg)");
  });

  it("should validate the CDP classification instead of casting it", () => {
    // The enums agree today, but an unchecked cast would put an undeclared code on the
    // wire the moment either side gains a member.
    expect(SOURCE).toContain("isProblemCode(classified) ? classified : \"unknown\"");
  });
});

describe("offline queue rejections", () => {
  it("should tag an expired queued message as not_connected", async () => {
    // This is the failure a user hits whenever the extension is closed, so the cause must
    // be machine-readable rather than something to infer from the message text.
    const queue = new MessageQueue();
    const pending = queue.enqueue("{}", 10);
    await expect(pending).rejects.toThrow(/expired/);
    await pending.catch((e: unknown) => {
      expect(problemOf(e)).toBe("not_connected");
    });
  });

  it("should tag an evicted message as not_connected when the queue overflows", async () => {
    const queue = new MessageQueue();
    const first = queue.enqueue("{}", 60_000);
    const evicted = first.catch((e: unknown) => e);
    // Fill past MAX_QUEUE_SIZE so the oldest is evicted.
    for (let i = 0; i < 1200; i++) void queue.enqueue("{}", 60_000).catch(() => {});
    const err = await evicted;
    expect((err as Error).message).toMatch(/overflow/i);
    expect(problemOf(err)).toBe("not_connected");
  });
});

describe("toolError", () => {
  it("should prefix the code so callers can branch without parsing prose", () => {
    const result = toolError("tab went away", "target_closed");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("[problem:target_closed] tab went away");
  });

  it("should leave the message untouched when there is no code", () => {
    expect(toolError("something broke").content[0].text).toBe("something broke");
  });
});
