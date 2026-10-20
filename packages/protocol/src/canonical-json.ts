// Canonical JSON and hashing.
//
// Used for the job binding hash (serviceId + input), manifest hashes and verification receipt
// hashes, so that key order or whitespace can never change a hash.
//
// TODO:
// - canonicalJson(value): recursively sorted object keys, array order kept, and non-finite
//   numbers rejected (an RFC 8785 subset).
// - sha256Hex(bytes | string), using Web Crypto so it works on Node, Workers and Deno.

export {};
