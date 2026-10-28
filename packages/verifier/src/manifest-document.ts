// checkManifestDocument(): C1 on a manifest that is not served yet, such as one a provider or a coding
// agent is still writing.
//
// The document goes through the same code as C1 (docs/provider-standard.md §2.4), served from memory
// with the headers a conforming provider sends, so the result can't drift from what `verifier check`
// reports. What depends on the real server is not checked here: the HTTP status, Content-Type and
// redirects [M1], [M3], and Cache-Control [M4]. Run `verifier check` on the served manifest for those.

import { DEFAULT_MANIFEST_PATH, type CheckResult } from "@stellar-agent-services/protocol";
import { checkManifest } from "./checks/manifest.js";
import type { RunContext } from "./context.js";
import { httpClient } from "./http.js";
import { isObject } from "./json.js";

export interface ManifestDocumentOptions {
  /** Where the manifest will be served. Default: DEFAULT_MANIFEST_PATH on the origin of its baseUrl. */
  manifestUrl?: string;
  /** Development mode: accept a manifest for a loopback http:// provider [M6]. */
  dev?: boolean;
}

/** Runs C1 on a manifest document: its JSON text, so duplicate keys are found [M3], or a parsed value. */
export async function checkManifestDocument(document: unknown, options: ManifestDocumentOptions = {}): Promise<CheckResult> {
  const text = typeof document === "string" ? document : JSON.stringify(document);
  const manifestUrl = options.manifestUrl ?? defaultManifestUrl(text);
  const served: typeof fetch = async () =>
    new Response(text, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } });
  const ctx: RunContext = {
    manifestUrl,
    dev: options.dev ?? false,
    http: httpClient(served),
    sleep: async () => {},
    now: Date.now,
    service: undefined,
    input: undefined,
    burstSize: 0,
    payer: undefined,
    manifest: undefined,
    manifestSha256: undefined,
    usable: false,
    conformant: false,
    chain: undefined,
    registry: undefined,
    wallet: undefined,
    inputs: new Map(),
    target: undefined,
    challenges: new Map(),
    paidJob: undefined,
    payment: undefined,
    transactions: new Map(),
  };
  return checkManifest(ctx);
}

/** DEFAULT_MANIFEST_PATH on the baseUrl's origin; a placeholder when there is no usable baseUrl, which C1 then reports. */
function defaultManifestUrl(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const baseUrl = isObject(parsed) ? parsed["baseUrl"] : undefined;
    if (typeof baseUrl === "string") return new URL(DEFAULT_MANIFEST_PATH, baseUrl).href;
  } catch {
    // Not JSON: C1 reports it.
  }
  return `https://provider.invalid${DEFAULT_MANIFEST_PATH}`;
}
