// Helpers for reading test-vectors/*.json the way any implementation would: plain JSON.parse plus
// the RFC 6902 subset (add, replace, remove) the vector files use for their patches.

import { readFileSync } from "node:fs";

export function loadVectors<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test-vectors/${name}`, import.meta.url), "utf8")) as T;
}

export interface PatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export function applyPatch<T>(document: T, operations: PatchOperation[]): T {
  const result = structuredClone(document);
  for (const { op, path, value } of operations) {
    const segments = path
      .split("/")
      .slice(1)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
    const last = segments.pop();
    if (last === undefined) throw new Error(`cannot patch the document root: ${path}`);
    let parent: any = result;
    for (const segment of segments) parent = parent[segment];
    if (Array.isArray(parent)) {
      const index = last === "-" ? parent.length : Number(last);
      if (op === "add") parent.splice(index, 0, structuredClone(value));
      else if (op === "replace") parent[index] = structuredClone(value);
      else parent.splice(index, 1);
    } else if (op === "remove") {
      delete parent[last];
    } else {
      parent[last] = structuredClone(value);
    }
  }
  return result;
}

/** Rule violations without messages, in a stable order, for comparing with a vector's `violations`. */
export function ruleIds(violations: { rule: string; pointer: string }[]): { rule: string; pointer: string }[] {
  return violations
    .map(({ rule, pointer }) => ({ rule, pointer }))
    .sort((a, b) => `${a.pointer} ${a.rule}`.localeCompare(`${b.pointer} ${b.rule}`));
}
