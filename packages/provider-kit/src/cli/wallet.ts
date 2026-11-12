// provider-kit wallet: managing a local wallet, the account `--local-wallet` made and signs with
// (cli/local-wallet.ts, cli/wallet-store.ts).
//
//   provider-kit wallet [show] [--network <testnet|mainnet>] [--json]
//       The local wallets on this computer: address, project, where the key is kept, and what each holds.
//   provider-kit wallet withdraw --to <G...> --network <testnet|mainnet> [--amount <n>] [--asset usdc|xlm]
//                                [--memo <text>] [--wallet <G...>] [--yes]
//       Moves income out: USDC (all of it, unless --amount) or XLM (--amount) to an account of yours. It shows the
//       exact payment and asks first; --yes pays without asking. The network is always named: money never moves on
//       a network by default.
//   provider-kit wallet export [--wallet <G...>]
//       Shows the secret key, to import the account into a wallet app (Freighter, xBull, Lobstr...) and manage it
//       there. Only for a person at a terminal: it is refused when the output is piped or a script runs it, and
//       nothing else in provider-kit ever prints a key.
//
// Which wallet: --wallet, else this project's, else the only one. A payment whose fate is unknown is reported as
// unknown, never as failed, so nobody sends it twice.

import { createInterface } from "node:readline/promises";
import { stellarAddressKind, type StellarNetwork } from "@stellar-agent-services/protocol";
import { explorerUrl, formatUsdc, formatXlm, networkName, rpcOwnerChain, type AccountState, type OwnerChain } from "./owner-chain.js";
import { parseNetwork, UsageError, type CliFlags } from "./shared.js";
import { walletStore, type WalletRecord, type WalletStore } from "./wallet-store.js";

/** Where `wallet` reaches the outside world. Tests replace it. */
export interface WalletIo {
  wallets: WalletStore;
  chain(network: StellarNetwork, rpcUrl?: string): OwnerChain;
  log(line: string): void;
  /** Whether a person is at the terminal: both its input and its output. */
  interactive: boolean;
  /** Asks a question and returns the answer, or undefined when the person left. */
  ask(question: string): Promise<string | undefined>;
  /** The project directory. */
  project: string;
}

export function walletIo(): WalletIo {
  return {
    wallets: walletStore(),
    chain: rpcOwnerChain,
    log: (line) => console.log(line),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    async ask(question) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise<string | undefined>((resolve) => {
          readline.once("SIGINT", () => resolve(undefined));
          readline.question(question).then(resolve, () => resolve(undefined));
        });
      } finally {
        readline.close();
      }
    },
    project: process.cwd(),
  };
}

export async function wallet(flags: CliFlags, args: string[], io: WalletIo = walletIo()): Promise<number> {
  const [action = "show", ...rest] = args;
  if (rest.length > 0) throw new UsageError(`wallet ${action} takes no more arguments`);
  switch (action) {
    case "show":
      return show(flags, io);
    case "withdraw":
      return withdraw(flags, io);
    case "export":
      return exportKey(flags, io);
    default:
      throw new UsageError(`wallet takes show, withdraw or export, not "${action}"`);
  }
}

const NETWORKS: StellarNetwork[] = ["stellar:testnet", "stellar:pubnet"];

