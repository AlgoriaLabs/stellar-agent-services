// Canonical JSON and hashing.
//
// Used for the job binding hash (service + input), manifest hashes and verification receipt
// hashes, so that key order or whitespace can never change a hash.
//
// TODO:
// - canonicalJson(value): full RFC 8785 (JCS), not a homemade subset, so other projects
//   (e.g. ERC-8126 on Stellar) produce the same hashes for shared Validation Registry documents.
// - sha256Hex(bytes | string), using Web Crypto so it works on Node, Workers and Deno.

export {};
