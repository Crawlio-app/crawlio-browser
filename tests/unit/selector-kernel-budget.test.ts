import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MAX_EVAL_EXPRESSION_LENGTH } from "../../src/shared/protocol";
import { getForgePreludeJs } from "../../src/mcp-server/selector-kernel";
import { buildRobotTrainingMonitorJs } from "../../src/mcp-server/robot-training";

/**
 * pick_element and the robot-training monitor each install their in-page kernel in ONE
 * browser_evaluate. The prelude is ~17KB, and a 10,000-char cap in the extension rejected
 * it — so both features failed in every shipped build.
 *
 * The cap now lives in one shared constant, but "one constant" is only true until someone
 * adds a second check. These tests walk every layer an expression actually crosses.
 */
describe("selector-kernel install budget", () => {
  const prelude = getForgePreludeJs();
  const monitor = buildRobotTrainingMonitorJs();

  it("should have a prelude large enough that the old cap really did break it", () => {
    // Guards against the fix being "verified" by a prelude that shrank below 10K.
    expect(prelude.length).toBeGreaterThan(10_000);
  });

  it("should fit both installs under the shared cap", () => {
    expect(prelude.length).toBeLessThan(MAX_EVAL_EXPRESSION_LENGTH);
    expect(monitor.length).toBeLessThan(MAX_EVAL_EXPRESSION_LENGTH);
  });

  it("should pass the server-side bridge command schema", () => {
    // tools.ts validates outbound bridge commands against this shape.
    const schema = z.object({ expression: z.string().min(1).max(MAX_EVAL_EXPRESSION_LENGTH) });
    expect(() => schema.parse({ expression: prelude })).not.toThrow();
    expect(() => schema.parse({ expression: monitor })).not.toThrow();
  });

  it("should pass the extension's defense-in-depth command validator", () => {
    const MAX_EXPRESSION_LENGTH = 100_000; // background.ts validateCommand
    expect(prelude.length).toBeLessThan(MAX_EXPRESSION_LENGTH);
    expect(monitor.length).toBeLessThan(MAX_EXPRESSION_LENGTH);
  });

  it("should fit inside the WebSocket frame limit", () => {
    expect(monitor.length).toBeLessThan(10 * 1024 * 1024);
  });

  it("should leave headroom for a caller's own program on top of the prelude", () => {
    // pick_element sends prelude + options + install body as a single expression.
    expect(MAX_EVAL_EXPRESSION_LENGTH - prelude.length).toBeGreaterThan(8_000);
  });
});
