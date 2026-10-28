import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, PROVIDER_STANDARD, sha256Hex, type ProviderManifest } from "@stellar-agent-services/protocol";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalOutcome, ApprovalPlan } from "../src/cli/approval.js";
import type { OwnerChain } from "../src/cli/owner-chain.js";
import { requestValidation, type RequestValidationIo } from "../src/cli/request-validation.js";
import { UsageError, type CliFlags, type StellarCli } from "../src/cli/shared.js";
import {
  checkRegistration,
  createProvider,
  defineService,
  prepareValidationRequest,
  registrationDataUri,
  registrationFile,
  registryConfig,
  validationRequestArguments,
  ValidationRequestError,
  type ProviderConfig,
  type RegistryReader,
  type ValidationRecord,
  type ValidationRequestOptions,
} from "../src/index.js";
import { fakeFacilitator } from "./support/harness.js";
import { fakeChain, walletApproves } from "./support/owner.js";

// Asking a verifier for validation: nothing is signed for a provider a verifier couldn't validate, a key
// that may not ask for the agent, or a validator that is the provider itself.

const AGENT_ID = 42;
// Registered from the payTo account, as the setup guide recommends: the owner is the wallet.
const ownerKeys = Keypair.random();
const owner = ownerKeys.publicKey();
const verifier = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const NOW = new Date("2026-10-26T10:00:00Z");
const MANIFEST_URL = "https://api.example.com/.well-known/stellar-agent-services.json";

