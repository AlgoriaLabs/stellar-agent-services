import { describe, it } from "vitest";

// Planned tests for the protocol package (IMPLEMENTATION_PLAN.md §7). The test vectors in this
// package are what implementations in other languages check themselves against.
describe("canonical JSON", () => {
  it.todo("produces the same hash regardless of key order and whitespace");
  it.todo("rejects NaN and Infinity");
  it.todo("matches the published test vectors (binding hash, receipt hash)");
});

describe("manifest", () => {
  it.todo("accepts a valid Provider Standard v1 manifest");
  it.todo("ignores unknown fields and rejects a different major version");
  it.todo("rejects a non-HTTPS or cross-origin baseUrl");
  it.todo("rejects fields over the size limits");
  it.todo("rejects a non-object inputSchema root and any non-local $ref");
  it.todo("requires exactly one payment option");
});

describe("challenge matching", () => {
  it.todo("accepts a challenge equal to the manifest option plus the service price");
  it.todo("rejects a challenge that differs in amount, payTo, asset, network, timeout or fee sponsorship");
});

describe("network constants", () => {
  it.todo("USDC asset addresses match @x402/stellar");
});
