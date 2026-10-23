// Provider manifest: what a provider publishes about itself (docs/provider-standard.md §2–§4).
//
// Validating a manifest takes two steps (§2.4):
//   1. schemas/manifest.schema.json, with any JSON Schema 2020-12 validator;
//   2. checkManifestRules(), for the rules JSON Schema can't express.
// This package has no runtime dependencies, so it ships the schema rather than a validator.
// test-vectors/manifests.json pins both steps; test-vectors/challenges.json pins checkChallenge().

import { canonicalJson, type JsonObject, type JsonValue } from "./canonical-json.js";
import { createJobUrl, type Charge } from "./jobs.js";
import type { StellarNetwork } from "./networks.js";
import { SERVICE_SCHEMA_MAX_BYTES } from "./standard.js";
import { stellarAddressKind } from "./strkey.js";

export interface ProviderManifest {
  standard: "stellar-agent-services/provider@1";
  provider: ProviderInfo;
  baseUrl: string;
  payment: PaymentInfo;
  jobs?: { retentionSeconds?: number };
  services: ServiceDescriptor[];
  extensions?: JsonObject;
}

export interface ProviderInfo {
  name: string;
  description?: string;
  homepage?: string;
  agentId?: number;
  termsUrl?: string;
  dataUse?: { storesInputs?: boolean; trainsOnInputs?: boolean };
}

export interface PaymentInfo {
  protocol: "x402";
  x402Version: 2;
  /** Exactly one option in v1 [P1]. */
  accepts: [PaymentOption];
}

/** x402 v2 PaymentRequirements field names, without `amount` (§4.1). */
export interface PaymentOption {
  scheme: "exact";
  network: StellarNetwork;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { areFeesSponsored: true; [key: string]: JsonValue };
}

/** One service. Field names follow MCP tools, so a service maps 1:1 to an MCP tool (Appendix B). */
export interface ServiceDescriptor {
  name: string;
  title?: string;
  description: string;
  price: { amount: string };
  charge?: Charge;
  expectedDurationSeconds?: number;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  examples?: { input: JsonObject; output: JsonObject }[];
  maxInputBytes?: number;
  tags?: string[];
  capacity?: ServiceCapacity;
  extensions?: JsonObject;
}

/** How much load a service takes (§5.8). Hints only: the provider's 429, 503 and queue answers are what count. */
export interface ServiceCapacity {
  /** Jobs the service runs at the same time. */
  concurrency?: number;
  /** Longest a new job may expect to wait in the queue; beyond it, create-job answers 503. 0: no queue. */
  maxQueueWaitSeconds?: number;
}

/** A broken rule: its id in provider-standard.md and a JSON Pointer to the offending value. */
export interface RuleViolation {
  rule: string;
  pointer: string;
  message: string;
}

export interface ManifestRuleOptions {
  /** The URL the manifest was fetched from. */
  manifestUrl: string;
  /** Validates a value against a JSON Schema. Without it, examples are not checked [S9]. */
  validateExample?: (schema: JsonObject, value: JsonValue) => boolean;
}

/**
 * Checks the manifest rules that JSON Schema can't express: M1 (HTTPS manifest URL), M3 (I-JSON),
 * M5 (same origin), M7 (unique service names), S6 (schema size), S9 (examples) and P11 (address
 * checksum). Call it only on a manifest that passed the JSON Schema.
 */
