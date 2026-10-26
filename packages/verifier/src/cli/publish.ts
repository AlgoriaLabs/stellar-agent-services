// verifier publish: answers a validation request with a receipt, in the Stellar 8004 Validation Registry.
//
// checkPublication() runs first, so nothing is signed for a stale receipt, someone else's request, or a
// response_uri that doesn't serve the receipt. The Stellar CLI (https://developers.stellar.org/docs/tools/cli)
// signs with a key from its keychain (--source), which must be the receipt's validator: this command never
// sees the key. Afterwards it reads the registry back to confirm the response landed.

import { anchorProblems, checkPublication, DEFAULT_MAX_AGE_SECONDS, invokeArguments } from "../publish.js";
import { readReceipt } from "../receipt.js";
import { rpcRegistry } from "../registry.js";
import { quote, UsageError, type CliFlags, type Io } from "./shared.js";

export async function publish(path: string, flags: CliFlags, io: Io): Promise<number> {
  for (const flag of ["pay", "service", "input", "validator", "out", "max-price", "max-spend", "dev", "json"] as const) {
    if (flags[flag] !== undefined) throw new UsageError(`--${flag} does not apply to publish`);
  }
  const requestHash = flags["request-hash"];
  const responseUri = flags["response-uri"];
  const source = flags.source;
  if (requestHash === undefined || responseUri === undefined || source === undefined) {
    throw new UsageError("publish needs --request-hash, --response-uri and --source (a key in the Stellar CLI keychain)");
  }
  let maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS;
  if (flags["max-age"] !== undefined) {
    const hours = Number(flags["max-age"]);
    if (!Number.isFinite(hours) || hours <= 0) throw new UsageError("--max-age must be a number of hours above zero");
    maxAgeSeconds = Math.round(hours * 3600);
  }

  const { receipt } = await readReceipt(path);
  const registry = io.registry ?? rpcRegistry(receipt.network, flags.rpc);
  const publication = await checkPublication(receipt, {
    requestHash,
    responseUri,
    registry,
    maxAgeSeconds,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
  const network = flags.network ?? (receipt.network === "stellar:pubnet" ? "mainnet" : "testnet");
  const args = invokeArguments(publication, { source, network });
  io.out(`Validation response for agent ${publication.agentId} on ${publication.network}:`);
  io.out(`  request        ${publication.requestHash}`);
  io.out(`  response       ${publication.response} (level ${receipt.level}), tag ${publication.tag}`);
  io.out(`  response_uri   ${publication.responseUri}`);
  io.out(`  response_hash  ${publication.responseHash}`);
  if (publication.updates) io.out("The request already has a response from this validator; this one replaces it.");
  const command = `stellar ${args.map(quote).join(" ")}`;

  const stellar = io.stellar;
  let address: string | undefined;
  try {
    address = stellar === undefined ? undefined : (await stellar(["keys", "address", source])).trim();
  } catch {
    address = undefined;
  }
  if (address === undefined) {
    io.out(`The Stellar CLI could not read key "${source}" (https://developers.stellar.org/docs/tools/cli). Once it can, run:`);
    io.out(`  ${command}`);
    return flags["dry-run"] ? 0 : 1;
  }
  if (address !== receipt.validator) throw new Error(`key "${source}" is ${address}, but the receipt's validator is ${receipt.validator}`);
  if (flags["dry-run"]) {
    io.out(`Dry run. This would run:\n  ${command}`);
    return 0;
  }

  io.out(`Signing with "${source}" (${address})...`);
  await stellar!(args);
  const problems = anchorProblems(await registry.validation(publication.requestHash), receipt, publication.responseHash);
  if (problems.length > 0) {
    io.out(`Sent, but the registry does not show the response yet: ${problems.join("; ")}`);
    return 1;
  }
  io.out(`Published. Badges: verifier badge ${path} --request-hash ${publication.requestHash}`);
  return 0;
}
