import { describe, it, expect } from "vitest";
import { MAX_EVAL_EXPRESSION_LENGTH } from "../../src/shared/protocol";
import { getForgePreludeJs } from "../../src/mcp-server/selector-kernel";
import { buildRobotTrainingMonitorJs } from "../../src/mcp-server/robot-training";

// Regression guard for the cap that silently killed pick_element and robot-training:
// both install themselves in ONE browser_evaluate, and the extension rejects any
// expression longer than MAX_EVAL_EXPRESSION_LENGTH.
describe("browser_evaluate expression budget", () => {
  it("should fit the selector-kernel prelude under the cap", () => {
    expect(getForgePreludeJs().length).toBeLessThan(MAX_EVAL_EXPRESSION_LENGTH);
  });

  it("should fit the robot-training monitor (prelude + monitor) under the cap", () => {
    expect(buildRobotTrainingMonitorJs().length).toBeLessThan(MAX_EVAL_EXPRESSION_LENGTH);
  });

  it("should keep the cap above the prelude with room for a caller's own program", () => {
    // The picker sends prelude + options + install body; leave real headroom so a
    // moderate growth in the kernel does not resurrect the bug.
    expect(MAX_EVAL_EXPRESSION_LENGTH - getForgePreludeJs().length).toBeGreaterThan(8000);
  });
});
