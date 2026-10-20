// Publishes to the Stellar 8004 Validation Registry (testnet: TESTNET_CONFIG.contracts.validation).
// TODO:
// - Check get_validation_status(request_hash): the request exists and names this verifier.
// - validation_response(caller = verifier, request_hash, response = score 0–100,
//   response_uri = receipt URL, response_hash = sha256(receipt), tag = "provider-standard-v1").

export {};