async function show(flags: CliFlags, io: WalletIo): Promise<number> {
  const records = await io.wallets.list();
  const networks = flags.network === undefined ? NETWORKS : [parseNetwork(flags.network)];
  const held = await Promise.all(
    records.map(async (record) => ({
      record,
      // An RPC that doesn't answer leaves the balance unknown: never "empty".
      balances: await Promise.all(networks.map(async (network) => ({ network, state: await io.chain(network, flags.rpc).account(record.address).catch(() => undefined) }))),
    })),
  );
  if (flags.json) {
    const wallets = held.map(({ record, balances }) => ({
      address: record.address,
      created: record.created,
      project: record.project,
      keptIn: record.keptIn,
      thisProject: record.project === io.project,
      balances: Object.fromEntries(
        balances.map(({ network, state }) => [
          network,
          state === undefined ? null : { exists: state.exists, usdcTrustline: state.usdcTrustline, xlm: state.xlm === undefined ? null : formatXlm(state.xlm), usdc: state.usdc === undefined ? null : formatUsdc(state.usdc) },
        ]),
      ),
    }));
    io.log(JSON.stringify({ wallets }, null, 2));
    return 0;
  }
  if (records.length === 0) {
    io.log("No local wallet on this computer. provider-kit launch --local-wallet makes one, and registers your service from it.");
    return 0;
  }
  for (const { record, balances } of held) {
    io.log(`${record.address}${record.project === io.project ? "  (this project)" : ""}`);
    io.log(`  made      ${record.created.slice(0, 10)} for ${record.project}`);
    io.log(`  key       ${io.wallets.keptWhere(record)}`);
    for (const { network, state } of balances) io.log(`  ${network === "stellar:pubnet" ? "mainnet" : "testnet"}   ${describeBalance(state)}`);
  }
  io.log("\nprovider-kit wallet withdraw --to <G...> --network <testnet|mainnet> moves USDC out. wallet export hands the account to a wallet app.");
  return 0;
}

function describeBalance(state: AccountState | undefined): string {
  if (state === undefined) return "unknown: the network didn't answer";
  if (!state.exists) return "not funded";
  const xlm = state.xlm === undefined ? "funded" : formatXlm(state.xlm);
  const usdc = !state.usdcTrustline ? "no USDC trustline" : state.usdc === undefined ? "holds USDC" : formatUsdc(state.usdc);
  return `${xlm}, ${usdc}`;
}

async function withdraw(flags: CliFlags, io: WalletIo): Promise<number> {
  if (flags.to === undefined) throw new UsageError("wallet withdraw needs --to <G...>: the account to pay");
  if (flags.network === undefined) throw new UsageError("wallet withdraw needs --network testnet or --network mainnet: money never moves on a network by default");
  if (stellarAddressKind(flags.to) !== "account") throw new UsageError("--to must be a G... account address");
  const asset = (flags.asset ?? "usdc").toLowerCase();
  if (asset !== "usdc" && asset !== "xlm") throw new UsageError(`--asset must be usdc or xlm, not "${flags.asset}"`);
  if (asset === "xlm" && flags.amount === undefined) throw new UsageError("withdrawing XLM needs --amount: the account must keep its reserve and its fees");
  if (flags.memo !== undefined && Buffer.byteLength(flags.memo) > 28) throw new UsageError("--memo is a text memo of at most 28 bytes");
  const network = parseNetwork(flags.network);
  const record = await pick(flags, io);
  const keypair = await io.wallets.keypair(record.address);
  if (keypair === undefined) throw new Error(`${record.address} isn't a local wallet`);
  if (flags.to === record.address) throw new UsageError("--to is the local wallet itself");

  const chain = io.chain(network, flags.rpc);
  const name = networkName(network);
  const [state, destination] = await Promise.all([chain.account(record.address), chain.account(flags.to)]);
  const balance = asset === "usdc" ? state.usdc : state.xlm;
  if (!state.exists || (asset === "usdc" && !state.usdcTrustline)) return refuse(io, `${record.address} holds no ${asset.toUpperCase()} on ${name}.`);
  if (balance === undefined) return refuse(io, `the balance of ${record.address} can't be read on ${name}.`);
  const amount = flags.amount === undefined ? balance : parseAmount(flags.amount);
  const format = asset === "usdc" ? formatUsdc : formatXlm;
  if (amount <= 0n) return refuse(io, `${record.address} holds no ${asset.toUpperCase()} on ${name}.`);
  if (amount > balance) return refuse(io, `${record.address} holds ${format(balance)} on ${name}, less than ${format(amount)}.`);
  // Fail closed: a payment to an account that can't take it is never sent.
  if (!destination.exists) return refuse(io, `${flags.to} doesn't exist on ${name}.`);
  if (asset === "usdc" && !destination.usdcTrustline) return refuse(io, `${flags.to} has no USDC trustline on ${name}, so it can't receive USDC.`);

  io.log(`Withdraw from your local wallet on ${name}`);
  io.log(`  from     ${record.address}`);
  io.log(`  to       ${flags.to}`);
  io.log(`  amount   ${format(amount)}${flags.amount === undefined ? " (all of it)" : ""}`);
  io.log(`  memo     ${flags.memo ?? "none. An exchange deposit needs its memo: --memo <text>"}`);
  if (!flags.yes) {
    if (!io.interactive) return refuse(io, "nobody is here to confirm it. --yes pays without asking.");
    const answer = await io.ask("Send it? [y/N] ");
    if (answer === undefined || !/^(y|yes)$/i.test(answer.trim())) return refuse(io, "you didn't confirm it.");
  }

  const transaction = await chain.pay(record.address, flags.to, asset === "usdc" ? "USDC" : "XLM", amount, flags.memo);
  transaction.sign(keypair);
  const sent = await chain.send(transaction);
  const url = explorerUrl(network, "tx", sent.hash);
  if (sent.status === "unknown") {
    io.log(`? The payment was sent, but it isn't confirmed: ${sent.reason}. Look it up before trying again: ${url}`);
    return 1;
  }
  if (sent.status === "failed") {
    io.log(`✗ Not paid. ${sent.reason}`);
    return 1;
  }
  io.log(`✓ Paid ${format(amount)} to ${flags.to} · ${url}`);
  return 0;
}

