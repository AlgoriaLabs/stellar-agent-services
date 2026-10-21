import { describe, expect, it } from "vitest";
import {
  bindingHash,
  canonicalJson,
  canTransition,
  chargedFor,
  createJobUrl,
  JOB_STATUSES,
  jobResultUrl,
  jobStatusUrl,
  jobViewHttpStatus,
  type Charge,
  type Charged,
  type JobFailureCode,
  type JobStatus,
} from "../src/index.js";
import { loadVectors } from "./support/vectors.js";

interface BindingHashVectors {
  cases: { name: string; service: string; input: unknown; canonical: string; bindingHash: string }[];
}

interface JobStateVectors {
  transitions: Record<Charge, Record<JobStatus | "(new)", JobStatus[]>>;
  charged: { status: JobStatus; charge: Charge; failureCode?: JobFailureCode; charged: Charged }[];
}

const vectors = loadVectors<BindingHashVectors>("binding-hash.json");
const states = loadVectors<JobStateVectors>("job-states.json");

describe("job states: test-vectors/job-states.json", () => {
  const charges: Charge[] = ["upfront", "on-success"];
  const pairs = charges.flatMap((charge) =>
    [undefined, ...JOB_STATUSES].flatMap((from) => JOB_STATUSES.map((to) => ({ charge, from, to }))),
  );

  it.each(pairs)("$charge: $from -> $to", ({ charge, from, to }) => {
    const allowed = states.transitions[charge][from ?? "(new)"].includes(to);
    expect(canTransition(from, to, charge)).toBe(allowed);
  });

  it.each(states.charged)("charged for $status, $charge, $failureCode", ({ status, charge, failureCode, charged }) => {
    expect(chargedFor(status, charge, failureCode)).toBe(charged);
  });

  it("answers 200 only for final states", () => {
    expect(JOB_STATUSES.map(jobViewHttpStatus)).toEqual([202, 202, 200, 200, 202]);
  });
});

describe("bindingHash: test-vectors/binding-hash.json", () => {
  it.each(vectors.cases)("$name", async ({ service, input, canonical, bindingHash: expected }) => {
    expect(canonicalJson({ service, input })).toBe(canonical);
    expect(await bindingHash(service, input)).toBe(expected);
  });
});

describe("job URLs", () => {
  const baseUrl = "https://api.example.com/agent";
  const jobId = "0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d";

  it("are fixed paths under baseUrl", () => {
    expect(createJobUrl(baseUrl, "text-stats")).toBe("https://api.example.com/agent/services/text-stats/jobs");
    expect(jobStatusUrl(baseUrl, jobId)).toBe(`https://api.example.com/agent/jobs/${jobId}`);
    expect(jobResultUrl(baseUrl, jobId)).toBe(`https://api.example.com/agent/jobs/${jobId}/result`);
  });

  it("refuse names and ids that would change the path", () => {
    expect(() => createJobUrl(baseUrl, "../admin")).toThrow(TypeError);
    expect(() => jobStatusUrl(baseUrl, "../../admin")).toThrow(TypeError);
    expect(() => jobResultUrl(baseUrl, jobId.toUpperCase())).toThrow(TypeError);
  });
});
