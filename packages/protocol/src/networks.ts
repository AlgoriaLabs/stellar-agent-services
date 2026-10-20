// Network constants. The whole build runs on testnet first (IMPLEMENTATION_PLAN.md §4).
//
// TODO:
// - CAIP-2 ids: "stellar:testnet", "stellar:pubnet".
// - RPC, Horizon and USDC issuer per network.
// - The USDC Stellar Asset Contract addresses come from @x402/stellar
//   (USDC_TESTNET_ADDRESS / USDC_PUBNET_ADDRESS). This package stays dependency-free, so any copy
//   kept here must be pinned by a test that compares it with @x402/stellar.
// - 8004 contract ids come from @trionlabs/stellar8004 TESTNET_CONFIG / MAINNET_CONFIG, never
//   retyped.

export {};
