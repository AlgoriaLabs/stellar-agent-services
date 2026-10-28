# @stellar-agent-services/dev-mcp

An MCP server for coding agents that build on [Provider Standard v1](../../docs/provider-standard.md): a provider,
a gateway config, a native implementation or a paying client. It answers from this repository's documents and runs
the verifier's unpaid checks.

**It holds no key and never pays.** It is not the payment client's MCP server, which would let an agent hire
providers. That one is planned in [packages/payment-client](../payment-client/README.md).

| Tool | What it does |
| --- | --- |
| `list_docs` | The documentation index, [llms.txt](../../llms.txt) |
| `read_doc` | One document from that index, by repository path (`AGENTS.md`, `docs/provider-standard.md`) or llms.txt URL. Nothing outside the index can be read. |
| `search_docs` | Lines of the indexed documents that contain every term of a query, as `path:line` |
| `get_spec_rule` | A rule of the standard by id (`J13`, `[M5]`), with its section |
| `validate_manifest` | Check C1 on a manifest document before it is served: JSON Schema [M9], the rules it can't express, service schemas, SHOULD rules. Same code as the verifier. |
| `check_provider` | `verifier check` on a running provider: C1, C2, C3, C6 and an unpaid C7 burst. C4 and C5 need a payer, so they are skipped. |

## Use

From a clone, after `npm install && npm run build` at the repository root:

```bash
# Claude Code
claude mcp add stellar-agent-services -- node "$PWD/packages/dev-mcp/dist/index.js"
```

Any other MCP client takes the same command as a stdio server:

```json
{
  "mcpServers": {
    "stellar-agent-services": { "command": "node", "args": ["/path/to/stellar-agent-services/packages/dev-mcp/dist/index.js"] }
  }
}
```

The server reads the documents of the clone it is built in, so `git pull && npm run build` updates it.

As a library, `createServer(options)` returns the `McpServer`. `options.verify` passes options to
`verifyProvider()`, such as an offline provider's `fetch` in tests. It never takes a payer.

## Files

| File | Contents |
| --- | --- |
| `src/server.ts` | `createServer()`: the tools |
| `src/docs.ts` | The llms.txt index, document reads and search, spec rule parsing |
| `src/index.ts` | The stdio entry point |
| `test/server.test.ts` | Every tool through a real MCP client; `check_provider` against the verifier's offline provider |
