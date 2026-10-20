// Canonical JSON (RFC 8785, JCS) and SHA-256.
//
// Used for the job binding hash (service + input), manifest hashes and verification receipt
// hashes, so that key order or whitespace can never change a hash. Other projects (e.g. ERC-8126 on
// Stellar) must produce the same bytes for shared Validation Registry documents, so this follows
// RFC 8785 exactly and is pinned by test-vectors/canonical-json.json.

/** A JSON value as JSON.parse produces it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

// With the `u` flag a valid surrogate pair is one code point, so this matches only lone surrogates.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Serializes a JSON value the RFC 8785 way: no whitespace, object keys sorted by UTF-16 code units,
 * ECMAScript number and string formatting.
 *
 * Throws on anything that is not I-JSON (RFC 7493): NaN, Infinity, lone surrogates, undefined,
 * functions, cycles, sparse arrays and non-plain objects.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

/** Lowercase hex SHA-256 of a string (as UTF-8) or of bytes. Uses Web Crypto: Node, Workers, Deno, Bun. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** sha256Hex(canonicalJson(value)): the hash used for binding hashes and shared documents. */
export function canonicalSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: NaN and Infinity are not JSON");
      // ECMAScript Number-to-String, as RFC 8785 §3.2.2.3 requires. -0 becomes "0".
      return JSON.stringify(value);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} is not JSON`);
  }

  if (ancestors.has(value)) throw new TypeError("canonicalJson: circular structure");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError("canonicalJson: sparse arrays are not JSON");
        items.push(serialize(value[i], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalJson: only plain objects and arrays are JSON");
    }
    const record = value as Record<string, unknown>;
    // The default sort compares UTF-16 code units, which is the order RFC 8785 §3.2.3 requires.
    const members = Object.keys(record)
      .sort()
      .map((key) => {
        const member = record[key];
        if (member === undefined) throw new TypeError(`canonicalJson: "${key}" is undefined`);
        return `${serializeString(key)}:${serialize(member, ancestors)}`;
      });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new TypeError("canonicalJson: string contains a lone surrogate");
  // JSON.stringify escapes exactly what RFC 8785 §3.2.2.2 requires and nothing more.
  return JSON.stringify(value);
}
