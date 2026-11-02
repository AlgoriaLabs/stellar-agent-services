// JSON helpers for documents an untrusted provider sends.

import { canonicalJson } from "@stellar-agent-services/protocol";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The bytes of an application/json data: URI (RFC 2397), base64 or percent-encoded, such as an 8004
 * registration file or a validation request kept on chain. A problem instead when it is not one.
 */
export function jsonDataUri(uri: string): { bytes: Uint8Array } | { problem: "not-json" | "undecodable" } {
  const data = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(uri);
  if (data === null) return { problem: "not-json" };
  try {
    return { bytes: data[1] === undefined ? new TextEncoder().encode(decodeURIComponent(data[2]!)) : new Uint8Array(Buffer.from(data[2]!, "base64")) };
  } catch {
    return { problem: "undecodable" };
  }
}

/** Whether two JSON values are equal, member order aside. */
export function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/** One JSON Pointer (RFC 6901) segment. */
export function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * The JSON Pointer of the first member whose key repeats one before it in the same object, or undefined.
 * I-JSON forbids duplicate keys [M3], and JSON.parse keeps only the last one, so a manifest with two
 * `payTo` members could show one client a different payee than another. Call it on text JSON.parse
 * accepted. Keys are compared after unescaping, so "a" and "a" are the same key.
 */
export function duplicateKey(text: string): string | undefined {
  type Frame = { object: true; keys: Set<string>; pointer: string; key: string | undefined; expectKey: boolean } | { object: false; pointer: string; index: number };
  const stack: Frame[] = [];
  const childPointer = (): string => {
    const parent = stack.at(-1);
    if (parent === undefined) return "";
    return `${parent.pointer}/${pointerSegment(parent.object ? (parent.key ?? "") : parent.index)}`;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const top = stack.at(-1);
    switch (char) {
      case "{":
        stack.push({ object: true, keys: new Set(), pointer: childPointer(), key: undefined, expectKey: true });
        break;
      case "[":
        stack.push({ object: false, pointer: childPointer(), index: 0 });
        break;
      case "}":
      case "]":
        stack.pop();
        break;
      case ",":
        if (top?.object) top.expectKey = true;
        else if (top !== undefined) top.index++;
        break;
      case '"': {
        let end = i + 1;
        while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
        if (top?.object && top.expectKey) {
          const key = JSON.parse(text.slice(i, end + 1)) as string;
          if (top.keys.has(key)) return `${top.pointer}/${pointerSegment(key)}`;
          top.keys.add(key);
          top.key = key;
          top.expectKey = false;
        }
        i = end;
        break;
      }
      default:
        // Whitespace, ":", numbers and literals.
        break;
    }
  }
  return undefined;
}
