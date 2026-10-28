// provider-kit register: puts the provider in the Stellar 8004 identity registry, or updates its
// registration (docs/provider-standard.md §7).
//
// The registration file names the manifest [I1]. It goes on chain as a data: URI when it fits in
// 8 KiB, or as --agent-uri, an HTTPS URL where you host it (--out writes the file).
//
// Who signs:
// - By default the developer's own wallet, on a local approval page (cli/approval.ts). A new agent is
//   registered from the payTo account: the registry makes the registering account the agent's owner and
//   its wallet, so [I3] holds at once. A payTo without a USDC trustline gets one first [P2], and a new
//   testnet account gets test XLM. An update is signed by the agent's owner, or an address it approved.
// - With --source, a key in the Stellar CLI keychain (https://developers.stellar.org/docs/tools/cli), for
//   scripts and CI. With an owner other than payTo, set_agent_wallet needs both the owner's and the payTo
//   account's signatures, so the command is printed for a tool that can collect them.
// This command never sees a secret either way. A new agent's id is saved to the --config file [I2].

import { readFile, rename, writeFile } from "node:fs/promises";
import { stellarAddressKind, type ProviderManifest, type StellarNetwork } from "@stellar-agent-services/protocol";
import { mayActFor, registrationDataUri, registrationFile, registryConfig } from "../registration.js";
import { ApprovalError, describeOutcome, type ApprovalPlan } from "./approval.js";
import { explorerUrl, networkName, shortAddress } from "./owner-chain.js";
import { accountSteps, registerStep } from "./owner-steps.js";
import { ownerIo, quote, UsageError, type CliFlags, type OwnerIo } from "./shared.js";
import { loadTarget } from "./target.js";

interface Registration {
  manifest: ProviderManifest;
  manifestUrl: string;
  network: StellarNetwork;
  payTo: string;
  agentUri: string;
}

/** How signing went: the exit code, and the id of an agent it created. */
interface Signed {
  code: number;
  agentId?: number;
}

export async function register(flags: CliFlags, io: OwnerIo = ownerIo(flags)): Promise<number> {
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

  const registration: Registration = { manifest, manifestUrl, network, payTo, agentUri };
  const signed = flags.source === undefined ? await withWallet(flags, io, registration) : await withStellarCli(flags, io, registration);
  if (signed.agentId !== undefined) await saveNewAgentId(flags, signed.agentId);
  return signed.code;
}

