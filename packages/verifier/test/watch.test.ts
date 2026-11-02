import { createHash } from "node:crypto";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VALIDATION_TAG, validationRequestBytes, type ValidationRequest, type VerificationReceipt } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { serveHttp } from "../src/cli/serve.js";
import type { Io } from "../src/cli/shared.js";
import { LockedError, lockDataDir, loadState, StateError, STATE_FILE } from "../src/index.js";
import { AGENT_ID, MANIFEST_URL, validator } from "./support/harness.js";
import { PUBLIC_URL, watchWorld, type WatchWorld } from "./support/watch.js";

// verifier watch over the offline world: requests found in the registry, checked with the test payer,
// receipts served and anchored, and the retries and refusals around them.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const arg = (args: string[] | undefined, flag: string) => args?.[args.indexOf(flag) + 1];

describe("verifier watch: answering a request", () => {
  it("checks the provider the request names, serves the receipt, publishes it and draws its badges", async () => {
    const world = await watchWorld();
    const { requestHash } = await world.request();
    const watcher = await world.open();
    await watcher.tick();

    const entry = watcher.state.requests[requestHash]!;
    expect(entry).toMatchObject({ status: "answered", answeredBy: "watch", manifestUrl: MANIFEST_URL, manifestFrom: "request", level: 3, score: 100, runs: 1 });
    const sha256 = entry.receipt!;
    // The provider was paid by the test payer, and the response went out once, through the Stellar CLI.
    expect(world.facilitator.settled.length).toBeGreaterThan(0);
    const [sent, ...more] = world.responses();
    expect(more).toEqual([]);
    expect(sent).toEqual(expect.arrayContaining(["--source-account", "verifier", "--network", "testnet", "--caller", validator, "--tag", VALIDATION_TAG]));
    expect(arg(sent, "--request_hash")).toBe(requestHash);
    expect(arg(sent, "--response")).toBe("100");
    expect(arg(sent, "--response_uri")).toBe(`${PUBLIC_URL}/receipts/${sha256}.json`);
    expect(world.validations.get(requestHash)).toMatchObject({ hasResponse: true, responseHash: sha256 });

    // The response URI serves exactly the receipt's bytes.
    const served = await world.get(`/receipts/${sha256}.json`);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("application/json");
    expect(served.headers.get("Cache-Control")).toContain("immutable");
    expect(served.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    const receipt = JSON.parse(new TextDecoder().decode(bytes)) as VerificationReceipt;
    expect(receipt).toMatchObject({ validator, agentId: AGENT_ID, network: "stellar:testnet", level: 3, manifest: { url: MANIFEST_URL } });

    // Badges, "8004 validated" included now that the registry anchors the receipt.
    const badges = (await readdir(join(world.dataDir, "receipts"))).filter((name) => name.endsWith(".svg")).sort();
    expect(badges).toEqual(["8004-validated", "load-safe", "payment-verified", "recovery-verified", "standard-v1"].map((id) => `${sha256}.${id}.svg`));
    const badge = await world.get(`/receipts/${sha256}.8004-validated.svg`);
    expect(badge.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await badge.text()).toContain("8004 validated");

    // Where the request stands, for its owner.
    expect(await (await world.get(`/requests/${requestHash}.json`)).json()).toMatchObject({
      requestHash,
      agentId: AGENT_ID,
      status: "answered",
      answeredBy: "watch",
      manifest: MANIFEST_URL,
      receipt: `${PUBLIC_URL}/receipts/${sha256}.json`,
      level: 3,
      score: 100,
    });

    // Nothing more to do: the next round sends nothing.
    await watcher.tick();
    expect(world.responses()).toHaveLength(1);
  });

  it("reads the manifest from the agent's registration once the RPC no longer keeps the request's event", async () => {
    const world = await watchWorld();
    const { requestHash, ledger } = await world.request();
    world.retention.oldestLedger = ledger + 1;
    const watcher = await world.open();
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "answered", manifestUrl: MANIFEST_URL, manifestFrom: "registration", score: 100 });
  });

  it("reads a request document served at an https request_uri, which must hash to request_hash", async () => {
    const world = await watchWorld();
    const hosted = new Map<string, string | Uint8Array>();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = hosted.get(String(input));
      return body === undefined ? world.fetch(input, init) : new Response(body);
    }) as typeof globalThis.fetch;
    const exact = await world.request({}, { requestUri: "https://owner.test/exact.json" });
    hosted.set("https://owner.test/exact.json", new Uint8Array(validationRequestBytes(exact.document)));
    // JSON.stringify is not the canonical form: those bytes don't hash to request_hash.
    const other = await world.request({ requestedAt: new Date(world.now() + 1000).toISOString() }, { requestUri: "https://owner.test/other.json" });
    hosted.set("https://owner.test/other.json", JSON.stringify(other.document));
    const watcher = await world.open({ fetch });
    await watcher.tick();
    expect(watcher.state.requests[exact.requestHash]).toMatchObject({ status: "answered", manifestFrom: "request" });
    expect(watcher.state.requests[other.requestHash]).toMatchObject({ status: "answered", manifestFrom: "registration" });
  });

  it("answers each request with a run of its own, oldest first", async () => {
    const world = await watchWorld();
    const first = await world.request();
    const second = await world.request({ requestedAt: new Date(world.now() + 1000).toISOString() });
    const watcher = await world.open();
    await watcher.tick();
    const receipts = [first, second].map(({ requestHash }) => watcher.state.requests[requestHash]!.receipt);
    expect(new Set(receipts).size).toBe(2);
    expect(world.responses().map((args) => arg(args, "--request_hash"))).toEqual([first.requestHash, second.requestHash]);
  });
});