async function exportKey(flags: CliFlags, io: WalletIo): Promise<number> {
  const record = await pick(flags, io);
  if (!io.interactive || flags.yes || flags.json) {
    io.log("wallet export shows a secret key, so it runs only for a person at a terminal: not piped, not from a script or an agent, and not with --yes.");
    io.log("Run it yourself, in your own terminal: provider-kit wallet export");
    return 1;
  }
  const keypair = await io.wallets.keypair(record.address);
  if (keypair === undefined) throw new Error(`${record.address} isn't a local wallet`);
  io.log(`This shows the secret key of ${record.address}.`);
  io.log("Whoever has it controls the account: its income, and your service's registration. Share it with nobody, and paste it only into a wallet app.");
  const answer = await io.ask('Type "show" to show it: ');
  if (answer?.trim().toLowerCase() !== "show") {
    io.log("Not shown.");
    return 1;
  }
  io.log(`\n${keypair.secret()}\n`);
  io.log('In your wallet app, choose "Import a Stellar secret key" and paste it. The account then signs there too:');
  io.log("provider-kit launch without --local-wallet uses it on the approval page. Clear your terminal when you're done.");
  return 0;
}

/** The wallet a command acts on: --wallet, else this project's, else the only one. */
async function pick(flags: CliFlags, io: WalletIo): Promise<WalletRecord> {
  const records = await io.wallets.list();
  if (flags.wallet !== undefined) {
    const named = records.find((record) => record.address === flags.wallet);
    if (named === undefined) throw new UsageError(`${flags.wallet} isn't a local wallet on this computer: provider-kit wallet lists them`);
    return named;
  }
  const mine = records.filter((record) => record.project === io.project).at(-1);
  if (mine !== undefined) return mine;
  if (records.length === 1) return records[0]!;
  if (records.length === 0) throw new UsageError("there is no local wallet on this computer: provider-kit launch --local-wallet makes one");
  throw new UsageError(`this project has no local wallet of its own: name one with --wallet <G...> (${records.map((record) => record.address).join(", ")})`);
}

/** "12.5" as base units, 7 decimals. */
function parseAmount(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(text.trim());
  if (match === null) throw new UsageError(`--amount must be a number with at most 7 decimals, such as 12.5, not "${text}"`);
  return BigInt(match[1]!) * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
}

function refuse(io: WalletIo, why: string): number {
  io.log(`Nothing was sent: ${why}`);
  return 1;
}