/** The developer's own wallet signs, on the local approval page. */
async function withWallet(flags: CliFlags, io: OwnerIo, { manifest, manifestUrl, network, payTo, agentUri }: Registration): Promise<Signed> {
  const agentId = manifest.provider.agentId;
  if (flags["dry-run"]) {
    const method = agentId === undefined ? "register_with_uri" : "set_agent_uri";
    console.log(`Dry run. Without --dry-run, a page opens where your wallet signs ${method} on ${network}. Nothing was signed.`);
    return { code: 0 };
  }
  if (agentId === undefined && stellarAddressKind(payTo) !== "account") {
    console.error(`payTo ${payTo} is a contract, which can't sign the registration in a wallet. Register with --source <owner key>, then set the agent wallet to payTo [I3].`);
    return { code: 1 };
  }
  const registry = io.registry(network, flags.rpc);
  const chain = io.chain(network, flags.rpc);
  const owner = agentId === undefined ? payTo : await registry.agentOwner(agentId);
  if (owner === undefined) {
    console.error(`Agent ${agentId} does not exist in the ${network} identity registry [I2]. To register a new agent, remove provider.agentId.`);
    return { code: 1 };
  }

  const name = manifest.provider.name;
  const identity = registryConfig(network).contracts.identity;
  let registered: number | undefined;
  const plan: ApprovalPlan = {
    command: "provider-kit register",
    title: agentId === undefined ? "Register your service" : "Update your registration",
    intro:
      agentId === undefined
        ? `Add ${name} to the Stellar 8004 identity registry, so agents can find it and check whom they pay.`
        : `Point agent ${agentId}'s registration at your manifest, ${manifestUrl}.`,
    network,
    account:
      agentId === undefined
        ? { address: payTo, label: "Payout account", reason: "The account your service is paid to (payTo). Registering from it makes it the agent's owner and wallet." }
        : { address: owner, label: "Agent owner", reason: "Only the agent's owner, the address approved for it, or an operator of the owner's can change its registration." },
    outline: [{ id: "register", title: agentId === undefined ? "Register" : "Update registration" }],
    async steps(address) {
      if (agentId === undefined && address !== payTo) {
        throw new ApprovalError(
          "Connect your payout account",
          `Your wallet connected ${shortAddress(address)}. Switch it to ${shortAddress(payTo)}, the manifest's payTo: the account that registers becomes the agent's wallet, which must be payTo [I3].`,
          "connect",
        );
      }
      if (agentId !== undefined && !(await mayActFor(registry, agentId, owner, address))) {
        throw new ApprovalError(
          "This account can't change the registration",
          `Your wallet connected ${shortAddress(address)}. Switch it to agent ${agentId}'s owner, ${shortAddress(owner)}, or an address it approved.`,
          "connect",
        );
      }
      const steps = await accountSteps(chain, address, { trustline: agentId === undefined });
      steps.push(
        registerStep(chain, {
          identity,
          caller: address,
          agentUri,
          manifestUrl,
          providerName: name,
          ...(agentId === undefined ? {} : { agentId }),
          onRegistered: (id) => (registered = id),
        }),
      );
      return steps;
    },
    result() {
      if (registered === undefined) {
        return { title: "Registration updated", message: `Agent ${agentId} now names your manifest. Run provider-kit check to confirm.`, details: [{ label: "Agent", value: String(agentId) }] };
      }
      const next = flags.config === undefined ? "Add the id to your provider's config and restart it" : "provider-kit saves the id to your config: restart the provider";
      return {
        title: "Your service is registered",
        message: `It is agent ${registered} on ${networkName(network)}. ${next}, then run provider-kit check.`,
        details: [
          { label: "Agent", value: String(registered) },
          { label: "Owner and wallet", value: payTo, mono: true, href: explorerUrl(network, "account", payTo) },
        ],
      };
    },
  };

  const outcome = await io.approve(plan, chain);
  if (outcome.status !== "done") {
    console.log(describeOutcome(outcome));
    return { code: 1 };
  }
  if (registered === undefined) {
    console.log(`Updated the registration of agent ${agentId} on ${network}.`);
    return { code: 0 };
  }
  console.log(`Registered agent ${registered} on ${network}.`);
  return { code: 0, agentId: registered };
}

/** --source: the Stellar CLI signs with a key from its keychain. */
async function withStellarCli(flags: CliFlags, io: OwnerIo, { manifest, network, payTo, agentUri }: Registration): Promise<Signed> {
  const source = flags.source!;
  const stellar = await io.stellar();
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
    return { code: stellar ? 0 : 1 };
  }

  console.log(`Signing with "${source}" (${owner}) on ${cliNetwork}...`);
  const stdout = await stellar(write);
  if (agentId !== undefined) {
    console.log(`Updated the registration of agent ${agentId} on ${network}.`);
    walletNote();
    return { code: 0 };
  }
  const id = Number(stdout.trim().replace(/^"|"$/g, ""));
  if (!Number.isInteger(id)) throw new Error(`the registry answered "${stdout.trim()}", not an agent id`);
  console.log(`Registered agent ${id} on ${network}.`);
  walletNote();
  return { code: 0, agentId: id };
}

async function saveNewAgentId(flags: CliFlags, agentId: number): Promise<void> {
  if (flags.config === undefined) {
    console.log(`Next: add "agentId": ${agentId} to "provider" in your provider's config (AGENT_ID for the example) [I2], restart it, then run provider-kit check.`);
    return;
  }
  if (await saveAgentId(flags.config, agentId)) console.log(`Saved "agentId": ${agentId} to ${flags.config} [I2].`);
  else console.log(`${flags.config} reads provider.agentId from the environment: set it to ${agentId} [I2].`);
  console.log("Next: restart the provider, then run provider-kit check.");
}

/**
 * Writes `agentId` into a gateway config's provider object, keeping the rest of the file as it was: its keys,
 * their order and its indentation. False, and nothing written, when the file reads provider.agentId from the
 * environment.
 */
export async function saveAgentId(path: string, agentId: number): Promise<boolean> {
  const text = await readFile(path, "utf8");
  const config = JSON.parse(text) as { provider?: unknown };
  const provider = config.provider;
  if (typeof provider !== "object" || provider === null || Array.isArray(provider)) throw new Error(`${path} has no "provider" object`);
  if (typeof (provider as Record<string, unknown>)["agentId"] === "string") return false;
  (provider as Record<string, unknown>)["agentId"] = agentId;
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2;
  // Written beside the file, then renamed over it, so an interrupted write never leaves half a config.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, indent)}\n`);
  await rename(temporary, path);
  return true;
}
