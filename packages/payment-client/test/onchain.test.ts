import { Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkTransfer, type ExpectedPayment } from "../src/index.js";

const usdc = StrKey.encodeContract(Buffer.alloc(32, 1));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const expected: ExpectedPayment = { network: "stellar:testnet", asset: usdc, amount: "100000", payTo, payer };

function transfer(options: { contract?: string; from?: string; to?: string; data?: xdr.ScVal } = {}): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(options.contract ?? usdc),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          nativeToScVal("transfer", { type: "symbol" }),
          nativeToScVal(options.from ?? payer, { type: "address" }),
          nativeToScVal(options.to ?? payTo, { type: "address" }),
          nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        ],
        data: options.data ?? nativeToScVal(100000n, { type: "i128" }),
      }),
    ),
  });
}

describe("checkTransfer", () => {
  it("confirms the approved transfer", () => {
    expect(checkTransfer([transfer()], expected)).toEqual({ confirmed: true });
  });

  it("reads the amount from a muxed transfer's data map", () => {
    const data = nativeToScVal({ amount: 100000n, to_muxed_id: 7n }, { type: { amount: ["symbol", "i128"], to_muxed_id: ["symbol", "u64"] } });
    expect(checkTransfer([transfer({ data })], expected)).toEqual({ confirmed: true });
  });

  it("ignores transfers of other assets and from other accounts", () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 2));
    const events = [transfer({ contract: other }), transfer({ from: Keypair.random().publicKey() }), transfer()];
    expect(checkTransfer(events, expected)).toEqual({ confirmed: true });
    expect(checkTransfer(events.slice(0, 2), expected)).toMatchObject({ confirmed: false, reason: expect.stringMatching(/no transfer/) });
  });

  it("rejects a different payee", () => {
    expect(checkTransfer([transfer({ to: Keypair.random().publicKey() })], expected)).toMatchObject({ confirmed: false, reason: expect.stringMatching(/went to/) });
  });

  it("rejects a different amount", () => {
    const data = nativeToScVal(100001n, { type: "i128" });
    expect(checkTransfer([transfer({ data })], expected)).toMatchObject({ confirmed: false, reason: expect.stringMatching(/moved 100001/) });
  });

  it("rejects more than one transfer from the payer", () => {
    expect(checkTransfer([transfer(), transfer()], expected)).toMatchObject({ confirmed: false, reason: expect.stringMatching(/2 transfers/) });
  });
});
