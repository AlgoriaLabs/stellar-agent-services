import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { applyPatch, loadVectors } from "../../protocol/test/support/vectors.js";
import { fastSleep, setup } from "../../verifier/test/support/harness.js";
import { createServer, type ServerOptions } from "../src/server.js";

// The server through a real MCP client. check_provider runs against the verifier's offline world: the
// real Provider Kit, a fake chain and registry, and no network.

async function connect(options: ServerOptions = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return { isError: result.isError ?? false, text: first?.type === "text" ? first.text : "" };
  };
  return { client, call };
}

const full = loadVectors<{ bases: Record<string, { manifest: unknown }> }>("manifests.json").bases["full"]!.manifest;

describe("dev-mcp", () => {
  it("lists its tools, every one read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["check_provider", "get_spec_rule", "list_docs", "read_doc", "search_docs", "validate_manifest"]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("serves the index and the documents it lists, and nothing else", async () => {
    const { call } = await connect();
    expect((await call("list_docs")).text).toContain("AGENTS.md");
    expect((await call("read_doc", { path: "docs/provider-standard.md" })).text).toMatch(/^# Provider Standard v1/);
    const byUrl = await call("read_doc", { path: "https://raw.githubusercontent.com/AlgoriaLabs/stellar-agent-services/main/AGENTS.md" });
    expect(byUrl.text).toMatch(/^# AGENTS\.md/);
    for (const path of ["package.json", "../../etc/passwd", ".env"]) {
      expect(await call("read_doc", { path })).toMatchObject({ isError: true });
    }
  });

  it("finds lines with every term", async () => {
    const { call } = await connect();
    const { text } = await call("search_docs", { query: "payment_uncertain J13", limit: 5 });
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
    expect(text).toMatch(/^docs\/\S+\.md:\d+: .*payment_uncertain/im);
  });

  it("returns a spec rule with its continuation lines", async () => {
    const { call } = await connect();
    const { text } = await call("get_spec_rule", { id: "[m5]" });
    expect(text).toContain("[M5]");
    expect(text).toContain("2.3 Fields");
    expect(text).toContain("MUST NOT end with `/`");
    expect(await call("get_spec_rule", { id: "Z9" })).toMatchObject({ isError: true });
  });

  it("validates a manifest document", async () => {
    const { call } = await connect();
    expect((await call("validate_manifest", { manifest: JSON.stringify(full) })).text).toMatch(/^✓ C1 passed/);
    const otherOrigin = applyPatch(full, [{ op: "replace", path: "/baseUrl", value: "https://other.example.com" }]);
    const { text } = await call("validate_manifest", {
      manifest: JSON.stringify(otherOrigin),
      manifestUrl: "https://api.example.com/.well-known/stellar-agent-services.json",
    });
    expect(text).toMatch(/^✗ C1 failed/);
    expect(text).toContain("[M5]");
  });

  it("checks a running provider without paying", async () => {
    const world = setup();
    const { call } = await connect({ verify: { fetch: world.fetch, rpc: world.chain.chain, registry: world.registry, sleep: fastSleep } });
    const { text, isError } = await call("check_provider", { manifestUrl: world.provider.manifestUrl });
    expect(isError).toBe(false);
    for (const check of ["✓ C1", "✓ C2", "✓ C3", "- C4 skipped", "- C5 skipped", "✓ C6", "✓ C7"]) expect(text).toContain(check);
    expect(world.chain.state.transactions).toEqual([]);
  });
});
