// The offline world of `verifier watch`: the provider world of harness.ts, plus what the watcher reads and
// runs besides. Requests go into the fake Validation Registry's list, with the validation_request events an
// RPC keeps for a limited window; a fake Stellar CLI records validation_response in the registry; and fetch
// reaches the watcher's own HTTP side at its public URL. A clock that can jump ahead stands in for the hours
// a provider takes to come up. Nothing here touches the network.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_STANDARD,
  VALIDATION_REQUEST_TYPE,
  validationRequestDataUri,
  validationRequestHash,
  type ValidationRequest,
} from "@stellar-agent-services/protocol";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { openWatcher, type ChainReader, type Watcher, type WatcherOptions } from "../../src/index.js";
import { AGENT_ID, fastSleep, MANIFEST_URL, setup, validator, type SetupOptions } from "./harness.js";

export const PUBLIC_URL = "https://verifier.test";
export const SOURCE = "verifier";

/** One validation_request event, as the Validation Registry emits it. */
export interface RequestEvent {
  ledger: number;
  agentId: number;
  requestHash: string;
  requestUri: string;
}

/** The event's topics: its name, then the validator, the agent and the request hash. */
function topics(event: RequestEvent): xdr.ScVal[] {
  return [
    xdr.ScVal.scvSymbol("validation_request"),
    Address.fromString(validator).toScVal(),
    xdr.ScVal.scvU32(event.agentId),
    xdr.ScVal.scvBytes(Buffer.from(event.requestHash, "hex")),
  ];
}

export async function watchWorld(options: SetupOptions = {}) {
  const world = setup(options);
  const dataDir = await mkdtemp(join(tmpdir(), "verifier-watch-"));
  const events: RequestEvent[] = [];
  /** The RPC's oldest ledger: events before it are gone. */
  const retention = { oldestLedger: 1 };
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  let ledger = 500;

  /** The fake chain's RPC, which also keeps the validation_request events. */
  const reader: ChainReader = {
    ...world.chain.chain,
    async getEvents(request) {
      const wanted = request.filters[0]?.topics?.[0];
      if (wanted?.[0] !== xdr.ScVal.scvSymbol("validation_request").toXDR("base64")) return world.chain.chain.getEvents(request);
      const start = request.startLedger ?? 0;
      if (start < retention.oldestLedger) {
        throw new Error(`startLedger must be between the oldest ledger: ${retention.oldestLedger} and the latest ledger: ${world.chain.state.latestLedger}`);
      }
      const found = events.filter(
        (event) =>
          event.ledger >= start &&
          (request.endLedger === undefined || event.ledger < request.endLedger) &&
          topics(event).every((topic, index) => wanted[index] === "*" || wanted[index] === topic.toXDR("base64")),
      );
      return {
        latestLedger: world.chain.state.latestLedger,
        oldestLedger: retention.oldestLedger,
        latestLedgerCloseTime: "",
        oldestLedgerCloseTime: "",
        cursor: "",
        events: found.map((event) => ({
          id: `${event.ledger}-0`,
          type: "contract",
          ledger: event.ledger,
          ledgerClosedAt: "",
          transactionIndex: 0,
          operationIndex: 0,
          inSuccessfulContractCall: true,
          txHash: "ab".repeat(32),
          topic: topics(event),
          value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_uri"), val: xdr.ScVal.scvString(event.requestUri) })]),
        })),
      } as rpc.Api.GetEventsResponse;
    },
  };

  /** The Stellar CLI: `keys address` gives the validator; validation_response lands in the registry, unless told otherwise. */
  const cli = { calls: [] as string[][], land: true, fail: false };
  const stellar = async (args: string[]): Promise<string> => {
    cli.calls.push(args);
    if (args[0] === "keys") return `${validator}\n`;
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (cli.land) {
      const requestHash = value("--request_hash");
      const record = world.validations.get(requestHash)!;
      world.validations.set(requestHash, { ...record, hasResponse: true, response: Number(value("--response")), responseHash: value("--response_hash"), tag: value("--tag"), lastUpdate: ++ledger });
    }
    if (cli.fail) throw new Error("Command failed: stellar contract invoke: transaction submission timeout");
    return "";
  };
  const responses = () => cli.calls.filter((args) => args.includes("validation_response"));

  /** The watcher's HTTP side, once a watcher is open. */
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === PUBLIC_URL) return handler === undefined ? new Response("", { status: 502 }) : handler(new Request(url, init));
    return world.fetch(input, init);
  }) as typeof globalThis.fetch;

  /** A validation request naming the validator: in the registry's list, with its record and its event. */
  async function request(document: Partial<ValidationRequest> = {}, options: { agentId?: number; requestUri?: string } = {}) {
    const full: ValidationRequest = {
      standard: PROVIDER_STANDARD,
      type: VALIDATION_REQUEST_TYPE,
      agentId: AGENT_ID,
      network: "stellar:testnet",
      manifest: { url: MANIFEST_URL },
      validator,
      requestedAt: new Date(now()).toISOString(),
      ...document,
    };
    const requestHash = await validationRequestHash(full);
    const agentId = options.agentId ?? AGENT_ID;
    const at = ++ledger;
    world.validationRequests.push({ validator, requestHash });
    world.validations.set(requestHash, { validator, agentId, hasResponse: false, response: 0, responseHash: "0".repeat(64), tag: "", lastUpdate: at });
    events.push({ ledger: at, agentId, requestHash, requestUri: options.requestUri ?? validationRequestDataUri(full) });
    return { requestHash, document: full, ledger: at };
  }

  const logs: string[] = [];
  /** A watcher on this world's data directory; opening another one is a restart. */
  async function open(overrides: Partial<WatcherOptions> = {}): Promise<Watcher> {
    const watcher = await openWatcher({
      network: "stellar:testnet",
      validator,
      registry: world.registry,
      chain: reader,
      payer: world.payer,
      publicUrl: PUBLIC_URL,
      dataDir,
      stellar,
      source: SOURCE,
      cliNetwork: "testnet",
      fetch,
      now,
      sleep: fastSleep,
      log: (line) => logs.push(line),
      ...overrides,
    });
    handler = (each) => watcher.handle(each);
    return watcher;
  }

  /** Io.serve for the CLI: what it serves is what fetch reaches at PUBLIC_URL. */
  const serve = async (served: (request: Request) => Promise<Response>, port: number) => {
    handler = served;
    return {
      url: `http://0.0.0.0:${port}`,
      close: async () => {
        handler = undefined;
      },
    };
  };
  /** GET or HEAD on the watcher's HTTP side. */
  const get = (path: string, method: "GET" | "HEAD" | "POST" = "GET") => fetch(`${PUBLIC_URL}${path}`, { method });
  /** Lets time pass. */
  const advance = (ms: number) => {
    clock.offset += ms;
  };

  return { ...world, dataDir, events, retention, now, advance, reader, cli, stellar, responses, fetch, serve, request, open, get, logs };
}

export type WatchWorld = Awaited<ReturnType<typeof watchWorld>>;
