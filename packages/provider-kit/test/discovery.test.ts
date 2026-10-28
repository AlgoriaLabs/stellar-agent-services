// How agents see you (provider-kit check): what search matches, matched the way stellar-agent-search matches it,
// and the hints, which never fail the check.

import { afterEach, describe, expect, it } from "vitest";
import { howAgentsSeeYou, missingWords, searchWords, stem } from "../src/cli/discovery.js";
import { DESCRIPTION_TO_WRITE, PROVIDER_DESCRIPTION_TO_WRITE } from "../src/gateway/openapi.js";
import { defineService, registrationFile, type Provider, type ServiceDefinition } from "../src/index.js";
import { testProvider } from "./support/harness.js";

const GOOD = "Summarizes English text in one to five sentences. Use it to shorten articles before passing them on. Up to 20,000 characters.";

const service = (overrides: Partial<ServiceDefinition> = {}) =>
  defineService({
    name: "summarize",
    title: "Summarize",
    description: GOOD,
    price: "0.01",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    examples: [{ input: { text: "One. Two." }, output: { summary: "One." } }],
    handler: () => ({ summary: "One." }),
    ...overrides,
  });

const opened: Provider[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((provider) => provider.close()));
});

function manifestOf(services: ReturnType<typeof service>[], provider: { name: string; description?: string; agentId?: number }) {
  const { provider: created } = testProvider(services, { provider });
  opened.push(created);
  return created.manifest;
}

/** The section as one text, with wrapped lines joined back. */
const section = (lines: string[]) => lines.join("\n").replace(/\n {4}(?=[^ ])/g, " ");

describe("matching like stellar-agent-search", () => {
  it("folds accents and case, drops stopwords, numbers and single letters", () => {
    expect(searchWords("Résumé API for the 2 best PDF-to-text agents x")).toEqual(["resume", "pdf", "text"]);
  });

  it("takes one common suffix off, leaving at least three characters", () => {
    expect(["scraper", "scraping", "translates", "summarized", "maps", "red", "ping"].map(stem)).toEqual(["scra", "scra", "translat", "summariz", "map", "red", "ping"]);
  });

  it("finds a service word when its stem is in the name or description, and not otherwise", () => {
    const services = [service({ name: "translate", title: "Translate text", tags: ["translation", "nlp"] })];
    expect(missingWords("Translator: translates English text", services as never)).toEqual(["translation", "nlp"]);
    expect(missingWords("Summaries of English text", [service()] as never)).toEqual(["summarize"]);
  });
});

describe("howAgentsSeeYou", () => {
  it("shows the name and description search matches, says words from services aren't searched, and how ranking works", () => {
    const manifest = manifestOf([service(), service({ name: "classify-sentiment", title: "Classify sentiment", tags: ["sentiment"] })], {
      name: "Text Tools",
      description: "Summaries of English text.",
    });
    const lines = howAgentsSeeYou(manifest);
    expect(lines.slice(0, 4)).toEqual([
      "How agents see you",
      "  Search matches only this name and description, which provider-kit register publishes:",
      "    Text Tools",
      "    Summaries of English text.",
    ]);
    expect(section(lines)).toContain('agents searching for "summarize", "classify" or "sentiment" won\'t find you');
    expect(section(lines)).toContain("Ranking counts reviews from distinct paying clients only");
    expect(section(lines)).toContain("· Not registered yet: provider-kit register publishes this name and description.");
    expect(lines.every((line) => line.length <= 110)).toBe(true);
  });

  it("has no hint for a provider whose services are described, have an example, and are named in its description", () => {
    const lines = howAgentsSeeYou(manifestOf([service()], { name: "Summarizer", description: "Summarize English text for agents." }));
    expect(lines.filter((line) => line.startsWith("  !"))).toEqual([]);
  });

  it("flags init's placeholders, thin descriptions, prices and URLs in them, and services without an example", () => {
    const manifest = manifestOf(
      [
        service({ name: "my-service", title: "My service", description: DESCRIPTION_TO_WRITE }),
        service({ name: "short", title: "Summarize", description: "Summarizes text.", examples: [] }),
        service({ name: "priced", title: "Summarize", description: `${GOOD} Only $0.01 a call, see https://example.com/docs.` }),
      ],
      { name: "Summarizer", description: PROVIDER_DESCRIPTION_TO_WRITE },
    );
    const text = section(howAgentsSeeYou(manifest));
    expect(text).toContain("! provider.description is still init's placeholder");
    expect(text).toContain("! my-service: the description is still init's placeholder");
    expect(text).toContain("! short: a 2-word description, no example");
    expect(text).toContain("! priced: a price in the description, a URL in the description");
    expect(text).toContain("[§3.4]");
  });

  it("says when there is no provider description at all", () => {
    expect(section(howAgentsSeeYou(manifestOf([service()], { name: "Summarizer" })))).toContain("! provider.description is empty, so search matches only your name.");
  });

  it("shows the registered text once registered, says when it is older than the manifest, and how to see it live", () => {
    const manifest = manifestOf([service()], { name: "Summarizer", description: "Summarize English text for agents.", agentId: 42 });
    const current = registrationFile(manifest, "http://localhost:8787/.well-known/stellar-agent-services.json");
    const inSync = howAgentsSeeYou(manifest, current);
    expect(inSync[1]).toBe("  Search matches only this name and description, as registered:");
    expect(section(inSync)).not.toContain("older");
    expect(section(inSync)).toContain("· Live: STELLAR_NETWORK=testnet REGISTRY_AGENT_IDS=42 npx -y stellar-agent-search@0.1.0 profile 42");

    const old = howAgentsSeeYou(manifest, { ...current, description: "Old words.‮" });
    expect(old[3]).toBe("    Old words.");
    expect(section(old)).toContain("! The registry still has an older name or description: provider-kit register updates it.");
  });
});
