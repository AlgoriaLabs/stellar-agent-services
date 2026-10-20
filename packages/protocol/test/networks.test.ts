import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2, USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { describe, expect, it } from "vitest";
import { STELLAR_NETWORKS, USDC_ASSET } from "../src/index.js";

describe("network constants", () => {
  it("match @x402/stellar", () => {
    expect(STELLAR_NETWORKS).toEqual([STELLAR_TESTNET_CAIP2, STELLAR_PUBNET_CAIP2]);
    expect(USDC_ASSET).toEqual({
      [STELLAR_TESTNET_CAIP2]: USDC_TESTNET_ADDRESS,
      [STELLAR_PUBNET_CAIP2]: USDC_PUBNET_ADDRESS,
    });
  });
});
