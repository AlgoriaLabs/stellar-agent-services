// The documents the server reads, and the spec's rules.
//
// llms.txt at the repository root is the index: only the files it links to can be read or searched, so a
// tool call can't reach anything else on disk. Rules are the `- **[ID]**` bullets of
// docs/provider-standard.md, each with the section it belongs to.

import { readFileSync } from "node:fs";

const RAW = "https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/";
const SPEC = "docs/provider-standard.md";
const RULE = /^- \*\*\[([A-Z]\d+)\]\*\*\s*(.*)$/;

export interface DocEntry {
  /** Repository path, such as docs/provider-standard.md. */
  path: string;
  title: string;
  summary: string;
  /** The llms.txt section, such as "Build a provider". */
  section: string;
}

export interface SpecRule {
  id: string;
  /** The heading the rule is under, such as "5.4 Processing order". */
  section: string;
  text: string;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export class Docs {
  readonly index: string;
  readonly entries: DocEntry[];
  private rules: Map<string, SpecRule> | undefined;

  constructor(private readonly root: URL) {
    this.index = readFileSync(new URL("llms.txt", root), "utf8");
    this.entries = parseIndex(this.index);
  }

  /** The entry for a repository path or its raw GitHub URL, when llms.txt lists it. */
  entry(pathOrUrl: string): DocEntry | undefined {
    const path = (pathOrUrl.startsWith(RAW) ? pathOrUrl.slice(RAW.length) : pathOrUrl).replace(/^\.?\//, "");
    return this.entries.find((entry) => entry.path === path);
  }

  read(entry: DocEntry): string {
    return readFileSync(new URL(entry.path, this.root), "utf8");
  }

  /** Lines containing every term of the query, case-insensitive, in llms.txt order. */
  search(query: string, limit: number): SearchHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];
    if (terms.length === 0) return hits;
    for (const entry of this.entries) {
      const lines = this.read(entry).split("\n");
      for (const [index, text] of lines.entries()) {
        const lower = text.toLowerCase();
        if (!terms.every((term) => lower.includes(term))) continue;
        hits.push({ path: entry.path, line: index + 1, text: text.trim() });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /** A spec rule by id: "J13", "[J13]" or "j13". */
  rule(id: string): SpecRule | undefined {
    this.rules ??= parseRules(readFileSync(new URL(SPEC, this.root), "utf8"));
    return this.rules.get(id.replace(/[[\]\s]/g, "").toUpperCase());
  }

  ruleIds(): string[] {
    this.rules ??= parseRules(readFileSync(new URL(SPEC, this.root), "utf8"));
    return [...this.rules.keys()];
  }
}

function parseIndex(index: string): DocEntry[] {
  const entries: DocEntry[] = [];
  let section = "";
  for (const line of index.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const link = /^- \[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/.exec(line);
    if (link === null || !link[2]!.startsWith(RAW)) continue;
    entries.push({ path: link[2]!.slice(RAW.length), title: link[1]!, summary: link[3] ?? "", section });
  }
  return entries;
}

function parseRules(spec: string): Map<string, SpecRule> {
  const rules = new Map<string, SpecRule>();
  let section = "";
  let current: SpecRule | undefined;
  for (const line of spec.split("\n")) {
    const heading = /^#{2,4} (.*)$/.exec(line);
    if (heading !== null) section = heading[1]!.trim();
    const rule = RULE.exec(line);
    if (rule !== null) {
      current = { id: rule[1]!, section, text: rule[2]! };
      rules.set(current.id, current);
    } else if (current !== undefined && line.startsWith("  ") && line.trim() !== "") {
      current.text += ` ${line.trim()}`;
    } else {
      current = undefined;
    }
  }
  return rules;
}
