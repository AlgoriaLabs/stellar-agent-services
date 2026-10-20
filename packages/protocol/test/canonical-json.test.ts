import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256, sha256Hex } from "../src/index.js";
import { loadVectors } from "./support/vectors.js";

interface CanonicalJsonVectors {
  cases: { name: string; json: string; canonical: string; sha256: string }[];
  numbers: { ieee754: string; canonical: string }[];
  invalid: { name: string; json?: string; ieee754?: string }[];
}

const vectors = loadVectors<CanonicalJsonVectors>("canonical-json.json");
const fromBits = (hex: string) => new DataView(Uint8Array.from(Buffer.from(hex, "hex")).buffer).getFloat64(0);

describe("canonicalJson: test-vectors/canonical-json.json", () => {
  it.each(vectors.cases)("$name", async ({ json, canonical, sha256 }) => {
    const value: unknown = JSON.parse(json);
    expect(canonicalJson(value)).toBe(canonical);
    expect(await canonicalSha256(value)).toBe(sha256);
  });

  it.each(vectors.numbers)("number with bits $ieee754 is $canonical", ({ ieee754, canonical }) => {
    expect(canonicalJson(fromBits(ieee754))).toBe(canonical);
  });

  it.each(vectors.invalid)("rejects $name", ({ json, ieee754 }) => {
    const value: unknown = json !== undefined ? JSON.parse(json) : fromBits(ieee754 ?? "");
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("canonicalJson", () => {
  it("rejects values that are not JSON", () => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    for (const value of [undefined, () => 1, Symbol("s"), 1n, new Date(0), new Map(), { a: undefined }, sparse]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
  });

  it("rejects cycles but accepts a shared object", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);

    const shared = { x: 1 };
    expect(canonicalJson({ b: shared, a: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("accepts objects without a prototype", () => {
    const value = Object.assign(Object.create(null) as Record<string, number>, { b: 1, a: 2 });
    expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
  });
});

describe("sha256Hex", () => {
  it("hashes the UTF-8 bytes of a string, or raw bytes", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
