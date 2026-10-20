import { describe, it } from "vitest";

// Planned tests for the protocol package (IMPLEMENTATION_PLAN.md §7).
describe("canonical JSON", () => {
  it.todo("produces the same hash regardless of key order and whitespace");
  it.todo("rejects NaN and Infinity");
});

describe("manifest", () => {
  it.todo("accepts a valid Provider Standard v1 manifest");
  it.todo("rejects non-HTTPS or cross-origin job URLs");
  it.todo("rejects fields over the discovery size limits");
});

describe("network constants", () => {
  it.todo("USDC asset addresses match @x402/stellar");
});
