// The MCP server for coding agents that build on Provider Standard v1.
//
// Tools:
//   list_docs          the documentation index (llms.txt)
//   read_doc           one document from that index
//   search_docs        lines of the indexed documents that contain every term of a query
//   get_spec_rule      a rule of the standard by id, such as J13
//   validate_manifest  check C1 on a manifest document that is not served yet
//   check_provider     `verifier check` on a running provider: C1, C2, C3, C6 and C7's unpaid burst
//
// It holds no key and never pays: check_provider runs without a test payer, so the paid checks (C4, C5)
// are always skipped. The documents are read from the clone the server is built in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PROVIDER_STANDARD, type CheckResult } from "@stellar-agent-services/protocol";
import { checkManifestDocument, InvalidOptionsError, verifyProvider, type VerifyOptions } from "@stellar-agent-services/verifier";
import { z } from "zod/v4";
import { Docs } from "./docs.js";

export const SERVER = { name: "stellar-agent-services", version: "0.0.0" } as const;

/** The repository this file is built in: dist/ is two levels below it. */
const REPOSITORY = new URL("../../../", import.meta.url);
const MAX_SEARCH_HITS = 50;

export interface ServerOptions {
  /** The repository the documents are read from. Default: the clone this server is built in. */
  root?: URL;
  /** Passed to verifyProvider() by check_provider, such as an offline provider's fetch in tests. Never a payer. */
  verify?: Omit<Partial<VerifyOptions>, "payer">;
}

export function createServer(options: ServerOptions = {}): McpServer {
  const docs = new Docs(options.root ?? REPOSITORY);
  const server = new McpServer(SERVER, {
    instructions:
      `Tools for building on ${PROVIDER_STANDARD}, the standard for paid AI services on Stellar. ` +
      "Start with read_doc on AGENTS.md to pick a path. Cite spec rules by id and look them up with get_spec_rule. " +
      "Check a manifest with validate_manifest while writing it, and a running provider with check_provider. Nothing here pays.",
  });

  server.registerTool(
    "list_docs",
    {
      title: "List documents",
      description: "The documentation index (llms.txt): every guide, reference and schema, with a one-line summary. read_doc takes any path it lists.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(docs.index),
  );

  server.registerTool(
    "read_doc",
    {
      title: "Read a document",
      description: "Reads one document listed by list_docs, by repository path (such as docs/provider-standard.md or AGENTS.md) or by its llms.txt URL.",
      inputSchema: { path: z.string().describe("Repository path or llms.txt URL") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const entry = docs.entry(path);
      if (entry === undefined) return error(`${path} is not in the index. Paths you can read:\n${docs.entries.map((known) => known.path).join("\n")}`);
      return text(docs.read(entry));
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the documents",
      description: "Finds lines that contain every term of the query, case-insensitive, across the indexed documents. Returns path:line and the line.",
      inputSchema: {
        query: z.string().min(1).describe("Terms, such as \"payment_uncertain reconcile\""),
        limit: z.number().int().min(1).max(MAX_SEARCH_HITS).optional().describe(`Most hits to return (default 20, at most ${MAX_SEARCH_HITS})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const hits = docs.search(query, limit ?? 20);
      if (hits.length === 0) return text(`No line contains every term of "${query}".`);
      return text(hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n"));
    },
  );

  server.registerTool(
    "get_spec_rule",
    {
      title: "Get a spec rule",
      description:
        "The full text of a Provider Standard v1 rule by id, such as M5, P7, J13 or Q1, with its section. Prefixes: M manifest, S services, P payment, J jobs, Q capacity, E errors, I identity, X extensions.",
      inputSchema: { id: z.string().describe("Rule id, such as J13 or [J13]") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const rule = docs.rule(id);
      if (rule === undefined) return error(`No rule ${id}. Rules: ${docs.ruleIds().join(", ")}`);
      return text(`[${rule.id}] (docs/provider-standard.md, ${rule.section})\n${rule.text}`);
    },
  );

  server.registerTool(
    "validate_manifest",
    {
      title: "Validate a manifest",
      description:
        "Runs check C1 on a manifest document before it is served: the JSON Schema [M9], the rules JSON Schema can't express (M3, M5, M7, S6, S9, P11), the service schemas, and SHOULD rules. Serving rules (status, Content-Type, redirects, Cache-Control) need check_provider on the running provider.",
      inputSchema: {
        manifest: z.string().describe("The manifest's JSON text"),
        manifestUrl: z.string().optional().describe("Where it will be served. Default: /.well-known/stellar-agent-services.json on the origin of its baseUrl"),
        dev: z.boolean().optional().describe("Accept a loopback http:// provider [M6]"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ manifest, manifestUrl, dev }) => {
      const result = await checkManifestDocument(manifest, { ...(manifestUrl === undefined ? {} : { manifestUrl }), dev: dev ?? false });
      return text(`${describe(result)}\n\n${JSON.stringify(result, null, 2)}`);
    },
  );

  server.registerTool(
    "check_provider",
    {
      title: "Check a running provider",
      description:
        "Runs `verifier check` on a provider's manifest URL: C1 manifest, C2 identity, C3 challenge, C6 hygiene and an unpaid load burst (C7, 20 requests). It never pays, so C4 and C5 are skipped. Sends requests to the provider.",
      inputSchema: {
        manifestUrl: z.string().describe("Such as https://api.example.com/.well-known/stellar-agent-services.json"),
        dev: z.boolean().optional().describe("Accept a provider on http://localhost [M6]"),
        service: z.string().optional().describe("The service to probe and load. Default: the cheapest one with an example"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ manifestUrl, dev, service }) => {
      const { payer: _never, ...overrides } = (options.verify ?? {}) as Partial<VerifyOptions>;
      try {
        const report = await verifyProvider({ ...overrides, manifestUrl, dev: dev ?? false, ...(service === undefined ? {} : { service }) });
        const lines = report.results.map(describe);
        lines.push("", `Level ${report.level}, score ${report.score} of 100. Paid checks (C4, C5) need \`verifier verify --pay\` with a funded testnet payer.`);
        return text(`${lines.join("\n")}\n\n${JSON.stringify(report, null, 2)}`);
      } catch (caught) {
        if (caught instanceof InvalidOptionsError) return error(caught.message);
        throw caught;
      }
    },
  );

  return server;
}

/** One line for a check, then its findings. */
function describe(result: CheckResult): string {
  const head = `${result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "-"} ${result.check} ${result.status}${result.reason === undefined ? "" : `: ${result.reason}`}`;
  const findings = (result.findings ?? []).map((finding) => `    ${finding.severity} [${finding.rule}] ${finding.message}`);
  return [head, ...findings].join("\n");
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function error(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }], isError: true };
}
