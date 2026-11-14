// C6's third probe: the discovery documents a provider may serve next to its manifest
// (docs/provider-standard.md §2.5).
//
//   /openapi.json   where it gives a price for a service's create-job operation, the price is the
//                   manifest's, and the protocols include x402 [D3]
//   /llms.txt       gives the manifest URL [D5]
//   both            served like the manifest: the media type, Cache-Control max-age of 300 s or less
//                   and Access-Control-Allow-Origin: * [D4]
//
// Both are optional [D1]. A missing document, and one about something else (an origin's own API, a
// site's llms.txt that never mentions the manifest), are not the provider's discovery documents: only
// [D5] says anything about them. The answers are kept like every other exchange, so C6 also looks
// through them for secrets.

import { checkOpenApiDocument, discoveryDocumentUrls, findCreateJobOperations, type JsonObject } from "@stellar-agent-services/protocol";
import type { Recorder, RunContext } from "../context.js";
import { jsonBody, type Exchange } from "../http.js";
import { cacheLifetime, mediaType } from "./manifest.js";

/** An OpenAPI document repeats the manifest's schemas (at most 256 KiB [M3]) and adds its own. */
const OPENAPI_MAX_BYTES = 4 * 1024 * 1024;

export async function probeDiscoveryDocuments(ctx: RunContext, recorder: Recorder): Promise<void> {
  const manifest = ctx.manifest;
  if (manifest === undefined || !ctx.usable) return;
  const urls = discoveryDocumentUrls(ctx.manifestUrl);
  const evidence: JsonObject = {};

  const openapi = await ctx.http.request("C6", { method: "GET", url: urls.openapi, headers: { Accept: "application/json" }, maxBytes: OPENAPI_MAX_BYTES });
  evidence["openapi"] = { status: openapi.status ?? null };
  const document = openapi.status === 200 ? jsonBody(openapi) : undefined;
  const operations = document === undefined ? [] : findCreateJobOperations(manifest, document, { documentUrl: urls.openapi });
  if (operations.length > 0) {
    evidence["openapi"] = { status: 200, services: operations.map(({ service }) => service.name) };
    for (const violation of checkOpenApiDocument(manifest, document, { documentUrl: urls.openapi })) {
      recorder.fail(violation.rule, `/openapi.json ${violation.pointer}: ${violation.message}`);
    }
    served(openapi, "/openapi.json", "application/json", recorder);
  }

  const llms = await ctx.http.request("C6", { method: "GET", url: urls.llmsTxt, headers: { Accept: "text/plain" } });
  evidence["llmsTxt"] = { status: llms.status ?? null };
  if (llms.status === 200 && llms.error === undefined) {
    const linked = llms.text.includes(ctx.manifestUrl);
    evidence["llmsTxt"] = { status: 200, manifest: linked };
    if (linked) served(llms, "/llms.txt", "text/plain", recorder);
    else recorder.warn("D5", "/llms.txt does not give the manifest URL; a reader can't reach the source of truth from it");
  }
  recorder.evidence["discovery"] = evidence;
}

/** [D4]: a discovery document is served like the manifest. */
function served(exchange: Exchange, name: string, expected: string, recorder: Recorder): void {
  if (mediaType(exchange.headers.get("Content-Type")) !== expected) recorder.warn("D4", `${name} should be served as ${expected}`);
  const maxAge = cacheLifetime(exchange.headers.get("Cache-Control"));
  if (maxAge === undefined || maxAge > 300) recorder.warn("D4", `${name} should carry Cache-Control: max-age of 300 or less, like the manifest`);
  if (exchange.headers.get("Access-Control-Allow-Origin") !== "*") recorder.warn("D4", `${name} should carry Access-Control-Allow-Origin: *`);
}
