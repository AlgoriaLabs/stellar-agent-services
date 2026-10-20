import { describe, it } from "vitest";

// Payment-safety tests that must exist before the pilot (IMPLEMENTATION_PLAN.md §7).
describe("payment safety", () => {
  it.todo("repeated create-job with the same key and input returns the same job without a second charge");
  it.todo("the same key with a different input returns 409");
  it.todo("a wrong job token returns 404");
  it.todo("one signed payment cannot pay for two jobs (fingerprint)");
  it.todo("a facilitator timeout or 5xx becomes payment_uncertain, never failed");
  it.todo("a handler failure in after-work mode settles nothing");
  it.todo("the challenge always matches the manifest's price, asset, payTo and network");
});
