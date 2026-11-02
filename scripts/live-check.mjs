// Checks what the packages take for granted on each network against the live services: the x402 facilitator, Soroban
// RPC and Horizon, the USDC contract and the Stellar 8004 registries. Read-only: it signs and pays nothing, and holds no
// key. On mainnet, the facilitator's API key is read from FACILITATOR_AUTH ("Bearer <key>") when it is set; without it,
// the check only confirms the facilitator answers and wants a key.
//
//   node scripts/live-check.mjs [--network testnet|mainnet]      both networks without --network
//
// Run after `npm run build`. .github/workflows/live.yml runs it every day. It uses the network, so `npm test` doesn't.

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Account, Address, Asset, Contract, Keypair, Networks, rpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { MAINNET_CONFIG, TESTNET_CONFIG } from "@trionlabs/stellar8004";

const built = (path) => import(new URL(`../packages/${path}`, import.meta.url).href);
const { HORIZON_URL, SOROBAN_RPC_URL, USDC_ASSET, USDC_ISSUER } = await built("protocol/dist/index.js");
const { checkFacilitator, httpFacilitator } = await built("provider-kit/dist/index.js");
// What create-stellar-service writes into a project: the facilitators and mainnet's RPC.
const { FACILITATORS, FACILITATOR_KEYS, MAINNET_RPC } = await built("create-stellar-service/dist/files.js");

const NETWORKS = {
  testnet: { id: "stellar:testnet", passphrase: Networks.TESTNET, registry: TESTNET_CONFIG, rpcUrl: SOROBAN_RPC_URL["stellar:testnet"] },
  mainnet: { id: "stellar:pubnet", passphrase: Networks.PUBLIC, registry: MAINNET_CONFIG, rpcUrl: MAINNET_RPC },
};
const TIMEOUT_MS = 30_000;
const TRIES = 3;

const { values } = parseArgs({ options: { network: { type: "string" } } });
if (values.network !== undefined && !(values.network in NETWORKS)) {
  console.error(`--network must be testnet or mainnet, not "${values.network}"`);
  process.exit(2);
}
const names = values.network === undefined ? Object.keys(NETWORKS) : [values.network];

let failed = 0;
const summary = [];
for (const name of names) {
  const network = NETWORKS[name];
  console.log(`\n${network.id}`);
  summary.push(`### ${network.id}`, "");
  for (const [title, check] of checks(network)) {
    const result = await attempt(check);
    const line = `${result.ok ? "✓" : "✗"} ${title}: ${result.detail}`;
    console.log(`  ${line}`);
    summary.push(`- ${line}`);
    if (!result.ok) failed++;
  }
  summary.push("");
}
if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${summary.join("\n")}\n`);
console.log(failed === 0 ? "\nEvery check passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

/** Each check returns what it found, or throws. */
function checks(network) {
  const usdc = USDC_ASSET[network.id];
  const issuer = USDC_ISSUER[network.id];
  const rpcs = [...new Set([network.rpcUrl, network.registry.rpcUrl])];
  return [
    [
      "USDC contract",
      async () => {
        const derived = new Asset("USDC", issuer).contractId(network.passphrase);
        if (derived !== usdc) throw new Error(`USDC_ASSET is ${usdc}, but USDC:${issuer}'s asset contract is ${derived}`);
        const name = await readContract(network, usdc, "name");
        if (name !== `USDC:${issuer}`) throw new Error(`${usdc} answers name() with ${JSON.stringify(name)}, not USDC:${issuer}`);
        return `${usdc} is USDC:${short(issuer)}`;
      },
    ],
    ...rpcs.map((url) => [
      `Soroban RPC ${url}`,
      async () => {
        const server = new rpc.Server(url);
        const health = await server.getHealth();
        if (health.status !== "healthy") throw new Error(`getHealth says ${health.status}`);
        const { passphrase } = await server.getNetwork();
        if (passphrase !== network.passphrase) throw new Error(`it serves "${passphrase}"`);
        const { sequence } = await server.getLatestLedger();
        return `healthy, ledger ${sequence}`;
      },
    ]),
    [
      `Horizon ${HORIZON_URL[network.id]}`,
      async () => {
        const root = await getJson(HORIZON_URL[network.id]);
        if (root.network_passphrase !== network.passphrase) throw new Error(`it serves "${root.network_passphrase}"`);
        return `ledger ${root.history_latest_ledger}`;
      },
    ],
    [
      "Stellar 8004 registries",
      async () => {
        if (network.registry.networkPassphrase !== network.passphrase) throw new Error(`the SDK's config names "${network.registry.networkPassphrase}"`);
        const contracts = Object.entries(network.registry.contracts);
        const keys = contracts.map(([, id]) =>
          xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({ contract: new Address(id).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }),
          ),
        );
        const { entries } = await new rpc.Server(network.registry.rpcUrl).getLedgerEntries(...keys);
        const found = new Set(entries.map((entry) => Address.fromScAddress(entry.val.contractData().contract()).toString()));
        const missing = contracts.filter(([, id]) => !found.has(id)).map(([role, id]) => `${role} ${id}`);
        if (missing.length > 0) throw new Error(`not on chain: ${missing.join(", ")}`);
        return contracts.map(([role]) => role).join(", ");
      },
    ],
    [
      `facilitator ${FACILITATORS[network.id]}`,
      async () => {
        const url = FACILITATORS[network.id];
        const auth = process.env["FACILITATOR_AUTH"];
        if (network.id === "stellar:pubnet" && !auth) {
          // Without a key, the most it can show: the facilitator is there, and asks for one.
          const response = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (response.status !== 401 && response.status !== 403) throw new Error(`supported answered ${response.status} without an API key; expected 401`);
          return `answers, and wants an API key (${FACILITATOR_KEYS}); set FACILITATOR_AUTH to check what it settles`;
        }
        await checkFacilitator(httpFacilitator(url, auth ? { headers: { Authorization: auth } } : {}), network.id);
        return `settles x402 v2 "exact" payments on ${network.id}, with fees sponsored`;
      },
    ],
  ];
}

/** A read-only contract call, simulated: nothing is signed or sent. The source account needn't exist. */
async function readContract(network, contract, method) {
  const source = new Account(Keypair.random().publicKey(), "0");
  const transaction = new TransactionBuilder(source, { fee: "100", networkPassphrase: network.passphrase })
    .addOperation(new Contract(contract).call(method))
    .setTimeout(30)
    .build();
  const simulation = await new rpc.Server(network.rpcUrl).simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation)) throw new Error(`${method}() failed: ${simulation.error ?? "no result"}`);
  return scValToNative(simulation.result.retval);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** A check, tried again after a pause when it fails, so a passing blip doesn't fail the run. */
async function attempt(check) {
  let last;
  for (let tries = 1; tries <= TRIES; tries++) {
    try {
      return { ok: true, detail: await withTimeout(check()) };
    } catch (error) {
      last = error;
      if (tries < TRIES) await new Promise((resolve) => setTimeout(resolve, tries * 5_000));
    }
  }
  return { ok: false, detail: last instanceof Error ? last.message : String(last) };
}

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function short(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
