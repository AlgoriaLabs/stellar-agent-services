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

/** The USDC issuer on each network: USDC_ASSET is its Stellar Asset Contract. A G... payTo needs a trustline to it [P2]. */
export const USDC_ISSUER: Readonly<Record<StellarNetwork, string>> = {
  "stellar:testnet": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "stellar:pubnet": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

/** Public Horizon servers, for account reads such as the trustline check. */
export const HORIZON_URL: Readonly<Record<StellarNetwork, string>> = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
  "stellar:pubnet": "https://horizon.stellar.org",
};

/**
 * Public Soroban RPC servers, for settlement proofs [J16], reconciliation [J13] and the ledger clock.
 * SDF runs no public mainnet RPC, so pubnet has no default: pass your provider's URL.
 */
export const SOROBAN_RPC_URL: Readonly<Record<StellarNetwork, string | undefined>> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": undefined,
};

// TODO:
// - 8004 contract ids come from @trionlabs/stellar8004 TESTNET_CONFIG / MAINNET_CONFIG, never
//   retyped.
