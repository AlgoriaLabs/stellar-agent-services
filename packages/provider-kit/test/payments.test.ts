import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { USDC_ASSET } from "@stellar-agent-services/protocol";
import { Account, Keypair, Networks, Operation, TimeoutInfinite, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkFacilitator, checkPayment, httpFacilitator, isRefused, neverSubmitted, settle, type CheckedPayment, type Facilitator } from "../src/index.js";
import { signTestPayment } from "../src/testing.js";

const payer = Keypair.random();
const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: USDC_ASSET["stellar:testnet"],
  amount: "100000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

/** Rebuilds the payment's transaction with `change` applied to its one operation. */
function rebuild(payload: PaymentPayload, change: (operation: xdr.Operation) => xdr.Operation[]): PaymentPayload {
  const transaction = new Transaction((payload.payload as { transaction: string }).transaction, Networks.TESTNET);
  const builder = new TransactionBuilder(new Account(transaction.source, "0"), { fee: "100", networkPassphrase: Networks.TESTNET }).setTimeout(TimeoutInfinite);
  for (const operation of change(transaction.toEnvelope().v1().tx().operations()[0]!)) builder.addOperation(operation);
  return { ...payload, payload: { transaction: builder.build().toXDR() } };
}

const invoke = (operation: xdr.Operation) => operation.body().invokeHostFunctionOp();
const withAuth = (operation: xdr.Operation, auth: xdr.SorobanAuthorizationEntry[]) =>
  Operation.invokeHostFunction({ func: invoke(operation).hostFunction(), auth });

