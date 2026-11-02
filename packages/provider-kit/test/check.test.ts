// provider-kit check: --fix writes the words search would miss into a gateway config's provider.description, --json
// prints the result for scripts, and a provider on this computer that isn't registered yet passes with a note. The
// facilitator and Horizon are stubbed: nothing here touches the network.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HORIZON_URL, USDC_ISSUER } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "../src/cli/check.js";
import { describedWithServices } from "../src/cli/discovery.js";
import { UsageError } from "../src/cli/shared.js";
import { PROVIDER_DESCRIPTION_TO_WRITE } from "../src/gateway/openapi.js";
import type { ProviderManifest } from "../src/index.js";

const directory = mkdtempSync(join(tmpdir(), "provider-kit-check-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const payTo = Keypair.random().publicKey();
let files = 0;

function config(description: string): string {
  const path = join(directory, `provider-${++files}.json`);
  const service = (name: string, title: string, tags: string[]) => ({
    name,
    title,
    description: `${title}s English text for agents, up to 20,000 characters, in one call.`,
    price: "0.01",
    tags,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    examples: [{ input: { text: "Hi" }, output: { text: "Hi" } }],
    upstream: { url: "http://127.0.0.1:8000/run" },
  });
  const file = {
    baseUrl: "http://localhost:8787",
    dev: true,
    network: "stellar:testnet",
    payTo,
    facilitator: "https://x402.org/facilitator",
    provider: { name: "Text Tools", description },
    store: "memory",
    services: [service("summarize", "Summarize", ["nlp"]), service("translate", "Translate", ["languages"])],
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

let printed: string[] = [];
beforeEach(() => {
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }] });
    if (url === `${HORIZON_URL["stellar:testnet"]}/accounts/${payTo}`) return Response.json({ balances: [{ asset_code: "USDC", asset_issuer: USDC_ISSUER["stellar:testnet"], balance: "0" }] });
    throw new TypeError("fetch failed");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider-kit check", () => {
  it("passes a provider on this computer that isn't registered yet, saying launch registers it", async () => {
    expect(await check({ config: config("Summaries and translations of English text, for agents.") })).toBe(0);
    expect(printed.join("\n")).toContain("! 8004: not registered yet: provider-kit launch registers it, with your public address");
    expect(printed.join("\n")).toContain("All checks passed.");
  });

  it("writes the words search would miss into provider.description with --fix, and prints JSON with --json", async () => {
    const path = config("Tools for English text.");
    expect(await check({ config: path, fix: true, json: true })).toBe(0);
    const result = JSON.parse(printed.join("\n"));
    expect(result).toMatchObject({ ok: true, fixed: { file: path, description: "Tools for English text. Services: Summarize, Translate. Keywords: nlp, languages." } });
    expect(result.checks.map((line: { status: string }) => line.status)).toEqual(["ok", "warn", "ok", "ok", "warn"]);
    expect(JSON.parse(readFileSync(path, "utf8")).provider.description).toBe("Tools for English text. Services: Summarize, Translate. Keywords: nlp, languages.");

    // Nothing is missing now, so there is nothing to suggest.
    printed = [];
    expect(await check({ config: path, json: true })).toBe(0);
    expect(JSON.parse(printed.join("\n")).suggestedDescription).toBeUndefined();
  });

  it("edits only a gateway config", async () => {
    await expect(check({ manifest: "http://localhost:8787/.well-known/stellar-agent-services.json", fix: true })).rejects.toThrow(UsageError);
  });
});

describe("describedWithServices", () => {
  const manifest = (description: string | undefined, services: { name: string; title?: string; tags?: string[] }[]) =>
    ({ provider: { name: "Tools", ...(description === undefined ? {} : { description }) }, services }) as unknown as ProviderManifest;

  it("replaces init's placeholder, and leaves a description that already has every word", () => {
    expect(describedWithServices(manifest(PROVIDER_DESCRIPTION_TO_WRITE, [{ name: "random-fact" }]))).toBe("Services: random fact.");
    expect(describedWithServices(manifest("Random facts on demand.", [{ name: "random-fact" }]))).toBeUndefined();
  });

  it("stays within the 500 characters a description may hold", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ name: `service-${index}`, title: `Specialised converter number ${index}` }));
    const text = describedWithServices(manifest("Converters.", many))!;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toMatch(/^Converters\. Services: Specialised converter number 0, .*, and more\.$/);
  });
});
