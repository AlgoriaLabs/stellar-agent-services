// provider-kit request-validation: asks a verifier to check the provider, with validation_request in the
// Stellar 8004 Validation Registry (docs/verification.md).
//
// prepareValidationRequest() runs first, so nothing is signed for a provider a verifier couldn't validate,
// a key that may not ask for the agent, or a validator that is the provider itself. The request document
// goes on chain as a data: URI. The Stellar CLI (https://developers.stellar.org/docs/tools/cli) signs with
// a key from its keychain (--source): this command never sees a secret. Afterwards it reads the registry
// back to confirm the request landed, and prints the request hash, which the verifier's answer names.

import { writeFile } from "node:fs/promises";
import { stellarAddressKind, validationRequestBytes, type StellarNetwork } from "@stellar-agent-services/protocol";
import { rpcRegistry, type RegistryReader } from "../registration.js";
import { prepareValidationRequest, validationRequestArguments } from "../validation-request.js";
import { findStellarCli, quote, UsageError, type CliFlags, type StellarCli } from "./shared.js";
import { loadTarget } from "./target.js";

/** Where the command reaches the outside world. Tests replace it. */
export interface RequestValidationIo {
  /** The Stellar CLI, or undefined when it is not installed. */
  stellar(): Promise<StellarCli | undefined>;
  registry(network: StellarNetwork, rpcUrl?: string): RegistryReader;
  now(): Date;
}

const PROCESS_IO: RequestValidationIo = { stellar: findStellarCli, registry: rpcRegistry, now: () => new Date() };

export async function requestValidation(flags: CliFlags, io: RequestValidationIo = PROCESS_IO): Promise<number> {
  const { source, validator } = flags;
  if (source === undefined || validator === undefined) {
    throw new UsageError("request-validation needs --validator <the verifier's G... address> and --source <the name of a key in the Stellar CLI keychain>");
  }
  if (stellarAddressKind(validator) !== "account") throw new UsageError("--validator must be a G... account address");
  const target = await loadTarget(flags);
  if ("problems" in target) {
    console.error(`The provider would not pass Provider Standard v1 checks, so no validation is requested:\n${target.problems.map((problem) => `  ✗ ${problem}`).join("\n")}`);
    return 1;
  }
  const { manifest, manifestUrl } = target;
  const network = manifest.payment.accepts[0].network;
  const cliNetwork = flags.network ?? (network === "stellar:pubnet" ? "mainnet" : "testnet");
  const registry = io.registry(network, flags.rpc);

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
  console.log(`Validation request:\n${JSON.stringify(prepared.request, null, 2)}\n`);
  console.log(`  request_hash  ${prepared.requestHash}`);
  console.log(`  request_uri   a data: URI holding the request itself (${prepared.requestUri.length} characters)`);

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
  if (flags.out !== undefined) await writeFile(flags.out, validationRequestBytes(prepared.request));
  const record = await registry.validation(prepared.requestHash);
  if (record?.agentId !== prepared.request.agentId || record.validator !== validator) {
    console.log("Sent, but the registry does not show the request yet. Look its hash up again before sending another.");
    return 1;
  }
  console.log(`Requested: agent ${prepared.request.agentId} asks ${validator} for validation on ${network}.`);
  if (flags.out !== undefined) console.log(`The request document is in ${flags.out}.`);
  console.log(`Next: give the verifier your manifest URL and the request hash. Its answer names the hash:`);
  console.log(`  verifier publish <receipt.json> --request-hash ${prepared.requestHash} --response-uri <https url> --source <its key>`);
  return 0;
}
