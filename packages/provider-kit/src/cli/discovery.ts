// How agents see you: the provider as agents meet it, printed by `provider-kit check`, with hints that never fail it.
//
//   search    Stellar 8004 search (stellar-agent-search's find_agent, and explorers) matches a query against the
//             registration's name and description only: provider.name and provider.description, as
//             `provider-kit register` publishes them. Service names, titles and tags are never searched.
//   ranking   in stellar-agent-search, reviews from distinct paying clients only. Declarations add nothing.
//   services  an agent picks a service by its description, and an example shows it what to send [§3.4].
//
// Words are matched as stellar-agent-search 0.1.0 matches them (src/lib/nlparse.ts and matchAgentsByQuery in
// src/lib/explorer.ts): accents and case folded, words of two or more characters that aren't its stopwords, a
// crude suffix stem, then a substring test on the name and description.

import type { ProviderManifest, ServiceDescriptor } from "@stellar-agent-services/protocol";
import { DESCRIPTION_TO_WRITE, PROVIDER_DESCRIPTION_TO_WRITE } from "../gateway/openapi.js";
import { plain } from "./shared.js";

/** stellar-agent-search's stopwords: query framing and filter triggers, which it never searches for. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "with", "without", "in", "on", "at", "by", "from", "as", "that",
  "this", "these", "those", "is", "are", "be", "which", "who", "whose", "whom", "it", "its",
  "find", "search", "get", "give", "show", "list", "me", "my", "i", "want", "need", "needs", "looking", "look",
  "please", "some", "any", "agent", "agents", "service", "services", "provider", "providers", "one", "ones",
  "using", "use", "uses", "used", "via", "through", "can", "should", "must", "supports", "support", "supporting",
  "has", "have", "having", "offers", "offer", "offering", "provides", "provide", "providing", "does", "do",
  "x402", "paid", "pay", "payment", "payments", "usdc", "monetized", "monetize", "cheap", "cheapest", "affordable",
  "micropayment", "micropayments", "microtransaction", "microtransactions", "mpp", "streaming", "invoke",
  "invocable", "invokable", "callable", "endpoint", "endpoints", "api", "apis",
  "reputation", "reputation-based", "validation", "validated", "tee", "enclave", "attested", "attestation", "trust",
  "trusted",
  "score", "scored", "rated", "rating", "reputable", "highly", "well", "reviewed", "review", "reviews", "high", "top",
  "best", "excellent", "great", "good", "quality", "above", "over", "least", "minimum", "min", "than", "more",
  "bir", "bu", "ve", "veya", "icin", "ile", "olan", "bana", "bul", "goster", "listele", "istiyorum", "lazim", "ajan",
  "ajanlar", "servis", "servisi", "hizmet", "hizmeti", "ucretli", "odemeli", "odeme", "odemeler", "ucuz",
  "cagrilabilir", "itibar", "puan", "puanli", "yuksek", "iyi", "itibarli", "dogrulama", "dogrulanmis",
]);
const SUFFIXES = ["ping", "ning", "ging", "ing", "pers", "per", "ers", "er", "es", "ed", "s"];

/** Fewer words than this can't say what a service does, when to use it and its limits [§3.4]. */
const MIN_DESCRIPTION_WORDS = 12;
const WORDS_SHOWN = 6;
const SERVICES_SHOWN = 8;
const WIDTH = 110;
const PRICE = /\$\s?\d|\b\d+(?:[.,]\d+)?\s?(?:usdc|usd|xlm|dollars?|cents?)\b/i;
const URL_TEXT = /\bhttps?:\/\/|\bwww\./i;

/**
 * The "How agents see you" section of `provider-kit check`. `registered` is the 8004 registration file read from the
 * registry, when the provider has an agentId and the file could be read: search shows its name and description.
 */