describe("verifier watch: what it never verifies", () => {
  it("never checks a manifest URL the agent's registration does not list, and refuses the request after the retry window", async () => {
    const world = await watchWorld();
    const elsewhere = "https://elsewhere.test/.well-known/stellar-agent-services.json";
    const { requestHash } = await world.request({ manifest: { url: elsewhere } });
    const watcher = await world.open();
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "waiting", attempts: 1 });
    expect(watcher.state.requests[requestHash]!.problem).toMatch(/not agent 7's registered stellar-agent-services endpoint \[I1\]/);

    world.advance(25 * HOUR);
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "refused" });
    expect(watcher.state.requests[requestHash]!.problem).toMatch(/given up after 24 h/);
    // Neither the URL the request named nor the registered one was ever sent a request or paid.
    expect(world.requests).toEqual([]);
    expect(world.facilitator.settled).toEqual([]);
    expect(world.responses()).toEqual([]);
    expect(await (await world.get(`/requests/${requestHash}.json`)).json()).toMatchObject({ status: "refused", refusedAt: expect.any(String) });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["another standard", { standard: "stellar-agent-services/provider@2" }, /not a Provider Standard v1 validation request: \/standard/],
    ["another validator", { validator: Keypair.random().publicKey() }, /names validator G[A-Z2-7]{55}, not this verifier/],
    ["another agent", { agentId: AGENT_ID + 1 }, /is for agent 8, but the request is for agent 7/],
    ["another network", { network: "stellar:pubnet" }, /is for stellar:pubnet, but the request is on stellar:testnet/],
  ])("refuses at once a request document for %s", async (_name, document, message) => {
    const world = await watchWorld();
    // The registry's record is for agent 7 and this validator; the document says otherwise.
    const { requestHash } = await world.request(document as Partial<ValidationRequest>, { agentId: AGENT_ID });
    const watcher = await world.open();
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "refused" });
    expect(watcher.state.requests[requestHash]!.problem).toMatch(message);
    expect(world.requests).toEqual([]);
    expect(world.responses()).toEqual([]);
  });

  it("refuses to answer for a manifest that names another agent", async () => {
    const world = await watchWorld({ provider: { provider: { name: "Verifier test provider", agentId: AGENT_ID + 1 } } });
    const { requestHash } = await world.request();
    const watcher = await world.open();
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "refused", runs: 1 });
    expect(watcher.state.requests[requestHash]!.problem).toMatch(/names agent 8, but the request is for agent 7 \[I2\]/);
    expect(world.responses()).toEqual([]);
  });
});

