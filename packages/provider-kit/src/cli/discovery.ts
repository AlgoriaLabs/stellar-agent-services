// How agents see you: the provider as agents meet it, printed by `provider-kit check`, with hints that never fail it.
//
//   search    stellar-agent-search's find_agent (and 8004 explorers) matches a query against the registration: its name
//             and description, which `provider-kit launch` (or `register`) publishes from provider.name and
//             provider.description, and its services' names and endpoints. On testnet, stellar-agent-search 0.2.0
//             reads agents straight from the registry, and also matches a bound manifest's services [I1]–[I3]: their
//             names, titles, descriptions and tags. On mainnet the explorer's list has no services, so only the name
//             and description count there.
//   ranking   in stellar-agent-search, reviews from distinct paying clients only. Declarations add nothing.
//   services  an agent picks a service by its description, and an example shows it what to send [§3.4].
//
// Words are matched as stellar-agent-search 0.2.0 matches them (src/lib/text-match.ts and src/lib/nlparse.ts): accents
// and case folded, words of two or more characters that aren't its stopwords, a crude suffix stem, then a substring
// test on each field.

import { DEFAULT_MANIFEST_PATH, type ProviderManifest, type ServiceDescriptor } from "@stellar-agent-services/protocol";
import { DESCRIPTION_TO_WRITE, PROVIDER_DESCRIPTION_TO_WRITE } from "../gateway/openapi.js";
import { plain } from "./shared.js";

/** The stellar-agent-search release whose matching this follows, and whose CLI shows the live profile. */
export const SEARCH_PACKAGE = "stellar-agent-search@0.2.0";

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
  const testnet = manifest.payment.accepts[0].network === "stellar:testnet";
  const shown = registered === undefined ? { name: provider.name, description } : { name: text(registered["name"]), description: text(registered["description"]) };
  const lines = [
    "How agents see you",
    `  Search matches ${testnet ? "" : "only "}this name and description${registered === undefined ? ", which provider-kit launch publishes" : ", as registered"}:`,
    `    ${plain(shown.name, 100) || "(no name)"}`,
    `    ${plain(shown.description, 100) || "(no description)"}`,
  ];
  if (testnet) {
    lines.push(...wrap("· On testnet it also matches your services' names, titles, descriptions and tags, once the manifest is live and names the agent [I1]–[I3].", "  ", "    "));
  }

  const hints: string[] = [];
  if (registered !== undefined && (shown.name !== provider.name || shown.description !== description)) {
    hints.push("The registry still has an older name or description: provider-kit launch updates it.");
  }
  if (description.trim() === "") hints.push("provider.description is empty, so search matches only your name.");
  else if (description === PROVIDER_DESCRIPTION_TO_WRITE) hints.push("provider.description is still init's placeholder: say what you offer, in the words buyers type.");
  // The registration lists the manifest and baseUrl as its services, whose names and endpoints search matches too.
  const listed = `stellar-agent-services ${new URL(DEFAULT_MANIFEST_PATH, manifest.baseUrl).toString()} web ${manifest.baseUrl}`;
  const missing = missingWords(`${provider.name} ${description} ${listed}`, services);
  const notes: string[] = [];
  if (missing.length > 0 && testnet) {
    notes.push(`On mainnet, search reads no service names, titles or tags: agents searching there for ${wordList(missing)} wouldn't find you. provider-kit check --fix puts those words in provider.description.`);
  } else if (missing.length > 0) {
    hints.push(`Search reads no service names, titles or tags on mainnet, so agents searching for ${wordList(missing)} won't find you. Put those words in provider.description: provider-kit check --fix does.`);
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

  for (const note of notes) lines.push(...wrap(`· ${note}`, "  ", "    "));
  lines.push(...wrap("· Ranking counts reviews from distinct paying clients only. Until the first, search lists you as new and unrated.", "  ", "    "));
  if (agentId === undefined) {
    lines.push("  · Not registered yet: provider-kit launch publishes this name and description.");
  } else {
    lines.push(`  · Live: ${testnet ? "STELLAR_NETWORK=testnet " : ""}npx -y ${SEARCH_PACKAGE} profile ${agentId}`);
  }
  return lines;
}

/** The most provider.description may hold (the gateway config's schema, and the manifest's). */
const DESCRIPTION_MAX = 500;

/**
 * provider.description with the words search would miss written in, for `provider-kit check --fix`: a sentence naming
 * the services, then any tag words still missing. Undefined when search already finds every word.
 */
export function describedWithServices(manifest: ProviderManifest): string | undefined {
  const { provider, services } = manifest;
  const description = (provider.description ?? "").trim();
  if (missingWords(`${provider.name} ${description}`, services).length === 0) return undefined;
  const base = description === "" || description === PROVIDER_DESCRIPTION_TO_WRITE ? "" : `${description.replace(/([^.!?])$/, "$1.")} `;
  const titles = services.map((service) => plain(service.title ?? service.name.replace(/[-_]+/g, " "), 60));
  let text = `${base}Services: ${titles.join(", ")}.`;
  const still = missingWords(`${provider.name} ${text}`, services);
  if (still.length > 0) text += ` Keywords: ${still.join(", ")}.`;
  if (text.length <= DESCRIPTION_MAX) return text;
  // Too long: as many service titles as fit.
  const kept: string[] = [];
  for (const title of titles) {
    if (`${base}Services: ${[...kept, title].join(", ")}, and more.`.length > DESCRIPTION_MAX) break;
    kept.push(title);
  }
  return kept.length === 0 ? undefined : `${base}Services: ${kept.join(", ")}${kept.length < titles.length ? ", and more" : ""}.`;
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
