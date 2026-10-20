import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_PATTERN, JOB_TOKEN_PATTERN } from "../src/index.js";
import { loadVectors } from "./support/vectors.js";

interface HeaderFormat {
  pattern: string;
  valid: string[];
  invalid: string[];
}

const vectors = loadVectors<{ idempotencyKey: HeaderFormat; jobToken: HeaderFormat }>("headers.json");

describe.each([
  { header: "Idempotency-Key", format: vectors.idempotencyKey, pattern: IDEMPOTENCY_KEY_PATTERN },
  { header: "Job-Token", format: vectors.jobToken, pattern: JOB_TOKEN_PATTERN },
])("$header: test-vectors/headers.json", ({ format, pattern }) => {
  it("uses the published pattern", () => {
    expect(pattern.source).toBe(format.pattern);
  });

  it.each(format.valid)("accepts %j", (value) => {
    expect(pattern.test(value)).toBe(true);
  });

  it.each(format.invalid)("rejects %j", (value) => {
    expect(pattern.test(value)).toBe(false);
  });
});