describe("verifier watch: retries", () => {
  it("checks a provider that is not up yet again, with backoff, and answers once it is", async () => {
    let live = false;
    const world = await watchWorld({ tamper: (_request, response) => (live ? response : new Response("Not Found", { status: 404 })) });
    const { requestHash } = await world.request();
    const watcher = await world.open();
    await watcher.tick();
    const entry = () => watcher.state.requests[requestHash]!;
    expect(entry()).toMatchObject({ status: "waiting", attempts: 1, runs: 1 });
    expect(entry().problem).toBe("not reachable yet: the manifest URL answered 404, not 200");
    expect(Date.parse(entry().nextAt!) - world.now()).toBeGreaterThan(55_000);

    // Not due yet: nothing is sent.
    const sent = world.requests.length;
    await watcher.tick();
    expect(world.requests.length).toBe(sent);

    world.advance(MINUTE + 1000);
    await watcher.tick();
    expect(entry()).toMatchObject({ status: "waiting", attempts: 2 });
    expect(Date.parse(entry().nextAt!) - world.now()).toBeGreaterThan(115_000);
    expect(await (await world.get(`/requests/${requestHash}.json`)).json()).toMatchObject({
      status: "waiting",
      problem: "not reachable yet: the manifest URL answered 404, not 200",
      nextAttemptAt: entry().nextAt,
      retryUntil: expect.any(String),
    });

    live = true;
    world.advance(2 * MINUTE + 1000);
    await watcher.tick();
    expect(entry()).toMatchObject({ status: "answered", level: 3, runs: 3 });
    expect(world.responses()).toHaveLength(1);
  });

  it("answers a provider that never comes up with its failing result once the retry window is over", async () => {
    const world = await watchWorld({ tamper: () => new Response("Bad Gateway", { status: 502 }) });
    const { requestHash } = await world.request();
    const watcher = await world.open({ retryForMs: 2 * HOUR });
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "waiting" });

    world.advance(2 * HOUR);
    await watcher.tick();
    const entry = watcher.state.requests[requestHash]!;
    expect(entry).toMatchObject({ status: "answered", level: 0, score: 0 });
    expect(arg(world.responses()[0], "--response")).toBe("0");
    const receipt = JSON.parse(await readFile(join(world.dataDir, "receipts", `${entry.receipt}.json`), "utf8")) as VerificationReceipt;
    // The manifest was never read: the request names the agent and the network.
    expect(receipt).toMatchObject({ agentId: AGENT_ID, network: "stellar:testnet", level: 0 });
    expect(receipt.results[0]).toMatchObject({ check: "C1", status: "failed", failedRules: ["M1"] });
  });

  it("runs a check that could not finish again, three runs at most, then answers", async () => {
    const world = await watchWorld();
    world.registry.agentWallet = async () => {
      throw new Error("the registry can't be read");
    };
    const { requestHash } = await world.request();
    const watcher = await world.open();
    await watcher.tick();
    const entry = () => watcher.state.requests[requestHash]!;
    expect(entry()).toMatchObject({ status: "waiting", incomplete: 1 });
    expect(entry().problem).toMatch(/^some checks could not finish: C2 the agent's wallet could not be read/);
    world.advance(HOUR);
    await watcher.tick();
    expect(entry()).toMatchObject({ status: "waiting", incomplete: 2 });
    world.advance(HOUR);
    await watcher.tick();
    // C2 counts for no level, so the answer is level 3, without "8004 validated".
    expect(entry()).toMatchObject({ status: "answered", incomplete: 3, runs: 3, level: 3 });
    expect(await readdir(join(world.dataDir, "receipts"))).not.toContain(`${entry().receipt}.8004-validated.svg`);
  });

  it("holds every request while the test payer can't pay for a run, and says so at /healthz", async () => {
    const world = await watchWorld();
    world.chain.state.balance = 5_000_000n;
    const { requestHash } = await world.request();
    const watcher = await world.open();
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "waiting", attempts: 0, runs: 0 });
    expect(world.requests).toEqual([]);
    const health = (await (await world.get("/healthz")).json()) as { status: string; problems: string[] };
    expect(health.status).toBe("degraded");
    expect(health.problems[0]).toMatch(/the test payer G[A-Z2-7]{55} holds 0.50 USDC, and a run may sign for 1.00 USDC: fund it/);

    world.chain.state.balance = 1_000_000_000n;
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "answered" });
    expect(await (await world.get("/healthz")).json()).toMatchObject({ status: "ok", requests: { answered: 1 } });
  });
});

