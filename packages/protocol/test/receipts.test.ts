import { describe, expect, it } from "vitest";
import { CONFORMANCE_LEVELS, CONFORMANCE_SCORES, conformanceLevel, type CheckId, type CheckResult } from "../src/index.js";

const ALL_CHECKS: CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6"];

function results(passed: CheckId[]): CheckResult[] {
  return ALL_CHECKS.map((check) => ({
    check,
    status: passed.includes(check) ? "passed" : "failed",
    failedRules: [],
  }));
}

describe("conformanceLevel", () => {
  it.each([
    { passed: [], level: 0 },
    { passed: ["C1"], level: 0 },
    { passed: ["C1", "C6"], level: 1 },
    { passed: ["C1", "C6", "C3"], level: 1 },
    { passed: ["C1", "C6", "C3", "C4"], level: 2 },
    { passed: ["C1", "C6", "C3", "C4", "C5"], level: 3 },
    { passed: ["C3", "C4", "C5"], level: 0 },
    { passed: ["C1", "C6", "C5"], level: 1 },
  ] as { passed: CheckId[]; level: number }[])("$passed -> level $level", ({ passed, level }) => {
    expect(conformanceLevel(results(passed))).toBe(level);
  });

  it("ignores C2, which only decides Registered", () => {
    expect(conformanceLevel(results(["C1", "C6", "C3", "C4", "C5", "C2"]))).toBe(3);
    expect(conformanceLevel(results(["C2"]))).toBe(0);
  });

  it("does not count skipped checks as passed", () => {
    const skipped = results(["C1", "C6", "C3"]).map((result) =>
      result.check === "C4" ? { ...result, status: "skipped" as const } : result,
    );
    expect(conformanceLevel(skipped)).toBe(1);
  });
});

describe("conformance levels", () => {
  it("each include the checks of the level below", () => {
    for (let i = 1; i < CONFORMANCE_LEVELS.length; i++) {
      expect(CONFORMANCE_LEVELS[i]?.checks).toEqual(expect.arrayContaining([...(CONFORMANCE_LEVELS[i - 1]?.checks ?? [])]));
    }
  });

  it("score 0 to 100, higher is better", () => {
    expect(Object.values(CONFORMANCE_SCORES)).toEqual([0, 33, 67, 100]);
  });
});
