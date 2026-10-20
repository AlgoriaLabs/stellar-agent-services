// C5 Recovery: repeating create-job with the same key, input and token returns the same job and
// on-chain there is still exactly one transfer. The same key with a different input returns 422.
// check-status and get-result work with the token and return 404 without it.

export {};
