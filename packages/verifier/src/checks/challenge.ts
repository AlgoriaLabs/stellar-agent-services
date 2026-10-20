// C3 Challenge (no payment needed):
// - invalid input returns 400 invalid_input, not 402 [P8];
// - valid input returns 402 with an x402 v2 challenge whose single `accepts` entry equals the
//   manifest payment option plus the service price [P4], with the public create-job URL as
//   resource.url [P5];
// - a G... payTo has a USDC trustline [P2]; the Bazaar extension is present (warning only) [P6].
// TODO: record the decoded challenge as evidence.

export {};
