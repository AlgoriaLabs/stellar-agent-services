import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Networks, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { ApprovalConflict, ApprovalError, ApprovalSession, startApprovalServer, type ApprovalPlan, type ApprovalStep } from "../src/cli/approval.js";
import { contractError, describeResult, formatUsdc, formatXlm, verifySigned } from "../src/cli/owner-chain.js";
import { accountSteps } from "../src/cli/owner-steps.js";
import { account, fakeChain, signed, type FakeChain } from "./support/owner.js";

// Approving in the developer's own wallet: the session sends only the very transaction it built, signed by the
// connected account, and never sends one twice. The page and its API answer only the tab the terminal's link opened.

function plan(chain: FakeChain, options: { expected?: string; steps?: (address: string) => Promise<ApprovalStep[]> } = {}): ApprovalPlan {
  return {
    command: "provider-kit test",
    title: "Test",
    intro: "A test plan.",
    network: chain.network,
    ...(options.expected === undefined ? {} : { account: { address: options.expected, label: "Payout account", reason: "It is paid." } }),
    outline: [{ id: "trustline", title: "Add USDC" }],
    async steps(address) {
      if (options.expected !== undefined && address !== options.expected) throw new ApprovalError("Connect your payout account", "Another account.", "connect");
      return options.steps === undefined ? accountSteps(chain, address, { trustline: true }) : options.steps(address);
    },
    result: () => ({ title: "Done", message: "All set.", details: [] }),
  };
}

/** A session whose account exists without a USDC trustline, waiting for its approval. */
async function waiting(chain = fakeChain()) {
  const owner = account();
  chain.accounts.set(owner.publicKey(), { usdcTrustline: false });
  const session = new ApprovalSession(plan(chain), chain);
  await session.connect(owner.publicKey(), "Freighter");
  return { chain, owner, session, review: session.view().review! };
}