export function checkManifestRules(manifest: ProviderManifest, options: ManifestRuleOptions): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const report = (rule: string, pointer: string, message: string) => {
    violations.push({ rule, pointer, message });
  };

  const loneSurrogate = findLoneSurrogate(manifest, "");
  if (loneSurrogate !== undefined) {
    // The size checks below need canonical JSON, which this rules out.
    report("M3", loneSurrogate, "the manifest must be I-JSON (RFC 7493): no lone surrogates");
    return violations;
  }

  const manifestUrl = parseUrl(options.manifestUrl);
  if (manifestUrl?.protocol !== "https:") {
    report("M1", "", "the manifest must be served over HTTPS");
  } else if (parseUrl(manifest.baseUrl)?.origin !== manifestUrl.origin) {
    report("M5", "/baseUrl", "baseUrl must have the same origin as the manifest URL");
  }

  if (stellarAddressKind(manifest.payment.accepts[0].payTo) === undefined) {
    report("P11", "/payment/accepts/0/payTo", "payTo must be a G... or C... address with a valid checksum");
  }

  const names = new Set<string>();
  const validateExample = options.validateExample;
  manifest.services.forEach((service, index) => {
    const at = `/services/${index}`;
    if (names.has(service.name)) report("M7", `${at}/name`, `service name "${service.name}" is used twice`);
    names.add(service.name);

    for (const field of ["inputSchema", "outputSchema"] as const) {
      const bytes = new TextEncoder().encode(canonicalJson(service[field])).length;
      if (bytes > SERVICE_SCHEMA_MAX_BYTES) {
        report("S6", `${at}/${field}`, `${field} is ${bytes} bytes; the limit is ${SERVICE_SCHEMA_MAX_BYTES}`);
      }
    }

    if (validateExample === undefined) return;
    service.examples?.forEach((example, i) => {
      if (!validateExample(service.inputSchema, example.input)) {
        report("S9", `${at}/examples/${i}/input`, "the example input does not match inputSchema");
      }
      if (!validateExample(service.outputSchema, example.output)) {
        report("S9", `${at}/examples/${i}/output`, "the example output does not match outputSchema");
      }
    });
  });

  return violations;
}

/**
 * Checks a decoded x402 PAYMENT-REQUIRED challenge for one service against the manifest the user
 * approved ([P3], [P4], [P5]). A client refuses to sign if this returns any violation [P7].
 */
export function checkChallenge(manifest: ProviderManifest, serviceName: string, challenge: unknown): RuleViolation[] {
  const service = manifest.services.find((candidate) => candidate.name === serviceName);
  if (service === undefined) throw new TypeError(`checkChallenge: the manifest has no service "${serviceName}"`);
  if (!isObject(challenge)) {
    return [{ rule: "P3", pointer: "", message: "the challenge must be an x402 PaymentRequired object" }];
  }

  const violations: RuleViolation[] = [];
  const report = (rule: string, pointer: string, message: string) => {
    violations.push({ rule, pointer, message });
  };

  if (challenge["x402Version"] !== 2) report("P3", "/x402Version", "the challenge must be x402 version 2");

  const resource = challenge["resource"];
  if (!isObject(resource) || resource["url"] !== createJobUrl(manifest.baseUrl, service.name)) {
    report("P5", "/resource/url", "resource.url must be the service's create-job URL");
  }

  const accepts = challenge["accepts"];
  if (!Array.isArray(accepts) || accepts.length !== 1) {
    report("P4", "/accepts", "accepts must have exactly one entry");
    return violations;
  }
  const entry: unknown = accepts[0];
  if (!isObject(entry)) {
    report("P4", "/accepts/0", "the payment option must be an object");
    return violations;
  }

  const option = manifest.payment.accepts[0];
  const expected = {
    scheme: option.scheme,
    network: option.network,
    asset: option.asset,
    payTo: option.payTo,
    amount: service.price.amount,
    maxTimeoutSeconds: option.maxTimeoutSeconds,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (entry[field] !== value) report("P4", `/accepts/0/${field}`, `${field} must equal the manifest`);
  }
  const extra = entry["extra"];
  if (!isObject(extra) || extra["areFeesSponsored"] !== true) {
    report("P4", "/accepts/0/extra/areFeesSponsored", "fees must be sponsored");
  }

  return violations;
}

// TODO:
// - parseManifest(): fetch rules (M1, M3: no redirects, at most MANIFEST_MAX_BYTES), then the JSON
//   Schema, then checkManifestRules(). It lives with a validator, in the kit, verifier and client.

function findLoneSurrogate(value: unknown, pointer: string): string | undefined {
  const loneSurrogate = /[\uD800-\uDFFF]/u;
  if (typeof value === "string") return loneSurrogate.test(value) ? pointer : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, member] of Object.entries(value)) {
    const at = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (loneSurrogate.test(key)) return at;
    const found = findLoneSurrogate(member, at);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
