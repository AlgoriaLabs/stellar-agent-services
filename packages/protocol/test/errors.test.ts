import { describe, expect, it } from "vitest";
import { JOB_FAILURES, jobError, problem, PROBLEMS, SPEC_URL } from "../src/index.js";
import { loadVectors } from "./support/vectors.js";

interface ProblemVectors {
  problems: Record<string, { status: number; retryAfter: boolean }>;
  jobFailures: string[];
}

const vectors = loadVectors<ProblemVectors>("problems.json");

describe("error codes: test-vectors/problems.json", () => {
  it("match the HTTP problem codes, statuses and Retry-After", () => {
    const codes = Object.fromEntries(
      Object.entries(PROBLEMS).map(([code, entry]) => [code, { status: entry.status, retryAfter: "retryAfter" in entry }]),
    );
    expect(codes).toEqual(vectors.problems);
  });

  it("match the job failure codes", () => {
    expect(Object.keys(JOB_FAILURES)).toEqual(vectors.jobFailures);
  });
});

describe("problem", () => {
  it("builds an RFC 9457 problem with a stable code", () => {
    const errors = [{ pointer: "/text", message: "must be a string" }];
    expect(problem("invalid_input", { errors })).toEqual({
      type: `${SPEC_URL}#error-invalid_input`,
      title: "Input does not match the service's inputSchema",
      status: 400,
      code: "invalid_input",
      errors,
    });
  });

  it("leaves out fields that were not given", () => {
    expect(Object.keys(problem("job_not_found"))).toEqual(["type", "title", "status", "code"]);
  });
});

describe("jobError", () => {
  it("has no HTTP status", () => {
    expect(jobError("timeout")).toEqual({ type: `${SPEC_URL}#error-timeout`, title: JOB_FAILURES.timeout.title, code: "timeout" });
    expect(jobError("service_failed", "upstream answered 500").detail).toBe("upstream answered 500");
  });
});