const config = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  baseUrl: "https://api.example.com/agent",
  network: "stellar:testnet",
  payTo: owner,
  provider: { name: "Validation test", agentId: AGENT_ID },
  services: [defineService({ name: "echo", description: "Echoes.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({}) })],
  facilitator: fakeFacilitator(),
  rpc: false,
  ...overrides,
});

/** The Stellar 8004 registries, with the agent registered as `provider-kit register` leaves it. */
function registered(manifest: ProviderManifest, manifestUrl: string) {
  const agents = new Map<number, { owner: string; uri: string; wallet?: string; approved?: string }>([
    [AGENT_ID, { owner, uri: registrationDataUri(registrationFile(manifest, manifestUrl)), wallet: manifest.payment.accepts[0].payTo }],
  ]);
  const operators = new Set<string>();
  const validations = new Map<string, ValidationRecord>();
  const { contracts } = registryConfig("stellar:testnet");
  const registry: RegistryReader = {
    network: "stellar:testnet",
    contracts: { identity: contracts.identity, validation: contracts.validation },
    agentUri: async (agentId) => agents.get(agentId)?.uri,
    agentWallet: async (agentId) => agents.get(agentId)?.wallet,
    agentOwner: async (agentId) => agents.get(agentId)?.owner,
    agentApproved: async (agentId) => agents.get(agentId)?.approved,
    isOperator: async (agentOwner, operator) => operators.has(`${agentOwner} ${operator}`),
    validation: async (requestHash) => validations.get(requestHash),
  };
  return { agents, operators, validations, registry };
}

function setup(overrides: Partial<ProviderConfig> = {}) {
  const provider = createProvider(config(overrides));
  const world = registered(provider.manifest, provider.manifestUrl);
  const prepare = (options: Partial<ValidationRequestOptions> = {}) =>
    prepareValidationRequest(provider.manifest, provider.manifestUrl, { validator: verifier, signer: owner, registry: world.registry, now: () => NOW, ...options });
  return { provider, world, prepare };
}

describe("prepareValidationRequest", () => {
  it("builds the request: its canonical bytes in a data: URI, and their SHA-256 as the request hash", async () => {
    const { world, prepare } = setup();
    const prepared = await prepare();
    expect(prepared.request).toEqual({
      standard: PROVIDER_STANDARD,
      type: "validation-request",
      agentId: AGENT_ID,
      network: "stellar:testnet",
      manifest: { url: MANIFEST_URL },
      validator: verifier,
      requestedAt: "2026-10-26T10:00:00.000Z",
    });
    const bytes = Buffer.from(prepared.requestUri.replace(/^data:application\/json;base64,/, ""), "base64");
    expect(bytes.toString("utf8")).toBe(canonicalJson(prepared.request));
    expect(prepared.requestHash).toBe(await sha256Hex(bytes));
    expect(prepared.contractId).toBe(world.registry.contracts.validation);
  });

  it("hands the Stellar CLI one validation_request, with the caller that signs", async () => {
    const prepared = await setup().prepare();
    expect(validationRequestArguments(prepared, { source: "owner", network: "testnet", caller: owner })).toEqual([
      "contract", "invoke", "--id", prepared.contractId, "--source-account", "owner", "--network", "testnet", "--",
      "validation_request", "--caller", owner, "--validator_address", verifier, "--agent_id", "42",
      "--request_uri", prepared.requestUri, "--request_hash", prepared.requestHash,
    ]);
  });

  it("lets the agent's owner ask, the address approved for the agent, or an operator of the owner's, and no one else", async () => {
    const { world, prepare } = setup();
    await expect(prepare({ signer: stranger })).rejects.toThrow(/may not ask for agent 42's validation/);
    world.agents.get(AGENT_ID)!.approved = stranger;
    await expect(prepare({ signer: stranger })).resolves.toMatchObject({ request: { validator: verifier } });
    delete world.agents.get(AGENT_ID)!.approved;
    world.operators.add(`${owner} ${stranger}`);
    await expect(prepare({ signer: stranger })).resolves.toMatchObject({ request: { validator: verifier } });
  });

  it("leaves who may ask to the registry when the signer is unknown", async () => {
    const { provider, world } = setup();
    const prepared = await prepareValidationRequest(provider.manifest, provider.manifestUrl, { validator: verifier, registry: world.registry });
    expect(prepared.request.agentId).toBe(AGENT_ID);
  });

  it("refuses a validator that is the provider itself: its owner, its wallet or the signer", async () => {
    // Here the owner is not payTo, and an operator of the owner's signs.
    const otherOwner = Keypair.random().publicKey();
    const { world, prepare } = setup();
    world.agents.get(AGENT_ID)!.owner = otherOwner;
    world.operators.add(`${otherOwner} ${stranger}`);
    for (const validator of [otherOwner, owner, stranger]) {
      await expect(prepare({ validator, signer: stranger })).rejects.toThrow(/the validator is the provider itself/);
    }
    await expect(prepare({ signer: stranger })).resolves.toMatchObject({ request: { validator: verifier } });
  });

  it("refuses a provider a verifier could not validate, citing the rule", async () => {
    await expect(setup({ baseUrl: "http://localhost:8787/agent", dev: true }).prepare()).rejects.toThrow(/deploy it on HTTPS first/);
    await expect(setup({ provider: { name: "Not registered" } }).prepare()).rejects.toThrow(/provider\.agentId is not set \[I2\]/);

    const missing = setup();
    missing.world.agents.clear();
    await expect(missing.prepare()).rejects.toThrow(/\[I2\] agent 42 does not exist/);

    const moved = setup();
    moved.world.agents.get(AGENT_ID)!.uri = registrationDataUri(registrationFile(moved.provider.manifest, "https://old.example.com/.well-known/stellar-agent-services.json"));
    await expect(moved.prepare()).rejects.toThrow(/\[I1\] the registration file does not list/);

    const paidElsewhere = setup();
    paidElsewhere.world.agents.get(AGENT_ID)!.wallet = stranger;
    await expect(paidElsewhere.prepare()).rejects.toThrow(/\[I3\] the agent wallet is/);
  });

  it("lists every problem at once", async () => {
    const error = await setup({ baseUrl: "http://localhost:8787/agent", dev: true, provider: { name: "Dev" } })
      .prepare({ validator: "GABC" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationRequestError);
    expect((error as ValidationRequestError).problems).toEqual([
      expect.stringMatching(/deploy it on HTTPS/),
      expect.stringMatching(/agentId is not set/),
      expect.stringMatching(/G\.\.\. account/),
    ]);
  });

  it("refuses a validator that is a contract, and a registry on another network", async () => {
    const { world, prepare } = setup();
    await expect(prepare({ validator: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" })).rejects.toThrow(/G\.\.\. account/);
    await expect(prepare({ registry: { ...world.registry, network: "stellar:pubnet" } })).rejects.toThrow(/the registry is on stellar:pubnet/);
  });

  it("fails closed when the registries can't be read", async () => {
    const { world, prepare } = setup();
    const down: RegistryReader = {
      ...world.registry,
      agentOwner: async () => {
        throw new Error("RPC unavailable");
      },
    };
    await expect(prepare({ registry: down })).rejects.toThrow(/registries can't be read: RPC unavailable/);
  });
});

describe("checkRegistration", () => {
  it("checks I1–I3 through the registry it is given", async () => {
    const { provider, world } = setup();
    const findings = await checkRegistration(provider.manifest, provider.manifestUrl, { registry: world.registry });
    expect(findings.map(({ rule, ok }) => [rule, ok])).toEqual([["I2", true], ["I1", true], ["I3", true]]);
  });
});

describe("provider-kit request-validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-kit-validation-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  let files = 0;
  /** A gateway config for the provider that setup() registers. */
  const gateway = (overrides: Record<string, unknown> = {}) => {
    const path = join(directory, `provider-${++files}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        baseUrl: "https://api.example.com/agent",
        network: "stellar:testnet",
        payTo: owner,
        facilitator: "https://x402.org/facilitator",
        provider: { name: "Validation test", agentId: AGENT_ID },
        store: "memory",
        services: [{ name: "echo", description: "Echoes.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, upstream: { url: "https://upstream.example.com/echo" } }],
        ...overrides,
      }),
    );
    return path;
  };

  let output: string[] = [];
  beforeEach(() => {
    output = [];
    const capture = (...args: unknown[]) => void output.push(args.join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
  });
  afterEach(() => vi.restoreAllMocks());

  /** A request in the Validation Registry, as validation_request leaves it. */
  const pending = (validator: string, agentId: number): ValidationRecord => ({
    validator,
    agentId,
    hasResponse: false,
    response: 0,
    responseHash: "0".repeat(64),
    tag: "",
    lastUpdate: 1,
  });

  /**
   * The command with a fake Stellar CLI, whose keychain holds `signer` and whose invocations the registry records,
   * and a fake chain whose landed validation_request calls it records too. `approve` stands for the person on the
   * approval page; without it, opening the page fails the test.
   */
  function cli(options: { stellar?: StellarCli | undefined; signer?: string; approve?: (plan: ApprovalPlan, chain: OwnerChain) => Promise<ApprovalOutcome> } = {}) {
    const { world } = setup();
    const calls: string[][] = [];
    const stellar: StellarCli = async (args) => {
      calls.push(args);
      if (args[0] === "keys") return `${options.signer ?? owner}\n`;
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      world.validations.set(value("--request_hash"), pending(value("--validator_address"), Number(value("--agent_id"))));
      return "";
    };
    const chain = fakeChain();
    chain.accounts.set(owner, { usdcTrustline: true });
    chain.onLanded = (call) => {
      const [, validator, agentId, , requestHash] = call.args.map((arg) => scValToNative(arg) as unknown);
      world.validations.set((requestHash as Buffer).toString("hex"), pending(validator as string, agentId as number));
    };
    const io: RequestValidationIo = {
      stellar: async () => ("stellar" in options ? options.stellar : stellar),
      registry: () => world.registry,
      chain: () => chain,
      approve:
        options.approve ??
        (async () => {
          throw new Error("the approval page was opened, but this test signs with --source");
        }),
      now: () => NOW,
    };
    return { world, calls, chain, run: (flags: CliFlags) => requestValidation(flags, io) };
  }

  it("checks everything, then prints the command on a dry run and signs nothing", async () => {
    const { world, calls, run } = cli();
    expect(await run({ config: gateway(), validator: verifier, source: "owner", "dry-run": true })).toBe(0);
    const text = output.join("\n");
    expect(text).toContain("Dry run. This would run:");
    expect(text).toMatch(
      new RegExp(`validation_request --caller ${owner} --validator_address ${verifier} --agent_id 42 --request_uri 'data:application/json;base64,[A-Za-z0-9+/=]+' --request_hash [0-9a-f]{64}`),
    );
    expect(calls).toEqual([["keys", "address", "owner"]]);
    expect(world.validations.size).toBe(0);
  });

  it("sends the request through the Stellar CLI, confirms it on chain and prints the hash for the verifier", async () => {
    const { world, calls, run } = cli();
    const out = join(directory, "request.json");
    expect(await run({ config: gateway(), validator: verifier, source: "owner", out })).toBe(0);

    const [requestHash, record] = [...world.validations][0]!;
    expect(record).toMatchObject({ validator: verifier, agentId: AGENT_ID, hasResponse: false });
    const sent = calls.at(-1)!;
    expect(sent).toEqual(expect.arrayContaining(["validation_request", "--caller", owner, "--request_hash", requestHash]));
    // The file, the data: URI on chain and the hash are the same bytes.
    const bytes = readFileSync(out);
    expect(await sha256Hex(bytes)).toBe(requestHash);
    expect(Buffer.from(sent[sent.indexOf("--request_uri") + 1]!.split(",")[1]!, "base64").equals(bytes)).toBe(true);
    expect(output.join("\n")).toContain(`verifier publish <receipt.json> --request-hash ${requestHash}`);
  });

  it("prints the command for later without the Stellar CLI, and sends nothing", async () => {
    const { world, run } = cli({ stellar: undefined });
    expect(await run({ config: gateway(), validator: verifier, source: "owner" })).toBe(1);
    const text = output.join("\n");
    expect(text).toContain("The Stellar CLI (`stellar`) is not installed");
    expect(text).toContain(`--caller "$(stellar keys address owner)"`);
    expect(world.validations.size).toBe(0);
  });

  it("refuses, before signing, a key that may not ask for the agent", async () => {
    const { calls, run } = cli({ signer: stranger });
    await expect(run({ config: gateway(), validator: verifier, source: "stranger" })).rejects.toThrow(ValidationRequestError);
    expect(calls).toEqual([["keys", "address", "stranger"]]);
  });

  it("refuses a provider in development mode", async () => {
    const { calls, run } = cli();
    await expect(run({ config: gateway({ baseUrl: "http://localhost:8787/agent", dev: true }), validator: verifier, source: "owner" })).rejects.toThrow(
      /deploy it on HTTPS first/,
    );
    expect(calls.some((call) => call.includes("validation_request"))).toBe(false);
  });

  it("needs --validator, as an account", async () => {
    const { run } = cli();
    await expect(run({ config: gateway(), source: "owner" })).rejects.toThrow(UsageError);
    await expect(run({ config: gateway() })).rejects.toThrow(UsageError);
    await expect(run({ config: gateway(), validator: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", source: "owner" })).rejects.toThrow(
      /--validator must be a G\.\.\. account/,
    );
  });

  it("without --source, has the agent owner's wallet sign the very request it printed, and confirms it on chain", async () => {
    const wallet = walletApproves(ownerKeys, { wallet: "Freighter" });
    const { world, calls, chain, run } = cli({ approve: wallet.approve });
    const out = join(directory, "wallet-request.json");
    expect(await run({ config: gateway(), validator: verifier, out })).toBe(0);

    // The Stellar CLI isn't involved: the owner's own wallet signed validation_request.
    expect(calls).toEqual([]);
    expect(chain.sent.map((transaction) => [transaction.source, transaction.operations[0]!.type])).toEqual([[owner, "invokeHostFunction"]]);
    const [{ call }] = chain.invoked as [(typeof chain.invoked)[0]];
    expect(call.method).toBe("validation_request");
    const [caller, validator, agentId, requestUri, requestHash] = call.args.map((arg) => scValToNative(arg) as unknown);
    expect([caller, validator, agentId]).toEqual([owner, verifier, AGENT_ID]);
    // The bytes on chain are the request printed before the wallet connected, and the file written after.
    const bytes = readFileSync(out);
    expect(Buffer.from((requestUri as string).split(",")[1]!, "base64").equals(bytes)).toBe(true);
    expect((requestHash as Buffer).toString("hex")).toBe(await sha256Hex(bytes));
    expect(output.join("\n")).toContain(`request_hash  ${(requestHash as Buffer).toString("hex")}`);
    expect([...world.validations.keys()]).toEqual([(requestHash as Buffer).toString("hex")]);
    expect(wallet.views[0]).toMatchObject({ state: "done", result: { title: "Validation requested" } });
    expect(output.join("\n")).toContain(`Requested: agent 42 asks ${verifier} for validation on stellar:testnet.`);
  });

  it("without --source, takes the request only from an account that may ask for the agent", async () => {
    const wallet = walletApproves(Keypair.random());
    const { world, chain, run } = cli({ approve: wallet.approve });
    expect(await run({ config: gateway(), validator: verifier })).toBe(1);
    expect(wallet.views[0]).toMatchObject({ state: "connect", error: { title: "This account can't ask for validation", message: expect.stringMatching(/may not ask for agent 42/) } });
    expect(chain.invoked).toEqual([]);
    expect(world.validations.size).toBe(0);
  });

  it("without --source, prints the request on a dry run and opens nothing", async () => {
    const { chain, run } = cli();
    expect(await run({ config: gateway(), validator: verifier, "dry-run": true })).toBe(0);
    expect(output.join("\n")).toContain("Dry run. Without --dry-run, a page opens where the agent owner's wallet signs validation_request on stellar:testnet.");
    expect(chain.invoked).toEqual([]);
  });

  it("says so when the registry does not show the request it sent", async () => {
    const { world, run } = cli();
    world.registry.validation = async () => undefined;
    expect(await run({ config: gateway(), validator: verifier, source: "owner" })).toBe(1);
    expect(output.join("\n")).toContain("Sent, but the registry does not show the request yet");
  });
});
