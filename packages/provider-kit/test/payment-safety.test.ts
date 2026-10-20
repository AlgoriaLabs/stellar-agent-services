import { describe, it } from "vitest";

// Payment-safety tests that must exist before the pilot (IMPLEMENTATION_PLAN.md §7).
describe("payment safety", () => {
  it.todo("repeated create-job with the same key and input returns the same job without a second charge");
  it.todo("the same key with a different input or token returns 422");
  it.todo("a request for a job still being claimed or settled returns 409");
  it.todo("invalid input returns 400 before any 402");
  it.todo("a wrong job token returns 404");
  it.todo("one signed payment cannot pay for two jobs (fingerprint)");
  it.todo("a facilitator timeout or 5xx becomes payment_uncertain, never failed");
  it.todo("an on-success handler failure or invalid output settles nothing");
  it.todo("on-success work that outlasts the payment authorization fails the job without a charge");
  it.todo("the challenge always equals the manifest payment option plus the service price");
  it.todo("a client without Idempotency-Key and Job-Token gets a provider-generated job id and token");
});
