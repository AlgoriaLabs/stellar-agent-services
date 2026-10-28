// provider-kit trustline: lets the payout account (payTo) receive USDC [P2], approved in the wallet that
// holds it, on a local approval page (cli/approval.ts). Clients pay in USDC, and a G... account can't
// receive it without a trustline.
//
// With --config or --manifest it sets up that provider's payTo. On its own it sets up whichever account the
// wallet connects, on --network (testnet by default), and prints it as PAY_TO. A new testnet account gets
// test XLM from Friendbot first. Nothing is signed when the trustline is already there, and a contract
// (C...) payTo needs none. With --source, a key in the Stellar CLI keychain signs instead, for scripts and CI.

import { stellarAddressKind, USDC_ISSUER, type StellarNetwork } from "@stellar-agent-services/protocol";
import { ApprovalError, describeOutcome, type ApprovalPlan } from "./approval.js";
import { explorerUrl, networkName, shortAddress, type OwnerChain } from "./owner-chain.js";
import { accountSteps } from "./owner-steps.js";
import { ownerIo, parseNetwork, quote, UsageError, type CliFlags, type OwnerIo } from "./shared.js";
import { loadTarget } from "./target.js";

export async function trustline(flags: CliFlags, io: OwnerIo = ownerIo(flags)): Promise<number> {
  let network: StellarNetwork;
  let payTo: string | undefined;
  if (flags.config !== undefined || flags.manifest !== undefined) {
    if (flags.network !== undefined) throw new UsageError("--network comes from the provider's manifest: leave it out with --config or --manifest");
    const target = await loadTarget(flags);
    if ("problems" in target) {
      console.error(`The provider would not pass Provider Standard v1 checks:\n${target.problems.map((problem) => `  ✗ ${problem}`).join("\n")}`);
      return 1;
    }
    ({ network, payTo } = target.manifest.payment.accepts[0]);
  } else {
    network = parseNetwork(flags.network ?? "testnet");
  }
  if (payTo !== undefined && stellarAddressKind(payTo) === "contract") {
    console.log(`payTo ${payTo} is a contract: it holds USDC without a trustline. Nothing to sign.`);
    return 0;
  }

  const chain = io.chain(network, flags.rpc);
  if (payTo !== undefined && (await chain.account(payTo)).usdcTrustline) {
    console.log(`✓ ${payTo} already has a USDC trustline on ${network}. Nothing to sign.`);
    return 0;
  }
  if (flags.source !== undefined) return withStellarCli(flags, io, chain, flags.source, payTo);
  if (flags["dry-run"]) {
    console.log(`Dry run. Without --dry-run, a page opens where your wallet adds a USDC trustline on ${network}. Nothing was signed.`);
    return 0;
  }

  let account = payTo ?? "";
  let added = false;
  const plan: ApprovalPlan = {
    command: "provider-kit trustline",
    title: "Get ready to receive USDC",
    intro: "Clients pay your service in USDC. The account they pay needs a USDC trustline to receive it.",
    network,
    ...(payTo === undefined ? {} : { account: { address: payTo, label: "Payout account", reason: "The account the provider's manifest names as payTo: clients pay it." } }),
    outline: [{ id: "trustline", title: "Add USDC" }],
    async steps(address) {
      if (payTo !== undefined && address !== payTo) {
        throw new ApprovalError("Connect your payout account", `Your wallet connected ${shortAddress(address)}. Switch it to ${shortAddress(payTo)}, the manifest's payTo.`, "connect");
      }
      account = address;
      const steps = await accountSteps(chain, address, { trustline: true });
      added = steps.some((step) => step.id === "trustline");
      return steps;
    },
    result: () => ({
      title: "Ready to receive USDC",
      message: added
        ? `This account can now be paid in USDC on ${networkName(network)}.`
        : `This account already had a USDC trustline on ${networkName(network)}, so nothing was signed.`,
      details: [{ label: "Account", value: account, mono: true, href: explorerUrl(network, "account", account) }],
    }),
  };
  const outcome = await io.approve(plan, chain);
  if (outcome.status !== "done") {
    console.log(describeOutcome(outcome));
    return 1;
  }
  console.log(added ? `${account} can now receive USDC on ${network}.` : `${account} already had a USDC trustline on ${network}.`);
  if (payTo === undefined) console.log(`Use it as your payout address: PAY_TO=${account}`);
  return 0;
}

/** --source: the Stellar CLI signs change_trust with a key from its keychain. */
async function withStellarCli(flags: CliFlags, io: OwnerIo, chain: OwnerChain, source: string, payTo: string | undefined): Promise<number> {
  const { network } = chain;
  const cliNetwork = network === "stellar:pubnet" ? "mainnet" : "testnet";
  const args = ["tx", "new", "change-trust", "--source-account", source, "--network", cliNetwork, "--line", `USDC:${USDC_ISSUER[network]}`];
  const stellar = await io.stellar();
  if (flags["dry-run"] || stellar === undefined) {
    console.log(stellar === undefined ? "The Stellar CLI (`stellar`) is not installed: https://developers.stellar.org/docs/tools/cli. Run this once it is:" : "Dry run. This would run:");
    console.log(`  stellar ${args.map(quote).join(" ")}`);
    return stellar === undefined ? 1 : 0;
  }
  const address = (await stellar(["keys", "address", source])).trim();
  if (payTo !== undefined && address !== payTo) {
    console.error(`Key "${source}" is ${address}, not the manifest's payTo ${payTo}. Nothing was signed.`);
    return 1;
  }
  const state = await chain.account(address);
  if (state.usdcTrustline) {
    console.log(`✓ ${address} already has a USDC trustline on ${network}. Nothing to sign.`);
    return 0;
  }
  if (!state.exists) {
    console.error(`${address} doesn't exist on ${network} yet: ${network === "stellar:testnet" ? `stellar keys fund ${source} --network testnet` : "send it some XLM"} first.`);
    return 1;
  }
  console.log(`Signing with "${source}" (${address}) on ${cliNetwork}...`);
  await stellar(args);
  console.log(`${address} can now receive USDC on ${network}.`);
  if (payTo === undefined) console.log(`Use it as your payout address: PAY_TO=${address}`);
  return 0;
}
