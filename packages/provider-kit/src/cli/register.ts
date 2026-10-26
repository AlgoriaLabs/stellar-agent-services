// provider-kit register: puts the provider in the Stellar 8004 identity registry, or updates its
// registration (docs/provider-standard.md §7).
//
// The registration file names the manifest [I1]. It goes on chain as a data: URI when it fits in
// 8 KiB, or as --agent-uri, an HTTPS URL where you host it (--out writes the file). The Stellar CLI
// (https://developers.stellar.org/docs/tools/cli) signs with a key from its keychain (--source):
// this command never sees a secret.
//
// The registry makes a new agent's wallet its owner. Register with the payTo account as --source and
// [I3] holds at once. With another owner, set_agent_wallet needs both the owner's and the payTo
// account's signatures, so the command is printed for a tool that can collect them.

import { writeFile } from "node:fs/promises";
import { registrationDataUri, registrationFile, registryConfig } from "../registration.js";
import { findStellarCli, quote, UsageError, type CliFlags } from "./shared.js";
import { loadTarget } from "./target.js";

export async function register(flags: CliFlags): Promise<number> {
  const source = flags.source;
  if (source === undefined) throw new UsageError("register needs --source <the name of a key in the Stellar CLI keychain>");
  const target = await loadTarget(flags);
  if ("problems" in target) {
    console.error(`The provider would not pass Provider Standard v1 checks, so it is not registered:\n${target.problems.map((problem) => `  ✗ ${problem}`).join("\n")}`);
    return 1;
  }
  const { manifest, manifestUrl } = target;
  const { network, payTo } = manifest.payment.accepts[0];
  if (manifestUrl.startsWith("http://")) throw new Error("a dev-mode provider (http://localhost) can't be registered: deploy it on HTTPS first");

  const file = registrationFile(manifest, manifestUrl);
  if (flags.out !== undefined) await writeFile(flags.out, `${JSON.stringify(file, null, 2)}\n`);
  let agentUri = flags["agent-uri"];
  if (agentUri === undefined) {
    try {
      agentUri = registrationDataUri(file);
    } catch {
      throw new Error("the registration file is over 8 KiB: host it at an HTTPS URL (--out writes it) and pass --agent-uri <url>");
    }
  } else if (!agentUri.startsWith("https://")) {
    throw new UsageError("--agent-uri must be an https:// URL");
  }
  console.log(`Registration file [I1]:\n${JSON.stringify(file, null, 2)}\n`);

  const stellar = await findStellarCli();
  const owner = stellar ? (await stellar(["keys", "address", source])).trim() : `$(stellar keys address ${source})`;
  const contracts = registryConfig(network).contracts;
  const cliNetwork = flags.network ?? (network === "stellar:pubnet" ? "mainnet" : "testnet");
  const invoke = (fn: string, args: string[]) => ["contract", "invoke", "--id", contracts.identity, "--source-account", source, "--network", cliNetwork, "--", fn, ...args];

  const agentId = manifest.provider.agentId;
  const write =
    agentId === undefined
      ? invoke("register_with_uri", ["--caller", owner, "--agent_uri", agentUri])
      : invoke("set_agent_uri", ["--caller", owner, "--agent_id", String(agentId), "--new_uri", agentUri]);
  const walletNote = () => {
    if (owner === payTo) return;
    console.log(`\nThe agent wallet must be payTo (${payTo}) [I3]. Setting it needs the owner's and payTo's signatures:`);
    console.log(`  stellar ${invoke("set_agent_wallet", ["--caller", owner, "--agent_id", String(agentId ?? "<agent id>"), "--new_wallet", payTo]).map(quote).join(" ")}`);
    console.log("Registering with the payTo account as --source avoids this step.");
  };

  if (flags["dry-run"] || !stellar) {
    if (!stellar) console.log("The Stellar CLI (`stellar`) is not installed: https://developers.stellar.org/docs/tools/cli. Run this once it is:");
    else console.log("Dry run. This would run:");
    console.log(`  stellar ${write.map(quote).join(" ")}`);
    walletNote();
    return stellar ? 0 : 1;
  }

  console.log(`Signing with "${source}" (${owner}) on ${cliNetwork}...`);
  const stdout = await stellar(write);
  if (agentId === undefined) {
    const id = Number(stdout.trim().replace(/^"|"$/g, ""));
    if (!Number.isInteger(id)) throw new Error(`the registry answered "${stdout.trim()}", not an agent id`);
    console.log(`Registered agent ${id} on ${network}.`);
    console.log(`Next: add "agentId": ${id} to "provider" in your config [I2], restart, then run provider-kit check.`);
  } else {
    console.log(`Updated the registration of agent ${agentId} on ${network}.`);
  }
  walletNote();
  return 0;
}
