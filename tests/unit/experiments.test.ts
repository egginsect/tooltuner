import { describe, expect, it } from "vitest";
import { expectedOutputCriterion } from "../../src/flywheel/experiments.js";

describe("deterministic comparison criterion", () => {
  it("compares canonical objects without treating tool success as a criterion pass", () => {
    expect(expectedOutputCriterion({ b: [1, 2], a: "text" }, { a: "text", b: [1, 2] })).toBe("pass");
    expect(expectedOutputCriterion({ outcome: "success", count: 2 }, { count: 3 })).toBe("fail");
    expect(expectedOutputCriterion({ count: "3" }, { count: 3 })).toBe("fail");
    expect(expectedOutputCriterion([1, 2], [2, 1])).toBe("fail");
  });
});
