import { describe, expect, it } from "vitest";
import { isNewerWorkerGeneration, parseWorkerGeneration } from "../../src/shared/worker-generation.js";

describe("worker generation ordering", () => {
  it("parses bounded wire values and rejects malformed generations", () => {
    expect(parseWorkerGeneration({ id: "worker-b", startedAt: 20 })).toEqual({ id: "worker-b", startedAt: 20 });
    expect(parseWorkerGeneration({ id: "", startedAt: 20 })).toBeNull();
    expect(parseWorkerGeneration({ id: "worker", startedAt: Number.NaN })).toBeNull();
  });

  it("prefers a later start and converges equal-clock starts by id", () => {
    expect(isNewerWorkerGeneration({ id: "a", startedAt: 20 }, { id: "z", startedAt: 10 })).toBe(true);
    expect(isNewerWorkerGeneration({ id: "z", startedAt: 20 }, { id: "a", startedAt: 20 })).toBe(true);
    expect(isNewerWorkerGeneration({ id: "a", startedAt: 20 }, { id: "z", startedAt: 20 })).toBe(false);
    expect(isNewerWorkerGeneration(null, null)).toBe(false);
  });
});