describe("checkPayment", () => {
  it("accepts the x402 exact transfer and reads the payer, nonce and fingerprint", async () => {
    const result = await checkPayment(await signTestPayment(requirements, payer, { nonce: 42n, expirationLedger: 555 }), requirements);
    expect(isRefused(result)).toBe(false);
    expect(result).toMatchObject({ payer: payer.publicKey(), nonce: "42", expirationLedger: 555, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("gives one fingerprint per (payer, nonce), however the auth entry is wrapped", async () => {
    const payload = await signTestPayment(requirements, payer, { nonce: 9n });
    const wrapped = rebuild(payload, (operation) => [withAuth(operation, invoke(operation).auth())]);
    const fingerprints = await Promise.all([payload, wrapped].map(async (each) => ((await checkPayment(each, requirements)) as CheckedPayment).fingerprint));
    expect(fingerprints[0]).toBe(fingerprints[1]);

    const other = (await checkPayment(await signTestPayment(requirements, payer, { nonce: 10n }), requirements)) as CheckedPayment;
    expect(other.fingerprint).not.toBe(fingerprints[0]);
  });

  it.each([
    ["another recipient", { override: { payTo: Keypair.random().publicKey() } }, "wrong_recipient"],
    ["another amount", { override: { amount: "100001" } }, "wrong_amount"],
    ["another asset", { override: { asset: USDC_ASSET["stellar:pubnet"] } }, "wrong_asset"],
  ])("refuses a payment to %s", async (_case, options, reason) => {
    const result = await checkPayment(await signTestPayment(requirements, payer, options), requirements);
    expect(result).toEqual({ reason: `invalid_exact_stellar_payload_${reason}` });
  });

  it("refuses a payment the payer did not sign, or signed for something else", async () => {
    const payload = await signTestPayment(requirements, payer);
    const unsigned = rebuild(payload, (operation) => {
      const [entry] = invoke(operation).auth();
      entry!.credentials().address().signature(xdr.ScVal.scvVoid());
      return [withAuth(operation, [entry!])];
    });
    expect(await checkPayment(unsigned, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_missing_payer_signature" });

    const otherAmount = await signTestPayment(requirements, payer, { override: { amount: "1" } });
    const mismatched = rebuild(payload, (operation) => [withAuth(operation, invoke(new Transaction((otherAmount.payload as { transaction: string }).transaction, Networks.TESTNET).toEnvelope().v1().tx().operations()[0]!).auth())]);
    expect(await checkPayment(mismatched, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_auth_mismatch" });

    const byOther = await signTestPayment(requirements, Keypair.random());
    const foreign = rebuild(payload, (operation) => [withAuth(operation, invoke(new Transaction((byOther.payload as { transaction: string }).transaction, Networks.TESTNET).toEnvelope().v1().tx().operations()[0]!).auth())]);
    expect(await checkPayment(foreign, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_auth_not_by_payer" });
  });

  it("refuses extra operations, missing or extra auth entries and garbage", async () => {
    const payload = await signTestPayment(requirements, payer);
    const twice = rebuild(payload, (operation) => [withAuth(operation, invoke(operation).auth()), withAuth(operation, invoke(operation).auth())]);
    expect(await checkPayment(twice, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_wrong_operation" });
    expect(await checkPayment(rebuild(payload, (operation) => [withAuth(operation, [])]), requirements)).toEqual({ reason: "invalid_exact_stellar_payload_no_auth_entries" });
    const doubled = rebuild(payload, (operation) => [withAuth(operation, [...invoke(operation).auth(), ...invoke(operation).auth()])]);
    expect(await checkPayment(doubled, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_multiple_auth_entries" });
    expect(await checkPayment({ ...payload, payload: { transaction: "not xdr" } }, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_malformed" });
    expect(await checkPayment({ ...payload, payload: {} }, requirements)).toEqual({ reason: "invalid_exact_stellar_payload_malformed" });
  });
});

describe("settle", () => {
  const facilitator = (response: Awaited<ReturnType<Facilitator["settle"]>> | Error): Facilitator => ({
    verify: async () => ({ isValid: true }),
    settle: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
  });
  const hash = "ab".repeat(32);
  const run = async (response: Parameters<typeof facilitator>[0]) =>
    settle(facilitator(response), await signTestPayment(requirements, payer), requirements, payer.publicKey());

  it("is settled only with a transaction hash, for the checked payer and network", async () => {
    expect(await run({ success: true, transaction: hash, network: "stellar:testnet", payer: payer.publicKey() })).toMatchObject({
      outcome: "settled",
      receipt: { transaction: hash, payer: payer.publicKey(), amount: "100000", payTo: requirements.payTo },
    });
    expect(await run({ success: true, transaction: "", network: "stellar:testnet" })).toMatchObject({ outcome: "uncertain" });
    expect(await run({ success: true, transaction: hash, network: "stellar:testnet", payer: Keypair.random().publicKey() })).toMatchObject({
      outcome: "uncertain",
      transaction: hash,
    });
    expect(await run({ success: true, transaction: hash, network: "stellar:pubnet" })).toMatchObject({ outcome: "uncertain" });
  });

  it("is failed only for a reason that means it was never submitted", async () => {
    expect(await run({ success: false, transaction: "", network: "stellar:testnet", errorReason: "invalid_exact_stellar_payload_wrong_amount" })).toMatchObject({ outcome: "failed" });
    // A transaction hash means it was submitted: only the chain can say what happened.
    expect(await run({ success: false, transaction: hash, network: "stellar:testnet", errorReason: "settle_exact_stellar_transaction_failed" })).toEqual({
      outcome: "uncertain",
      reason: "settle_exact_stellar_transaction_failed",
      transaction: hash,
    });
    expect(await run({ success: false, transaction: "", network: "stellar:testnet", errorReason: "unexpected_settle_error" })).toMatchObject({ outcome: "uncertain" });
    expect(await run(new Error("socket hang up"))).toMatchObject({ outcome: "uncertain", reason: "Error: socket hang up" });
    expect(neverSubmitted("settle_exact_stellar_transaction_submission_failed")).toBe(true);
    expect(neverSubmitted("anything_else")).toBe(false);
  });
});

describe("httpFacilitator", () => {
  let server: Server;
  let url: string;
  const handler = vi.fn<(path: string, body: unknown) => { status: number; body: unknown; headers?: Record<string, string> }>();

  beforeAll(async () => {
    server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => {
        const answer = handler(request.url ?? "", text === "" ? undefined : JSON.parse(text));
        response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
        response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/facilitator`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("refuses http:// outside development, and URLs with user info or a query", () => {
    expect(() => httpFacilitator("http://facilitator.example")).toThrow(/https/);
    expect(() => httpFacilitator("https://user:pass@facilitator.example")).toThrow(/user info/);
    expect(() => httpFacilitator("https://facilitator.example/?key=1")).toThrow(/query/);
  });

  it("sends only what verify and settle need, and reads their answers", async () => {
    const payload = { ...(await signTestPayment(requirements, payer)), resource: { url: "https://x", description: "", mimeType: "" } } as PaymentPayload;
    handler.mockImplementation((path) =>
      path.endsWith("/verify")
        ? { status: 200, body: { isValid: true, payer: payer.publicKey() } }
        : { status: 200, body: { success: true, transaction: "ab".repeat(32), network: "stellar:testnet" } },
    );
    const facilitator = httpFacilitator(url, { dev: true });
    expect(await facilitator.verify(payload, requirements)).toEqual({ isValid: true, payer: payer.publicKey() });
    expect(await facilitator.settle(payload, requirements)).toMatchObject({ success: true, transaction: "ab".repeat(32) });
    const sent = handler.mock.calls[0]![1] as { paymentPayload: Record<string, unknown> };
    expect(Object.keys(sent.paymentPayload).sort()).toEqual(["accepted", "payload", "x402Version"]);
  });

  it("reads a 400 that carries a verify or settle answer, and throws on anything else", async () => {
    const payload = await signTestPayment(requirements, payer);
    const facilitator = httpFacilitator(url, { dev: true });
    handler.mockReturnValue({ status: 400, body: { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" } });
    expect(await facilitator.verify(payload, requirements)).toMatchObject({ isValid: false });
    handler.mockReturnValue({ status: 400, body: { success: false, transaction: "", network: "stellar:testnet", errorReason: "invalid_x" } });
    expect(await facilitator.settle(payload, requirements)).toMatchObject({ success: false, errorReason: "invalid_x" });
    handler.mockReturnValue({ status: 502, body: "<html>bad gateway</html>" });
    await expect(facilitator.settle(payload, requirements)).rejects.toThrow(/without JSON/);
  });

  it("never follows a redirect", async () => {
    handler.mockReturnValue({ status: 307, body: {}, headers: { Location: "https://elsewhere.example/settle" } });
    await expect(httpFacilitator(url, { dev: true }).settle(await signTestPayment(requirements, payer), requirements)).rejects.toThrow();
  });

  it("checks at startup that the network, scheme and fee sponsorship are supported", async () => {
    const facilitator = httpFacilitator(url, { dev: true });
    handler.mockReturnValue({ status: 200, body: { kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }] } });
    await expect(checkFacilitator(facilitator, "stellar:testnet")).resolves.toBeUndefined();
    await expect(checkFacilitator(facilitator, "stellar:pubnet")).rejects.toThrow(/does not support/);
    handler.mockReturnValue({ status: 200, body: { kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }] } });
    await expect(checkFacilitator(facilitator, "stellar:testnet")).rejects.toThrow(/sponsor/);
  });
});
