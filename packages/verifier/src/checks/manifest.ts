// C1 Manifest: the three steps every client takes (docs/provider-standard.md §2.4), and what a verifier
// looks at besides.
//
//   fetch     HTTPS, 200, application/json [M1]; no redirect, at most 256 KiB, I-JSON: UTF-8, no
//             duplicate keys, no lone surrogates [M3]; Cache-Control max-age of 300 s or less [M4]
//   schema    the manifest JSON Schema [M9]; a manifest of another major version is rejected [M8]
//   rules     checkManifestRules(): M1, M3, M5, M7, S6, S9, P11
//   schemas   every inputSchema and outputSchema is a JSON Schema 2020-12 that compiles (§3.3)
//   SHOULDs   on-success durations [S2], the portable schema subset [S7], reverse-DNS extension keys [X1]
//
// It decides what the other checks may do: probe the provider when the manifest is usable (it passed
// the JSON Schema and its baseUrl is on its own origin), and pay it only when C1 passed, as a
// conforming client would.

import {
  canonicalSha256,
  checkManifestRules,
  MANIFEST_MAX_BYTES,
  PROVIDER_STANDARD,
  type CheckResult,
  type JsonObject,
  type ProviderManifest,
} from "@stellar-agent-services/protocol";
import { isLoopback } from "../chain.js";
import { Recorder, type RunContext } from "../context.js";
import { answered } from "../http.js";
import { shown } from "../jobs.js";
import { duplicateKey, isObject } from "../json.js";
import { compileServiceSchema, discouragedKeywords, matchesSchema, schemaErrors, validateManifestSchema } from "../schemas.js";