export function howAgentsSeeYou(manifest: ProviderManifest, registered?: Record<string, unknown>): string[] {
  const { provider, services } = manifest;
  const agentId = provider.agentId;
  const description = provider.description ?? "";
  const shown = registered === undefined ? { name: provider.name, description } : { name: text(registered["name"]), description: text(registered["description"]) };
  const lines = [
    "How agents see you",
    `  Search matches only this name and description${registered === undefined ? ", which provider-kit register publishes" : ", as registered"}:`,
    `    ${plain(shown.name, 100) || "(no name)"}`,
    `    ${plain(shown.description, 100) || "(no description)"}`,
  ];

  const hints: string[] = [];
  if (registered !== undefined && (shown.name !== provider.name || shown.description !== description)) {
    hints.push("The registry still has an older name or description: provider-kit register updates it.");
  }
  if (description.trim() === "") hints.push("provider.description is empty, so search matches only your name.");
  else if (description === PROVIDER_DESCRIPTION_TO_WRITE) hints.push("provider.description is still init's placeholder: say what you offer, in the words buyers type.");
  const missing = missingWords(`${provider.name} ${description}`, services);
  if (missing.length > 0) {
    hints.push(`Search reads no service names, titles or tags, so agents searching for ${wordList(missing)} won't find you. Put those words in provider.description.`);
  }

  const thin = services.flatMap((service) => {
    const issues = serviceIssues(service);
    return issues.length === 0 ? [] : [`${plain(service.name, 64)}: ${issues.join(", ")}`];
  });
  hints.push(...thin.slice(0, SERVICES_SHOWN));
  if (thin.length > SERVICES_SHOWN) hints.push(`… and ${thin.length - SERVICES_SHOWN} more services`);
  for (const hint of hints) lines.push(...wrap(`! ${hint}`, "  ", "    "));
  if (thin.length > 0) {
    lines.push(...wrap("An agent picks a service by its description: what it does, when to use it, its limits, with no price or URL [§3.4]. An example shows it what to send, and provider-kit try pays with it.", "    ", "    "));
  }

  lines.push(...wrap("· Ranking counts reviews from distinct paying clients only. Until the first, search lists you as new and unrated.", "  ", "    "));
  if (agentId === undefined) {
    lines.push("  · Not registered yet: provider-kit register publishes this name and description.");
  } else {
    const testnet = manifest.payment.accepts[0].network === "stellar:testnet" ? `STELLAR_NETWORK=testnet REGISTRY_AGENT_IDS=${agentId} ` : "";
    lines.push(`  · Live: ${testnet}npx -y stellar-agent-search@0.1.0 profile ${agentId}`);
  }
  return lines;
}

/** Words from the services' names, titles and tags that a search for them wouldn't match in `text`. */
export function missingWords(text: string, services: readonly ServiceDescriptor[]): string[] {
  const haystack = fold(text);
  const missing = new Set<string>();
  for (const service of services) {
    for (const word of searchWords([service.name, service.title ?? "", ...(service.tags ?? [])].join(" "))) {
      if (!haystack.includes(stem(word))) missing.add(word);
    }
  }
  return [...missing];
}

/** The words of `text` a search uses: folded, at least two characters, not a number, not a stopword. */
export function searchWords(text: string): string[] {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 2 && !/^\d+$/.test(word) && !STOPWORDS.has(word));
}

/** stellar-agent-search's stem: one common suffix off, leaving at least three characters. */
export function stem(word: string): string {
  const suffix = SUFFIXES.find((candidate) => word.endsWith(candidate) && word.length - candidate.length >= 3);
  return suffix === undefined ? word : word.slice(0, word.length - suffix.length);
}

function serviceIssues(service: ServiceDescriptor): string[] {
  const issues: string[] = [];
  const words = service.description.split(/\s+/).filter(Boolean).length;
  if (service.description === DESCRIPTION_TO_WRITE) issues.push("the description is still init's placeholder");
  else if (words < MIN_DESCRIPTION_WORDS) issues.push(`a ${words}-word description`);
  if (PRICE.test(service.description)) issues.push("a price in the description");
  if (URL_TEXT.test(service.description)) issues.push("a URL in the description");
  if (service.examples === undefined || service.examples.length === 0) issues.push("no example");
  return issues;
}

/** Accents and case folded, as search folds both the query and the text. */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/ı/g, "i").toLowerCase();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** "a", "b" or "c", and how many more. */
function wordList(words: string[]): string {
  const quoted = words.slice(0, WORDS_SHOWN).map((word) => `"${plain(word, 32)}"`);
  if (words.length > WORDS_SHOWN) return `${quoted.join(", ")} and ${words.length - WORDS_SHOWN} more`;
  return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)!}`;
}

/** Breaks `value` into lines of at most WIDTH characters: the first starts with `first`, the rest with `rest`. */
function wrap(value: string, first: string, rest: string): string[] {
  const lines: string[] = [];
  let line = first;
  for (const word of value.split(" ")) {
    const prefix = lines.length === 0 ? first : rest;
    if (line.length > prefix.length && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = rest + word;
    } else {
      line += line.length > prefix.length ? ` ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}
