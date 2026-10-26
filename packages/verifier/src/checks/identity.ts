// C2 Identity (docs/provider-standard.md §7): the Stellar 8004 registration authenticates the manifest
// without a signature.
//
//   [I1] The registration file lists { name: "stellar-agent-services", endpoint: <manifest URL>,
//        version: "1" }. It SHOULD also list { name: "web", endpoint: <baseUrl> } and set x402: true.
//   [I2] provider.agentId is that registration's id: the agent exists, and its file lists this manifest.
//   [I3] payTo equals the agent's wallet, get_agent_wallet(agentId).
//
// Reads only: the identity registry, and the registration file from a data: or https: agent URI. HTTPS
// proves the file's origin, so an http: one fails. Skipped without an agentId, in development mode (a
// loopback provider can't be registered), and when the registry or an IPFS file can't be read.

import { canonicalSha256, type CheckResult } from "@stellar-agent-services/protocol";
import { isLoopback } from "../chain.js";
import { Recorder, skipped, type RunContext } from "../context.js";
import { answered } from "../http.js";
import { shown } from "../jobs.js";
import { isObject } from "../json.js";

const REGISTRATION_SERVICE = "stellar-agent-services";
const REGISTRATION_MAX_BYTES = 64 * 1024;

export async function checkIdentity(ctx: RunContext): Promise<CheckResult> {
  const manifest = ctx.manifest;
  if (manifest === undefined || !ctx.usable) return skipped("C2", "the manifest could not be used (C1)");
  if (ctx.dev && isLoopback(new URL(ctx.manifestUrl).hostname)) return skipped("C2", "development mode: a loopback provider can't be registered");
  const agentId = manifest.provider.agentId;
  if (agentId === undefined) return skipped("C2", "the manifest has no provider.agentId: the provider is not registered");
  const registry = ctx.registry;
  if (registry === undefined) return skipped("C2", "no Stellar 8004 registry can be read for this network");

  const recorder = new Recorder("C2");
  const { network, payTo } = manifest.payment.accepts[0];
  recorder.evidence["agentId"] = agentId;
  recorder.evidence["registry"] = registry.contracts.identity;

  let uri: string | undefined;
  try {
    uri = await registry.agentUri(agentId);
  } catch (error) {
    recorder.inconclusive(`the identity registry could not be read: ${(error as Error).message}`);
    return recorder.result();
  }
  if (uri === undefined) {
    recorder.fail("I2", `agent ${agentId} does not exist in the ${network} identity registry`);
    return recorder.result();
  }

  const file = await readRegistration(ctx, uri, recorder);
  if (file !== undefined) {
    try {
      recorder.evidence["registrationSha256"] = await canonicalSha256(file);
    } catch {
      // Not I-JSON, so it has no canonical hash; the checks below still read it.
    }
    const services = Array.isArray(file["services"]) ? file["services"].filter(isObject) : [];
    const entry = services.find((service) => service["name"] === REGISTRATION_SERVICE && service["endpoint"] === ctx.manifestUrl);
    if (entry === undefined) {
      recorder.fail("I1", `the registration of agent ${agentId} does not list { name: "${REGISTRATION_SERVICE}", endpoint: <this manifest URL> }`);
    } else if (entry["version"] !== "1") {
      recorder.fail("I1", `the registration lists the manifest with version ${shown(entry["version"])}, not "1"`);
    }
    if (!services.some((service) => service["name"] === "web" && service["endpoint"] === manifest.baseUrl)) {
      recorder.warn("I1", `the registration should also list { name: "web", endpoint: <baseUrl> }`);
    }
    if (file["x402"] !== true) recorder.warn("I1", "the registration should set x402: true");
  }

  let wallet: string | undefined;
  try {
    wallet = await registry.agentWallet(agentId);
  } catch (error) {
    recorder.inconclusive(`the agent's wallet could not be read: ${(error as Error).message}`);
    return recorder.result();
  }
  recorder.evidence["wallet"] = wallet ?? null;
  if (wallet !== payTo) recorder.fail("I3", `the agent's wallet is ${wallet ?? "not set"}, but the manifest's payTo is ${payTo}`);
  return recorder.result();
}

/** The registration file behind an agent URI, or undefined with what went wrong recorded. */
async function readRegistration(ctx: RunContext, uri: string, recorder: Recorder): Promise<Record<string, unknown> | undefined> {
  let text: string;
  if (uri.startsWith("data:")) {
    const data = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(uri);
    if (data === null) {
      recorder.fail("I1", "the agent URI is a data: URI that is not application/json");
      return undefined;
    }
    recorder.evidence["agentUri"] = "data:";
    try {
      text = data[1] === undefined ? decodeURIComponent(data[2]!) : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(data[2]!, "base64"));
    } catch {
      recorder.fail("I1", "the agent URI's data can't be decoded");
      return undefined;
    }
  } else if (uri.startsWith("https://")) {
    recorder.evidence["agentUri"] = uri.length <= 300 ? uri : "https:";
    const exchange = await ctx.http.request("C2", { method: "GET", url: uri, headers: { Accept: "application/json" }, maxBytes: REGISTRATION_MAX_BYTES, external: true });
    if (exchange.error !== undefined || exchange.status !== 200) {
      recorder.fail("I1", `the registration file at the agent URI ${answered(exchange)}`);
      return undefined;
    }
    text = exchange.text;
  } else if (uri.startsWith("ipfs://")) {
    recorder.inconclusive("the registration file is on IPFS, which this verifier does not read yet: register a data: or https: agent URI");
    return undefined;
  } else {
    recorder.fail("I1", "the agent URI is neither data: nor https:, so the registration file's origin can't be trusted");
    return undefined;
  }

  try {
    const file: unknown = JSON.parse(text);
    if (isObject(file)) return file;
  } catch {
    // Reported below.
  }
  recorder.fail("I1", "the registration file is not a JSON object");
  return undefined;
}
