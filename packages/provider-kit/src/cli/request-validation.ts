// provider-kit request-validation: asks a verifier to check the provider, with validation_request in the
// Stellar 8004 Validation Registry (docs/verification.md).
//
// prepareValidationRequest() runs first, so nothing is signed for a provider a verifier couldn't validate,
// an account that may not ask for the agent, or a validator that is the provider itself. The request
// document goes on chain as a data: URI.
//
// Who signs: by default the agent owner's own wallet, on a local approval page (cli/approval.ts). The account
// the wallet connects is checked as the signer before anything is built. With --source, a key in the
// Stellar CLI keychain (https://developers.stellar.org/docs/tools/cli), for scripts and CI. This command
// never sees a secret either way. Afterwards it reads the registry back to confirm the request landed, and
// prints the request hash, which the verifier's answer names.

import { writeFile } from "node:fs/promises";
import { stellarAddressKind, validationRequestBytes, type ProviderManifest, type StellarNetwork } from "@stellar-agent-services/protocol";
import type { RegistryReader } from "../registration.js";
import { prepareValidationRequest, validationRequestArguments, ValidationRequestError, type PreparedValidationRequest } from "../validation-request.js";
import { ApprovalError, describeOutcome, type ApprovalPlan } from "./approval.js";
import { explorerUrl } from "./owner-chain.js";
import { accountSteps, validationRequestStep } from "./owner-steps.js";
import { ownerIo, quote, UsageError, type CliFlags, type OwnerIo } from "./shared.js";
import { loadTarget } from "./target.js";

/** Where the command reaches the outside world. Tests replace it. */
export type RequestValidationIo = OwnerIo;

interface Request {
  manifest: ProviderManifest;
  manifestUrl: string;
  validator: string;
  network: StellarNetwork;
  registry: RegistryReader;
}

export async function requestValidation(flags: CliFlags, io: RequestValidationIo = ownerIo(flags)): Promise<number> {
  const { source, validator } = flags;
  if (validator === undefined) throw new UsageError("request-validation needs --validator <the verifier's G... address>");
  if (stellarAddressKind(validator) !== "account") throw new UsageError("--validator must be a G... account address");
  const target = await loadTarget(flags);
  if ("problems" in target) {
    console.error(`The provider would not pass Provider Standard v1 checks, so no validation is requested:\n${target.problems.map((problem) => `  ✗ ${problem}`).join("\n")}`);
    return 1;
  }
  const { manifest, manifestUrl } = target;
  const network = manifest.payment.accepts[0].network;
  const request: Request = { manifest, manifestUrl, validator, network, registry: io.registry(network, flags.rpc) };
  return source === undefined ? withWallet(flags, io, request) : withStellarCli(flags, io, request, source);
}

/** The agent owner's own wallet signs, on the local approval page. */
async function withWallet(flags: CliFlags, io: OwnerIo, { manifest, manifestUrl, validator, network, registry }: Request): Promise<number> {
  // One time for the request: checking it again with the wallet's account as the signer gives the same bytes and hash.
  const now = io.now();
  const prepared = await prepareValidationRequest(manifest, manifestUrl, { validator, registry, now: () => now });
  printRequest(prepared);
  if (flags["dry-run"]) {
    console.log(`\nDry run. Without --dry-run, a page opens where the agent owner's wallet signs validation_request on ${network}. Nothing was signed.`);
    return 0;
  }
  const { agentId } = prepared.request;
  const owner = await registry.agentOwner(agentId);
  const chain = io.chain(network, flags.rpc);
  const plan: ApprovalPlan = {
    command: "provider-kit request-validation",
    title: "Request validation",
    intro: `Ask a verifier to check ${manifest.provider.name}. Its answer goes on chain in the Stellar 8004 Validation Registry, and its receipt gives your badges.`,
    network,
    ...(owner === undefined
      ? {}
      : { account: { address: owner, label: "Agent owner", reason: "The registry takes a request only from the agent's owner, the address approved for it, or an operator of the owner's." } }),
    outline: [{ id: "request-validation", title: "Request validation" }],
    async steps(address) {
      try {
        await prepareValidationRequest(manifest, manifestUrl, { validator, registry, signer: address, now: () => now });
      } catch (error) {
        if (error instanceof ValidationRequestError) throw new ApprovalError("This account can't ask for validation", error.problems.join(" "), "connect");
        throw error;
      }
      const steps = await accountSteps(chain, address, { trustline: false });
      steps.push(validationRequestStep(chain, address, prepared));
      return steps;
    },
    result: () => ({
      title: "Validation requested",
      message: "Give the verifier your manifest URL and this request hash. Its answer names the hash.",
      details: [
        { label: "Request hash", value: prepared.requestHash, mono: true },
        { label: "Verifier", value: validator, mono: true, href: explorerUrl(network, "account", validator) },
        { label: "Agent", value: String(agentId) },
      ],
    }),
  };
  const outcome = await io.approve(plan, chain);
  if (outcome.status !== "done") {
    console.log(describeOutcome(outcome));
    return 1;
  }
  return confirm(flags, registry, prepared, network);
}

