import { describe, expect, it } from "vitest";
import { isManifestUrl, registeredManifests, resolveRequest, type ResolveOptions } from "../src/index.js";
import { fakeRegistry, validator } from "./support/harness.js";

// Resolving a validation request to the manifest to verify, when the request document is gone and the
// agent's registration has to say. The watcher's tests cover the request document itself.

const MANIFEST = "https://provider.test/.well-known/stellar-agent-services.json";
const REQUEST = { requestHash: "ab".repeat(32), agentId: 3, ledger: 10 };

function registration(services: unknown[]): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", services })).toString("base64")}`;
}

function options(agentUri: string | undefined, fetch?: typeof globalThis.fetch): ResolveOptions {
  const { registry } = fakeRegistry(agentUri === undefined ? {} : { [REQUEST.agentId]: { uri: agentUri } });
  return {
    network: "stellar:testnet",
    validator,
    registry,
    // The RPC no longer keeps the request's event.
    chain: {
      async getEvents() {
        throw new Error("startLedger must be between the oldest ledger: 20 and the latest ledger: 30");
      },
    },
    ...(fetch === undefined ? {} : { fetch }),
  };
}

describe("resolving a request from the agent's registration", () => {
  it("verifies the one https manifest URL the registration lists [I1]", async () => {
    const uri = registration([{ name: "web", endpoint: "https://provider.test" }, { name: "stellar-agent-services", endpoint: MANIFEST, version: "1" }]);
    expect(await resolveRequest(REQUEST, options(uri))).toEqual({ manifestUrl: MANIFEST, from: "registration" });
  });

  it("reads a registration file at an https agent URI, without following redirects", async () => {
    const calls: RequestInit[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ services: [{ name: "stellar-agent-services", endpoint: MANIFEST }] }));
    }) as unknown as typeof globalThis.fetch;
    expect(await resolveRequest(REQUEST, options("https://owner.test/agent.json", fetch))).toEqual({ manifestUrl: MANIFEST, from: "registration" });
    expect(calls[0]).toMatchObject({ redirect: "manual" });
  });

  it.each<[string, string | undefined, RegExp]>([
    ["no agent", undefined, /agent 3 does not exist in the stellar:testnet identity registry \[I2\]/],
    ["no manifest", registration([{ name: "web", endpoint: "https://provider.test" }]), /lists no https:\/\/ stellar-agent-services endpoint \[I1\]/],
    ["an http manifest", registration([{ name: "stellar-agent-services", endpoint: "http://provider.test/m.json" }]), /lists no https:\/\/ stellar-agent-services endpoint/],
    ["a manifest URL with user info", registration([{ name: "stellar-agent-services", endpoint: "https://me:pw@provider.test/m.json" }]), /lists no https:\/\/ stellar-agent-services endpoint/],
    [
      "two manifests",
      registration([
        { name: "stellar-agent-services", endpoint: MANIFEST },
        { name: "stellar-agent-services", endpoint: "https://other.test/m.json" },
      ]),
      /lists 2 manifest URLs, and the request document, which would choose one, is unavailable: its validation_request event can't be read/,
    ],
    ["an IPFS registration", "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", /on IPFS, which this verifier does not read yet/],
    ["an http agent URI", "http://owner.test/agent.json", /neither data: nor https:/],
    ["a registration that is not JSON", "data:application/json,nope", /not a JSON object \[I1\]/],
  ])("waits for a registration with %s", async (_name, uri, message) => {
    const resolution = await resolveRequest(REQUEST, options(uri));
    expect(resolution).toEqual({ wait: expect.stringMatching(message) });
  });

  it("waits for a registration file that can't be fetched yet", async () => {
    const fetch = (async () => new Response("", { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await resolveRequest(REQUEST, options("https://owner.test/agent.json", fetch))).toEqual({ wait: "the registration file at the agent URI answered 404 [I1]" });
  });

  it("retries, and holds nothing against the request, when the identity registry can't be read", async () => {
    const resolve = options(registration([]));
    const { registry, state } = fakeRegistry();
    state.down = true;
    expect(await registeredManifests(REQUEST.agentId, { ...resolve, registry })).toEqual({ retry: "the identity registry can't be read" });
  });

  it("accepts only https manifest URLs without user info [M1], [M6]", () => {
    expect(isManifestUrl(MANIFEST)).toBe(true);
    expect(isManifestUrl("http://provider.test/m.json")).toBe(false);
    expect(isManifestUrl("https://user@provider.test/m.json")).toBe(false);
    expect(isManifestUrl("not a url")).toBe(false);
  });
});