describe("ApprovalSession", () => {
  it("runs the steps in order, builds each transaction when it is due, and sends what the account signed", async () => {
    const chain = fakeChain();
    const owner = account();
    const session = new ApprovalSession(plan(chain), chain);
    expect(session.view()).toMatchObject({ state: "connect", steps: [{ id: "trustline", status: "pending" }] });

    await session.connect(owner.publicKey(), "Freighter");
    // A new testnet account gets test XLM first. Then the trustline waits for approval, and nothing is sent.
    expect(chain.funded).toEqual([owner.publicKey()]);
    const view = session.view();
    expect(view).toMatchObject({
      state: "review",
      connected: { address: owner.publicKey(), wallet: "Freighter" },
      review: { stepId: "trustline", title: "Add USDC", maxFee: "0.00001 XLM" },
    });
    expect(view.steps.map(({ id, status }) => [id, status])).toEqual([
      ["fund", "done"],
      ["trustline", "active"],
    ]);
    expect(view.review!.expiresAt).toBeGreaterThan(Date.now());
    expect(chain.sent).toEqual([]);

    await session.submit("trustline", signed(view.review!.xdr, owner, chain.passphrase));
    expect(chain.sent.map((transaction) => transaction.hash().toString("hex"))).toEqual([view.review!.hash]);
    expect(await session.finished).toEqual({ status: "done", address: owner.publicKey() });
    expect(session.view()).toMatchObject({
      state: "done",
      result: { title: "Done" },
      steps: [{ status: "done", note: "funded by Friendbot" }, { status: "done", note: "USDC trustline added", transaction: { hash: view.review!.hash } }],
    });
  });

  it("sends nothing the wallet changed, or signed with another account or for another network", async () => {
    const { chain, owner, session, review } = await waiting();

    await session.submit("trustline", signed(review.xdr, account(), chain.passphrase));
    expect(session.view()).toMatchObject({ state: "review", error: { title: "The signature doesn't match", retry: "rebuild" } });
    expect(session.view().review).toBeUndefined();

    await session.rebuild("trustline");
    const mainnet = TransactionBuilder.fromXDR(session.view().review!.xdr, Networks.PUBLIC) as Transaction;
    mainnet.sign(owner);
    await session.submit("trustline", mainnet.toXDR());
    expect(session.view().error).toMatchObject({ title: "The signature doesn't match" });

    await session.rebuild("trustline");
    const other = await chain.trustline(owner.publicKey());
    await session.submit("trustline", signed(other.toXDR(), owner, chain.passphrase));
    expect(session.view().error).toMatchObject({ title: "The wallet changed the transaction" });

    await session.submit("trustline", "not a transaction").catch((error: unknown) => error);
    expect(chain.sent).toEqual([]);

    await session.rebuild("trustline");
    await session.submit("trustline", signed(session.view().review!.xdr, owner, chain.passphrase));
    expect(session.state).toBe("done");
    expect(chain.sent).toHaveLength(1);
  });

  it("lets a refused transaction be prepared again, and stops for good when a transaction's fate is unknown", async () => {
    const refused = fakeChain();
    refused.answers.push("failed");
    const first = await waiting(refused);
    await first.session.submit("trustline", signed(first.review.xdr, first.owner, refused.passphrase));
    expect(first.session.view()).toMatchObject({ state: "review", error: { title: "Add USDC didn't go through", retry: "rebuild" } });
    await first.session.rebuild("trustline");
    await first.session.submit("trustline", signed(first.session.view().review!.xdr, first.owner, refused.passphrase));
    expect(first.session.state).toBe("done");
    expect(refused.sent).toHaveLength(2);

    const lost = fakeChain();
    lost.answers.push("unknown");
    const second = await waiting(lost);
    await second.session.submit("trustline", signed(second.review.xdr, second.owner, lost.passphrase));
    expect(await second.session.finished).toMatchObject({ status: "failed", reason: expect.stringMatching(/isn't confirmed/) });
    expect(second.session.view()).toMatchObject({
      state: "failed",
      result: { title: "Stopped", details: [{ label: "Add USDC, not confirmed", value: second.review.hash }] },
    });
    // Nothing can send it, or anything else, again.
    await expect(second.session.rebuild("trustline")).rejects.toThrow(ApprovalConflict);
    await expect(second.session.submit("trustline", signed(second.review.xdr, second.owner, lost.passphrase))).rejects.toThrow(ApprovalConflict);
    expect(lost.sent).toHaveLength(1);
  });

  it("goes back to connecting when the command refuses the account, or the address isn't an account", async () => {
    const chain = fakeChain();
    const expected = account();
    const session = new ApprovalSession(plan(chain, { expected: expected.publicKey() }), chain);

    await session.connect(account().publicKey());
    expect(session.view()).toMatchObject({ state: "connect", error: { title: "Connect your payout account", retry: "connect" } });
    expect(session.view().connected).toBeUndefined();

    await session.connect("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(session.view().error).toMatchObject({ title: "Connect a Stellar account" });

    await session.connect(expected.publicKey());
    expect(session.view()).toMatchObject({ state: "review", connected: { address: expected.publicKey() } });
    expect(session.view().error).toBeUndefined();
  });

  it("stops when a step can't go on, such as a new account on Mainnet", async () => {
    const chain = fakeChain("stellar:pubnet");
    const session = new ApprovalSession(plan(chain), chain);
    await session.connect(account().publicKey());
    expect(session.view()).toMatchObject({ state: "connect", error: { title: "This account isn't on Stellar Mainnet yet" } });
    expect(chain.funded).toEqual([]);
  });

  it("cancels at once when idle, or as soon as the step under way finishes", async () => {
    const idle = new ApprovalSession(plan(fakeChain()), fakeChain());
    idle.cancel();
    expect(await idle.finished).toEqual({ status: "cancelled" });
    expect(idle.view().result).toMatchObject({ title: "Cancelled", message: "Nothing was signed." });
    expect(() => idle.cancel()).toThrow(ApprovalConflict);

    let release!: () => void;
    let started!: () => void;
    const funding = new Promise<void>((resolve) => (started = resolve));
    const slow = fakeChain();
    slow.fund = async (address) => {
      started();
      await new Promise<void>((resolve) => (release = resolve));
      slow.accounts.set(address, { usdcTrustline: false });
    };
    const busy = new ApprovalSession(plan(slow), slow);
    const connecting = busy.connect(account().publicKey());
    await funding;
    expect(busy.busy).toBe(true);
    expect(() => busy.cancel()).toThrow(ApprovalConflict);
    busy.cancel(true);
    release();
    await connecting;
    expect(await busy.finished).toEqual({ status: "cancelled" });
    expect(slow.sent).toEqual([]);
  });

  it("expires when left alone", async () => {
    const { session } = await waiting();
    session.expire();
    expect(await session.finished).toEqual({ status: "expired" });
    expect(session.view()).toMatchObject({ state: "cancelled", result: { title: "This page timed out" } });
  });

  it("stops without retrying when a transaction went through but its result can't be read", async () => {
    const chain = fakeChain();
    const owner = account();
    chain.accounts.set(owner.publicKey(), { usdcTrustline: true });
    const step: ApprovalStep = {
      kind: "sign",
      id: "register",
      title: "Register",
      build: async () => ({ transaction: await chain.trustline(owner.publicKey()), summary: "Registers.", details: [] }),
      done: () => {
        throw new Error("the registry returned no agent id");
      },
    };
    const session = new ApprovalSession(plan(chain, { steps: async () => [step] }), chain);
    await session.connect(owner.publicKey());
    await session.submit("register", signed(session.view().review!.xdr, owner, chain.passphrase));
    expect(await session.finished).toMatchObject({ status: "failed", reason: expect.stringMatching(/went through, but its result can't be read/) });
  });
});

describe("the approval page's server", () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-kit-approval-"));
  const page = join(directory, "page");
  mkdirSync(join(page, "assets"), { recursive: true });
  writeFileSync(join(page, "index.html"), "<!doctype html><title>Approve</title>");
  writeFileSync(join(page, "assets", "app.js"), "console.log('page');");
  writeFileSync(join(page, "assets", ".hidden.js"), "hidden");
  writeFileSync(join(page, "notes.txt"), "not part of the page");
  writeFileSync(join(directory, "secret.js"), "outside the page");
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  async function serve() {
    const chain = fakeChain();
    const owner = account();
    chain.accounts.set(owner.publicKey(), { usdcTrustline: false });
    const session = new ApprovalSession(plan(chain), chain);
    const server = await startApprovalServer(session, { port: 0, page: pathToFileURL(`${page}/`) });
    const token = server.url.split("#")[1]!;
    const origin = `http://localhost:${server.port}`;
    const send = (path: string, options: Omit<Call, "port" | "path"> = {}) => call({ port: server.port, path, ...options });
    const api = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      send(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { chain, owner, session, server, token, origin, send, api };
  }

  it("links to localhost with the token in the fragment, and serves the page with a strict policy", async () => {
    const { server, send } = await serve();
    expect(server.url).toMatch(new RegExp(`^http://localhost:${server.port}/#[A-Za-z0-9_-]{43}$`));

    const index = await send("/");
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(index.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(index.headers["x-frame-options"]).toBe("DENY");
    expect(index.headers["referrer-policy"]).toBe("no-referrer");
    expect(index.headers["cache-control"]).toBe("no-store");
    expect(index.body).toContain("<title>Approve</title>");
    expect((await send("/assets/app.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");

    // Only the built page's own files.
    for (const path of ["/../secret.js", "/assets/%2e%2e/%2e%2e/secret.js", "/assets/.hidden.js", "/notes.txt", "/missing.js"]) {
      expect((await send(path)).status, path).toBe(404);
    }
    expect((await send("/", { method: "POST" })).status).toBe(405);
    await server.close();
  });

  it("answers the API only with the session's token, from this page, on this host", async () => {
    const { server, token, send, api } = await serve();
    expect((await send("/api/session")).status).toBe(401);
    expect((await send("/api/session", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await send("/api/session", { headers: { Authorization: `Bearer ${token}`, Host: `evil.example:${server.port}` } })).status).toBe(403);
    expect((await api("/api/session", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await api("/api/session", undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);

    const session = await api("/api/session");
    expect(session.status).toBe(200);
    expect(JSON.parse(session.body)).toMatchObject({ state: "connect", network: { id: "stellar:testnet", name: "Stellar Testnet" } });
    await server.close();
  });

  it("takes only JSON objects of a sensible size", async () => {
    const { server, api, owner } = await serve();
    expect((await api("/api/connect", { address: owner.publicKey() }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await api("/api/connect", "a string")).status).toBe(400);
    expect((await api("/api/connect", { address: "x".repeat(300 * 1024) })).status).toBe(413);
    expect((await api("/api/unknown", {})).status).toBe(404);
    await server.close();
  });

  it("runs the session over the API, and answers a request it can't take with where it stands", async () => {
    const { server, api, chain, owner, session } = await serve();
    const missing = await api("/api/connect", {});
    expect(missing.status).toBe(409);
    expect(JSON.parse(missing.body)).toMatchObject({ message: "address is missing.", view: { state: "connect" } });

    const connected = JSON.parse((await api("/api/connect", { address: owner.publicKey(), wallet: "Freighter" })).body);
    expect(connected).toMatchObject({ state: "review", connected: { wallet: "Freighter" }, review: { stepId: "trustline" } });

    const stale = await api("/api/submit", { stepId: "register", signedTxXdr: "AAAA" });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body).view).toMatchObject({ state: "review" });

    const done = JSON.parse((await api("/api/submit", { stepId: "trustline", signedTxXdr: signed(connected.review.xdr, owner, chain.passphrase) })).body);
    expect(done).toMatchObject({ state: "done", result: { title: "Done" } });
    expect(await session.finished).toMatchObject({ status: "done" });
    expect((await api("/api/cancel", {})).status).toBe(409);
    await server.close();
  });

  it("cancels from the page", async () => {
    const { server, api, session } = await serve();
    expect(JSON.parse((await api("/api/cancel", {})).body)).toMatchObject({ state: "cancelled", result: { title: "Cancelled" } });
    expect(await session.finished).toEqual({ status: "cancelled" });
    await server.close();
  });

  it("expires a session left idle", async () => {
    const chain = fakeChain();
    const session = new ApprovalSession(plan(chain), chain);
    const server = await startApprovalServer(session, { port: 0, page: pathToFileURL(`${page}/`), idleMs: 20 });
    expect(await session.finished).toEqual({ status: "expired" });
    await server.close();
  });
});

describe("the owner's transactions", () => {
  it("are refused unless signed, unchanged, by the account", async () => {
    const chain = fakeChain();
    const owner = account();
    chain.accounts.set(owner.publicKey(), { usdcTrustline: false });
    const built = await chain.trustline(owner.publicKey());
    const signedXdr = signed(built.toXDR(), owner, chain.passphrase);
    expect(verifySigned(built, signedXdr, owner.publicKey(), chain.network, chain.passphrase).hash()).toEqual(built.hash());
    expect(() => verifySigned(built, built.toXDR(), owner.publicKey(), chain.network, chain.passphrase)).toThrow(/isn't signed by/);
    expect(() => verifySigned(built, signedXdr, account().publicKey(), chain.network, chain.passphrase)).toThrow(/isn't signed by/);
  });

  it("explain why the network refused them", () => {
    const result = (outcome: xdr.TransactionResultResult) => ({ result: () => outcome }) as unknown as xdr.TransactionResult;
    expect(describeResult(result(xdr.TransactionResultResult.txBadSeq()))).toBe("The account sent another transaction first.");
    const lowReserve = xdr.TransactionResultResult.txFailed([xdr.OperationResult.opInner(xdr.OperationResultTr.changeTrust(xdr.ChangeTrustResult.changeTrustLowReserve()))]);
    expect(describeResult(result(lowReserve))).toMatch(/needs 0\.5 XLM more to hold USDC/);
    // The operation that failed is named, not the first one, which succeeded before it.
    const noOffers = xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(xdr.OperationResultTr.changeTrust(xdr.ChangeTrustResult.changeTrustSuccess())),
      xdr.OperationResult.opInner(xdr.OperationResultTr.pathPaymentStrictReceive(xdr.PathPaymentStrictReceiveResult.pathPaymentStrictReceiveTooFewOffers())),
    ]);
    expect(describeResult(result(noOffers))).toBe("The testnet DEX has no test USDC for sale right now.");
    expect(describeResult(result(xdr.TransactionResultResult.txFrozenKeyAccessed()))).toBe("Stellar answered txFrozenKeyAccessed.");
    expect(describeResult(undefined)).toMatch(/without saying why/);
  });

  it("explain the registries' errors, and what to do about them", () => {
    expect(contractError("identity", new Error("HostError: Error(Contract, #1)\nEvent log: ..."))).toMatchObject({ title: "This account can't change the agent", retry: "connect" });
    expect(contractError("validation", new Error("HostError: Error(Contract, #4)"))).toMatchObject({ title: "This request was already sent" });
    expect(contractError("validation", new Error("HostError: Error(Contract, #99)"))).toMatchObject({ title: "The contract refused the call", retry: "rebuild" });
    expect(contractError("identity", new Error("network down\nmore"))).toMatchObject({ message: "Simulating it failed: network down" });
  });

  it("show fees in XLM, and prices in USDC", () => {
    expect(formatXlm(100)).toBe("0.00001 XLM");
    expect(formatXlm("336151")).toBe("0.0336151 XLM");
    expect(formatXlm(20_000_000n)).toBe("2 XLM");
    expect(formatUsdc("100000")).toBe("0.01 USDC");
    expect(formatUsdc(1_000_000n)).toBe("0.10 USDC");
    expect(formatUsdc("12345")).toBe("0.0012345 USDC");
    expect(formatUsdc("20000000")).toBe("2.00 USDC");
  });
});

interface Call {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A raw HTTP request, so a test can send any Host or Origin header. */
function call({ port, path, method = "GET", headers = {}, body }: Call): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}