/** --source: the Stellar CLI signs with a key from its keychain. */
async function withStellarCli(flags: CliFlags, io: OwnerIo, { manifest, manifestUrl, validator, network, registry }: Request, source: string): Promise<number> {
  const cliNetwork = flags.network ?? (network === "stellar:pubnet" ? "mainnet" : "testnet");
  // The registry checks who asks by the signing key's address. Without the Stellar CLI it stays unknown,
  // and the command is printed for later.
  const stellar = await io.stellar();
  let signer: string | undefined;
  try {
    signer = stellar === undefined ? undefined : (await stellar(["keys", "address", source])).trim();
  } catch {
    signer = undefined;
  }

  const prepared = await prepareValidationRequest(manifest, manifestUrl, { validator, registry, now: () => io.now(), ...(signer === undefined ? {} : { signer }) });
  printRequest(prepared);

  const args = validationRequestArguments(prepared, { source, network: cliNetwork, caller: signer ?? `$(stellar keys address ${source})` });
  const command = `stellar ${args.map(quote).join(" ")}`;
  if (stellar === undefined || signer === undefined) {
    console.log(
      stellar === undefined
        ? "\nThe Stellar CLI (`stellar`) is not installed: https://developers.stellar.org/docs/tools/cli. Run this once it is:"
        : `\nThe Stellar CLI could not read key "${source}". Once it can, run:`,
    );
    console.log(`  ${command}`);
    return 1;
  }
  if (flags["dry-run"]) {
    console.log(`\nDry run. This would run:\n  ${command}`);
    return 0;
  }

  console.log(`\nSigning with "${source}" (${signer}) on ${cliNetwork}...`);
  await stellar(args);
  return confirm(flags, registry, prepared, network);
}

function printRequest(prepared: PreparedValidationRequest): void {
  console.log(`Validation request:\n${JSON.stringify(prepared.request, null, 2)}\n`);
  console.log(`  request_hash  ${prepared.requestHash}`);
  console.log(`  request_uri   a data: URI holding the request itself (${prepared.requestUri.length} characters)`);
}

/** After sending: writes --out, then reads the registry back before telling the developer what's next. */
async function confirm(flags: CliFlags, registry: RegistryReader, prepared: PreparedValidationRequest, network: StellarNetwork): Promise<number> {
  const { request, requestHash } = prepared;
  if (flags.out !== undefined) await writeFile(flags.out, validationRequestBytes(request));
  const record = await registry.validation(requestHash);
  if (record?.agentId !== request.agentId || record.validator !== request.validator) {
    console.log("Sent, but the registry does not show the request yet. Look its hash up again before sending another.");
    return 1;
  }
  console.log(`Requested: agent ${request.agentId} asks ${request.validator} for validation on ${network}.`);
  if (flags.out !== undefined) console.log(`The request document is in ${flags.out}.`);
  console.log(`Next: give the verifier your manifest URL and the request hash. Its answer names the hash:`);
  console.log(`  verifier publish <receipt.json> --request-hash ${requestHash} --response-uri <https url> --source <its key>`);
  return 0;
}