describe("verifier watch: never twice", () => {
  it("sends nothing once the request has a response from elsewhere", async () => {
    let live = false;
    const world = await watchWorld({ tamper: (_request, response) => (live ? response : new Response("", { status: 503 })) });
    const { requestHash } = await world.request();
    const watcher = await world.open();
    await watcher.tick();
    // Someone answers it by hand, with `verifier publish`.
    world.validations.set(requestHash, { ...world.validations.get(requestHash)!, hasResponse: true, response: 67, responseHash: "12".repeat(32), tag: VALIDATION_TAG });
    live = true;
    world.advance(HOUR);
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "answered", answeredBy: "other" });
    expect(world.responses()).toEqual([]);
  });

  it("after a crash while sending, waits for the registry to show the response instead of sending it again", async () => {
    const world = await watchWorld();
    const { requestHash } = await world.request();
    // The response lands, but the Stellar CLI fails before it can say so, as a timeout would.
    world.cli.fail = true;
    const first = await world.open();
    await first.tick();
    expect(first.state.requests[requestHash]).toMatchObject({ status: "publishing", sentAt: expect.any(String) });
    expect(world.responses()).toHaveLength(1);

    // A restart on the same data directory.
    world.cli.fail = false;
    const second = await world.open();
    expect(second.state.requests[requestHash]).toMatchObject({ status: "publishing" });
    world.advance(3 * MINUTE);
    await second.tick();
    expect(second.state.requests[requestHash]).toMatchObject({ status: "answered", answeredBy: "watch" });
    expect(world.responses()).toHaveLength(1);
    expect(JSON.parse(await readFile(join(world.dataDir, STATE_FILE), "utf8")).requests[requestHash].status).toBe("answered");
  });

  it("sends the same receipt again when the first response never landed", async () => {
    const world = await watchWorld();
    const { requestHash } = await world.request();
    world.cli.land = false;
    world.cli.fail = true;
    const watcher = await world.open();
    await watcher.tick();
    const receipt = watcher.state.requests[requestHash]!.receipt;
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "publishing", problem: "sending the answer failed; the verifier will try again" });

    // Within two minutes of sending, it waits for the first one.
    world.cli.land = true;
    world.cli.fail = false;
    world.advance(MINUTE + 1000);
    await watcher.tick();
    expect(world.responses()).toHaveLength(1);
    world.advance(2 * MINUTE);
    await watcher.tick();
    expect(world.responses()).toHaveLength(2);
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "answered", answeredBy: "watch", receipt });
    expect(world.responses().map((args) => arg(args, "--response_hash"))).toEqual([receipt, receipt]);
  });

  it("signs nothing when a response lands while it checks the publication", async () => {
    const world = await watchWorld();
    const { requestHash } = await world.request();
    // Someone answers between the watcher's first look at the registry and the checks before signing.
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith(`${PUBLIC_URL}/receipts/`)) {
        world.validations.set(requestHash, { ...world.validations.get(requestHash)!, hasResponse: true, response: 33, responseHash: "34".repeat(32), tag: VALIDATION_TAG });
      }
      return world.fetch(input, init);
    }) as typeof globalThis.fetch;
    const watcher = await world.open({ fetch });
    await watcher.tick();
    expect(watcher.state.requests[requestHash]).toMatchObject({ status: "answered", answeredBy: "other" });
    expect(world.responses()).toEqual([]);
  });

  it("keeps one watcher per data directory", async () => {
    const world = await watchWorld();
    const lock = await lockDataDir(world.dataDir);
    await expect(lockDataDir(world.dataDir)).rejects.toThrow(LockedError);
    await lock.release();
    const again = await lockDataDir(world.dataDir);
    // A lock nobody touched for minutes was left by a watcher that died.
    const old = new Date(Date.now() - 10 * MINUTE);
    await utimes(join(world.dataDir, "watch.lock"), old, old);
    const taken = await lockDataDir(world.dataDir);
    await taken.release();
    await again.release();
  });

  it("refuses another validator's state, and a damaged one", async () => {
    const world = await watchWorld();
    await world.request();
    await (await world.open()).tick();
    await expect(loadState(world.dataDir, "stellar:testnet", Keypair.random().publicKey())).rejects.toThrow(/holds the state of validator/);
    await expect(loadState(world.dataDir, "stellar:pubnet", validator)).rejects.toThrow(StateError);
    await writeFile(join(world.dataDir, STATE_FILE), "{");
    await expect(world.open()).rejects.toThrow(/is not a watcher state file/);
  });
});

