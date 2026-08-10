import { describe, expect, it } from "vitest";
import {
  buildResidentTrainingMonitorScript,
  RESIDENT_TRAINING_BINDING,
} from "@/extension/injected/resident-training-monitor";

describe("resident training page monitor", () => {
  it("is event-driven, navigation-installable, and has no page polling loop", () => {
    const source = buildResidentTrainingMonitorScript(false);
    expect(source).toContain(RESIDENT_TRAINING_BINDING);
    expect(source).toContain('addEventListener("click"');
    expect(source).toContain('addEventListener("input"');
    expect(source).toContain('addEventListener("submit"');
    expect(source).not.toContain("setInterval(");
  });

  it("redacts sensitive fields and retains storage keys without values by default", () => {
    const source = buildResidentTrainingMonitorScript(false);
    expect(source).toContain('[REDACTED]');
    expect(source).toContain("captureStorageValues && !sensitiveName.test(key)");
    expect(source).toMatch(/input\.type === ["']password["']/);
    expect(source.endsWith(", false)")).toBe(true);
  });

  it("makes storage-value capture an explicit source-level opt-in", () => {
    expect(buildResidentTrainingMonitorScript(true).endsWith(", true)")).toBe(true);
  });
});
