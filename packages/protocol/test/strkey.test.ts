import { randomBytes } from "node:crypto";
import { Account, Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { stellarAddressKind } from "../src/index.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Replaces one character with another base32 character. */
function mutate(address: string): string {
  const index = Math.floor(Math.random() * address.length);
  const current = ALPHABET.indexOf(address[index] ?? "A");
  const replacement = ALPHABET[(current + 1 + Math.floor(Math.random() * 31)) % 32] ?? "A";
  return address.slice(0, index) + replacement + address.slice(index + 1);
}

describe("stellarAddressKind", () => {
  it("agrees with @stellar/stellar-sdk on random addresses and one-character changes", () => {
    for (let i = 0; i < 300; i++) {
      const account = StrKey.encodeEd25519PublicKey(randomBytes(32));
      const contract = StrKey.encodeContract(randomBytes(32));
      expect(stellarAddressKind(account)).toBe("account");
      expect(stellarAddressKind(contract)).toBe("contract");

      const changedAccount = mutate(account);
      const changedContract = mutate(contract);
      expect(stellarAddressKind(changedAccount) === "account").toBe(StrKey.isValidEd25519PublicKey(changedAccount));
      expect(stellarAddressKind(changedContract) === "contract").toBe(StrKey.isValidContract(changedContract));
    }
  });

  it("rejects other kinds of strkey", () => {
    const keypair = Keypair.random();
    const others = [
      keypair.secret(),
      new MuxedAccount(new Account(keypair.publicKey(), "0"), "7").accountId(),
      StrKey.encodePreAuthTx(randomBytes(32)),
      StrKey.encodeSha256Hash(randomBytes(32)),
    ];
    for (const address of others) expect(stellarAddressKind(address)).toBeUndefined();
  });

  it("rejects malformed text", () => {
    const account = Keypair.random().publicKey();
    for (const text of [account.toLowerCase(), account.slice(1), `${account}A`, `${account.slice(0, 55)}=`, `${account.slice(0, 55)}1`, ""]) {
      expect(stellarAddressKind(text)).toBeUndefined();
    }
  });
});