/** Schema errors listed in one result; one broken field can produce many. */
const MAX_SCHEMA_ERRORS = 20;
const REVERSE_DNS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export async function checkManifest(ctx: RunContext): Promise<CheckResult> {
  const recorder = new Recorder("C1");
  recorder.evidence["url"] = ctx.manifestUrl;
  const url = parseUrl(ctx.manifestUrl);
  if (url === undefined) {
    recorder.fail("M1", "the manifest URL is not a URL");
    return recorder.result();
  }
  const local = ctx.dev && url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !local) {
    recorder.fail("M1", "the manifest must be served over HTTPS (http://localhost only in development mode [M6])");
    return recorder.result();
  }
  if (url.username !== "" || url.password !== "") {
    recorder.fail("M6", "the manifest URL must not have user info");
    return recorder.result();
  }

  // 1. Fetch [M1], [M3], [M4].
  const exchange = await ctx.http.request("C1", { method: "GET", url: ctx.manifestUrl, headers: { Accept: "application/json" }, maxBytes: MANIFEST_MAX_BYTES });
  if (exchange.status !== undefined) recorder.evidence["status"] = exchange.status;
  if (exchange.error === "too_large") {
    recorder.fail("M3", `the manifest is larger than ${MANIFEST_MAX_BYTES} bytes`);
    return recorder.result();
  }
  if (exchange.error !== undefined) {
    recorder.fail("M1", `the manifest URL ${answered(exchange)}`);
    return recorder.result();
  }
  if (exchange.status! >= 300 && exchange.status! < 400) {
    recorder.fail("M3", `the manifest URL answered ${exchange.status}: clients don't follow redirects, so the manifest must be served at its own URL`);
    return recorder.result();
  }
  if (exchange.status !== 200) {
    recorder.fail("M1", `the manifest URL answered ${exchange.status}, not 200`);
    return recorder.result();
  }
  const contentType = exchange.headers.get("Content-Type");
  if (mediaType(contentType) !== "application/json") recorder.fail("M1", `the manifest is served as ${contentType === null ? "no Content-Type" : shown(mediaType(contentType))}, not application/json`);
  const maxAge = cacheLifetime(exchange.headers.get("Cache-Control"));
  if (maxAge === undefined) recorder.warn("M4", "the manifest has no Cache-Control max-age; clients may keep a changed manifest too long");
  else if (maxAge > 300) recorder.warn("M4", `the manifest's Cache-Control max-age is ${maxAge} s; it should be 300 or less`);
  recorder.evidence["bytes"] = exchange.bytes.length;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(exchange.bytes);
  } catch {
    recorder.fail("M3", "the manifest is not UTF-8");
    return recorder.result();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    recorder.fail("M3", "the manifest is not JSON");
    return recorder.result();
  }
  const duplicate = duplicateKey(text);
  if (duplicate !== undefined) recorder.fail("M3", `the member at ${duplicate} appears twice; clients that keep the first and the last disagree on its value`);

  // 2. JSON Schema [M9], after the major version [M8].
  const standard = isObject(parsed) ? parsed["standard"] : undefined;
  if (typeof standard === "string" && /^stellar-agent-services\/provider@\d+$/.test(standard) && standard !== PROVIDER_STANDARD) {
    recorder.fail("M8", `the manifest is ${shown(standard)}; this verifier checks ${PROVIDER_STANDARD}`);
    return recorder.result();
  }
  // In development mode a loopback provider is checked as if it were served over HTTPS [M6].
  const checked = local && isObject(parsed) ? asHttps(parsed) : parsed;
  if (!validateManifestSchema(checked)) {
    const errors = schemaErrors(validateManifestSchema.errors);
    for (const error of errors.slice(0, MAX_SCHEMA_ERRORS)) recorder.fail("M9", `${error.pointer || "/"} ${error.message}`);
    if (errors.length > MAX_SCHEMA_ERRORS) recorder.evidence["schemaErrors"] = errors.length;
    return recorder.result();
  }
  const manifest = parsed as ProviderManifest;
  ctx.manifest = manifest;
  const option = manifest.payment.accepts[0];
  recorder.evidence["network"] = option.network;
  recorder.evidence["services"] = manifest.services.map((service) => service.name);
  if (manifest.provider.agentId !== undefined) recorder.evidence["agentId"] = manifest.provider.agentId;

  // 3. Service schemas, then the rules JSON Schema can't express.
  const broken = new Set<object>();
  manifest.services.forEach((service, index) => {
    for (const field of ["inputSchema", "outputSchema"] as const) {
      const compiled = compileServiceSchema(service[field]);
      if (compiled instanceof Error) {
        broken.add(service[field]);
        recorder.fail("§3.3", `/services/${index}/${field}: ${compiled.message}`);
      }
    }
  });
  const violations = checkManifestRules(checked as ProviderManifest, {
    manifestUrl: local ? ctx.manifestUrl.replace(/^http:/, "https:") : ctx.manifestUrl,
    // A schema that doesn't compile was reported above; its examples are not checked against it.
    validateExample: (schema: JsonObject, value) => broken.has(schema) || matchesSchema(schema, value) === true,
  });
  for (const violation of violations) recorder.fail(violation.rule, `${violation.pointer || "/"}: ${violation.message}`);
  if (!violations.some((violation) => violation.rule === "M3")) {
    ctx.manifestSha256 = await canonicalSha256(manifest);
    recorder.evidence["sha256"] = ctx.manifestSha256;
  }

  // SHOULD rules.
  manifest.services.forEach((service, index) => {
    if (service.charge === "on-success" && (service.expectedDurationSeconds ?? 0) > option.maxTimeoutSeconds / 2) {
      recorder.warn("S2", `/services/${index}: on-success work expected to take ${service.expectedDurationSeconds} s should take at most half of maxTimeoutSeconds (${option.maxTimeoutSeconds} s); use "upfront"`);
    }
    for (const field of ["inputSchema", "outputSchema"] as const) {
      for (const pointer of discouragedKeywords(service[field])) recorder.warn("S7", `/services/${index}/${field}${pointer} is outside the portable JSON Schema subset`);
    }
    for (const key of Object.keys(service.extensions ?? {})) {
      if (!REVERSE_DNS.test(key)) recorder.warn("X1", `/services/${index}/extensions has the key ${shown(key)}; extension keys should be reverse-DNS names`);
    }
  });
  for (const key of Object.keys(manifest.extensions ?? {})) {
    if (!REVERSE_DNS.test(key)) recorder.warn("X1", `/extensions has the key ${shown(key)}; extension keys should be reverse-DNS names`);
  }

  // Probing is safe once the job URLs are on the manifest's origin; paying, once a client would accept it.
  ctx.usable = !violations.some((violation) => ["M1", "M3", "M5"].includes(violation.rule));
  ctx.conformant = !recorder.failed;
  return recorder.result();
}

/** Loopback http:// URLs in a manifest as https://, for the schema and rule checks in development mode. */
function asHttps(manifest: Record<string, unknown>): Record<string, unknown> {
  const https = (value: unknown) => {
    if (typeof value !== "string") return value;
    const url = parseUrl(value);
    return url?.protocol === "http:" && isLoopback(url.hostname) ? value.replace(/^http:/, "https:") : value;
  };
  const copy: Record<string, unknown> = { ...manifest, baseUrl: https(manifest["baseUrl"]) };
  const provider = manifest["provider"];
  if (isObject(provider)) {
    const rewritten: Record<string, unknown> = { ...provider };
    for (const field of ["homepage", "termsUrl"]) if (field in provider) rewritten[field] = https(provider[field]);
    copy["provider"] = rewritten;
  }
  return copy;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function mediaType(contentType: string | null): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/** How long a cache may keep the manifest: 0 for no-cache or no-store, undefined without max-age. */
function cacheLifetime(header: string | null): number | undefined {
  if (header === null) return undefined;
  const directives = header.split(",").map((directive) => directive.trim().toLowerCase());
  if (directives.includes("no-store") || directives.includes("no-cache")) return 0;
  for (const directive of directives) {
    const match = /^max-age=(\d+)$/.exec(directive);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}
