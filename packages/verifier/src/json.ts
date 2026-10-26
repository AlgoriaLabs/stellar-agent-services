// JSON helpers for documents an untrusted provider sends.

import { canonicalJson } from "@stellar-agent-services/protocol";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
