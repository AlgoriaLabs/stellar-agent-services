// Fetching and validating a provider manifest (provider-standard.md §2.4): no redirects, at most
// MANIFEST_MAX_BYTES, the JSON Schema, then checkManifestRules().

import {
  checkManifestRules,
  MANIFEST_MAX_BYTES,
  type JsonObject,
  type JsonValue,
  type ProviderManifest,
} from "@stellar-agent-services/protocol";
import schema from "@stellar-agent-services/protocol/manifest.schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";

const validateManifest = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(schema as JsonObject);

export class ManifestError extends Error {
  override name = "ManifestError";
}

export interface LoadManifestOptions {
  fetch?: typeof fetch;
  /** Accept an http://localhost manifest, for local development [M6]. */
  allowLocalhost?: boolean;
}

export async function loadManifest(manifestUrl: string, options: LoadManifestOptions = {}): Promise<ProviderManifest> {
  const response = await (options.fetch ?? fetch)(manifestUrl, { redirect: "manual", headers: { Accept: "application/json" } });
  if (response.status !== 200) throw new ManifestError(`the manifest answered ${response.status}; redirects are not followed [M3]`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MANIFEST_MAX_BYTES) throw new ManifestError("the manifest is larger than 256 KiB [M3]");

  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new ManifestError("the manifest is not valid JSON");
  }
  const local = isLocalhost(manifestUrl) && options.allowLocalhost === true;
  // The schema requires https://; a local provider is checked as if it were served over HTTPS.
  const checked = local && isObject(manifest) && typeof manifest["baseUrl"] === "string"
    ? { ...manifest, baseUrl: manifest["baseUrl"].replace(/^http:/, "https:") }
    : manifest;
  if (!validateManifest(checked)) {
    const first = validateManifest.errors?.[0];
    throw new ManifestError(`the manifest does not match the v1 schema: ${first?.instancePath || "/"} ${first?.message ?? ""}`.trim());
  }

  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const violations = checkManifestRules(manifest as ProviderManifest, {
    manifestUrl,
    validateExample: (exampleSchema: JsonObject, value: JsonValue) => ajv.validate(exampleSchema, value) as boolean,
  }).filter((violation) => !(local && violation.rule === "M1"));
  if (violations.length > 0) {
    throw new ManifestError(violations.map((violation) => `[${violation.rule}] ${violation.message}`).join("; "));
  }
  return manifest as ProviderManifest;
}

function isLocalhost(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