describe("verifier watch: HTTP", () => {
  it("serves receipts, badges, request status and /healthz, and nothing else", async () => {
    const world = await watchWorld();
    const watcher = await world.open();
    expect(await (await world.get("/healthz")).json()).toMatchObject({
      status: "ok",
      standard: "stellar-agent-services/provider@1",
      network: "stellar:testnet",
      validator,
      receipts: `${PUBLIC_URL}/receipts/`,
      requests: { waiting: 0, publishing: 0, answered: 0, refused: 0 },
    });
    expect((await world.get(`/receipts/${"a".repeat(64)}.json`)).status).toBe(404);
    expect((await world.get("/receipts/..%2Fstate.json")).status).toBe(404);
    expect((await world.get("/state.json")).status).toBe(404);
    expect((await world.get(`/requests/${"b".repeat(64)}.json`)).status).toBe(404);
    expect((await world.get("/healthz", "POST")).status).toBe(405);

    await world.request();
    await watcher.tick();
    const sha256 = Object.values(watcher.state.requests)[0]!.receipt!;
    const head = await world.get(`/receipts/${sha256}.json`, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("is served on Node's HTTP server", async () => {
    const server = await serveHttp(async (request) => new Response(`${request.method} ${new URL(request.url).pathname}`), 0, "127.0.0.1");
    try {
      expect(await (await fetch(`${server.url}/healthz`)).text()).toBe("GET /healthz");
      expect(await (await fetch(`${server.url}/healthz`, { method: "HEAD" })).text()).toBe("");
      expect((await fetch(`${server.url}/healthz`, { method: "POST", body: "x" })).status).toBe(405);
    } finally {
      await server.close();
    }
  });
});

describe("verifier watch: CLI", () => {
  function cli(world: WatchWorld, extra: Partial<Io> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: {},
      fetch: world.fetch,
      chain: world.reader,
      registry: world.registry,
      payer: world.payer,
      stellar: world.stellar,
      serve: world.serve,
      now: world.now,
      ...extra,
    };
    return { io, out, err, run: (...argv: string[]) => main(argv, io) };
  }
  const required = ["--source", "verifier", "--public-url", PUBLIC_URL];

  it.each<[string[], RegExp]>([
    [["watch"], /watch needs --source \(a key in the Stellar CLI keychain\) and --public-url/],
    [["watch", "--source", "verifier", "--public-url", "http://verifier.test"], /--public-url must be an https:\/\/ URL/],
    [["watch", ...required, "--network", "futurenet"], /--network must be testnet or mainnet/],
    [["watch", ...required, "--network", "mainnet"], /real money: add --allow-pubnet/],
    [["watch", ...required, "--interval", "1"], /--interval must be at least 5 seconds/],
    [["watch", ...required, "--retry-for", "0"], /--retry-for must be a number of hours above zero/],
    [["watch", ...required, "--port", "http"], /--port must be a port number/],
    [["watch", ...required, "--pay"], /--pay does not apply to watch/],
    [["watch", "extra", ...required], /unexpected argument "extra"/],
    [["check", MANIFEST_URL, "--public-url", PUBLIC_URL], /--public-url belongs to watch/],
    [["verify", MANIFEST_URL, "--source", "verifier"], /--source belongs to publish or watch/],
    [["publish", "receipt.json", "--data", "x"], /--data does not apply to publish/],
  ])("refuses %j with exit code 2", async (argv, message) => {
    const { run, err } = cli(await watchWorld());
    expect(await run(...argv)).toBe(2);
    expect(err.join("\n")).toMatch(message);
  });

  it("needs the test payer, and a validator that is not the test payer", async () => {
    const world = await watchWorld();
    const withoutPayer = cli(world);
    delete withoutPayer.io.payer;
    expect(await withoutPayer.run("watch", ...required, "--data", world.dataDir)).toBe(2);
    expect(withoutPayer.err.join("\n")).toMatch(/watch needs the test payer's secret key in VERIFIER_PAYER_SECRET/);
    const same = cli(world, { stellar: async () => `${world.payer.address}\n` });
    expect(await same.run("watch", ...required, "--data", world.dataDir)).toBe(2);
    expect(same.err.join("\n")).toMatch(/the test payer is the validator/);
  });

  it("fails when the Stellar CLI can't read the key, or another watcher holds the data directory", async () => {
    const world = await watchWorld();
    const noKey = cli(world, {
      stellar: async () => {
        throw new Error("no such identity");
      },
    });
    expect(await noKey.run("watch", ...required, "--data", world.dataDir)).toBe(1);
    expect(noKey.err.join("\n")).toMatch(/could not read key "verifier". Create it with: stellar keys generate verifier --network testnet --fund/);

    const lock = await lockDataDir(world.dataDir);
    const locked = cli(world);
    expect(await locked.run("watch", ...required, "--data", world.dataDir)).toBe(1);
    expect(locked.err.join("\n")).toMatch(/another watcher uses/);
    await lock.release();
  });

  it("runs until stopped: finds the request, answers it, then lets go of its data directory", async () => {
    const world = await watchWorld();
    const { requestHash } = await world.request();
    const controller = new AbortController();
    const { run, out } = cli(world, { signal: controller.signal, sleep: async () => controller.abort() });
    expect(await run("watch", ...required, "--data", world.dataDir, "--port", "0")).toBe(0);

    const text = out.join("\n");
    expect(text).toContain(`verifier watch: answering validation requests to ${validator} on stellar:testnet`);
    expect(text).toContain(`receipts    ${PUBLIC_URL}/receipts/<sha256>.json`);
    expect(text).toMatch(/Z {2}request [0-9a-f]{64}: agent 7 asks for validation/);
    expect(text).toMatch(/answered on chain, response 100/);
    expect(text).toContain("verifier watch: stopped");
    expect(world.cli.calls[0]).toEqual(["keys", "address", "verifier"]);
    expect(world.validations.get(requestHash)).toMatchObject({ hasResponse: true, response: 100 });
    expect(await readdir(world.dataDir)).not.toContain("watch.lock");
  });
});
