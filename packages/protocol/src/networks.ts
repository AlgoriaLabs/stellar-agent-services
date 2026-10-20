// Network constants. The whole build runs on testnet first (IMPLEMENTATION_PLAN.md §4).

/** CAIP-2 ids of the Stellar networks the standard supports. */
export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";
export const STELLAR_NETWORKS: readonly StellarNetwork[] = ["stellar:testnet", "stellar:pubnet"];

/**
 * The USDC Stellar Asset Contract on each network, the only asset in v1 (provider-standard.md §4.1).
 * This package stays dependency-free, so these are copies: test/networks.test.ts pins them to
 * @x402/stellar (USDC_TESTNET_ADDRESS, USDC_PUBNET_ADDRESS) and to the manifest JSON Schema.
 */
export const USDC_ASSET: Readonly<Record<StellarNetwork, string>> = {
  "stellar:testnet": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
};

// TODO:
// - RPC, Horizon and USDC issuer per network.
// - 8004 contract ids come from @trionlabs/stellar8004 TESTNET_CONFIG / MAINNET_CONFIG, never
//   retyped.
