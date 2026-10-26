// The test payer: the dedicated, funded testnet account the paid checks (C4, C5, C7) pay with.
//
// The wallet keeps the rules a careful client keeps, plus the verifier's own:
// - it signs only what a check asks for, after the challenge matched the manifest [P7];
// - every price must be within maxPrice, and everything signed in one run within maxSpend. A signed
//   payment counts whether or not it settles, since the provider could still settle it;
// - pubnet (real money) only with allowPubnet;
// - each signed payment is decoded and compared with what was asked before it is sent: the payment
//   must move exactly the asset and amount to payTo, from the payer, and nothing else;
// - it records each payment's nonce and expiration ledger, which prove on chain later whether it landed.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { Keypair, Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { signedTransfers, type ChainReader, type PaymentRecord } from "./chain.js";

/** Who pays. localKeyPayer() is the real one; tests sign offline. */
export interface Payer {
  /** The paying account. */
  readonly address: string;
  /** Signs an x402 `exact` payment for the requirements and returns its payload. Never submits it. */
  sign(requirements: PaymentRequirements): Promise<{ transaction: string }>;
}

/**
 * A payer with a secret key in memory, signing through the public x402 Stellar client, which builds the
 * transfer with a Soroban RPC (`rpcUrl`, default the network's public one).
 */
export function localKeyPayer(secret: string, options: { rpcUrl?: string } = {}): Payer {
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new TypeError("not a Stellar secret key (S...)");
  return {
    address: Keypair.fromSecret(secret).publicKey(),
    async sign(requirements) {
      const signer = createEd25519Signer(secret, requirements.network as StellarNetwork);
      const scheme = new ExactStellarScheme(signer, options.rpcUrl === undefined ? undefined : { url: options.rpcUrl });
      const { payload } = await scheme.createPaymentPayload(2, requirements);
      const transaction = (payload as { transaction?: unknown }).transaction;
      if (typeof transaction !== "string") throw new Error("the x402 client returned no transaction");
      return { transaction };
    },
  };
}

/** The payment would break the verifier's own limits. Nothing was signed. */
export class PaymentRefused extends Error {
  override name = "PaymentRefused";
}

export interface WalletLimits {
  /** Highest price of one job, in base units. */
  maxPrice: bigint;
  /** Most the run may sign for, in base units. */
  maxSpend: bigint;
  allowPubnet: boolean;
}

/** One payment the wallet signed. `header` is a bearer credential: never logged, never in evidence. */
export interface SignedPayment extends PaymentRecord {
  network: StellarNetwork;
  /** Which check paid, and for what. */
  label: string;
  /** The PAYMENT-SIGNATURE header value. */
  header: string;
  /** The signed transaction, base64. A provider must never echo it [E2]. */
  transaction: string;
}

export class Wallet {
  readonly payments: SignedPayment[] = [];
  private spentUnits = 0n;

  constructor(
    private readonly payer: Payer,
    private readonly chain: ChainReader,
    private readonly limits: WalletLimits,
  ) {}

  get address(): string {
    return this.payer.address;
  }

  /** Base units signed for so far. */
  get spent(): bigint {
    return this.spentUnits;
  }

  /** Why a payment of `amount` would be refused, or undefined if it fits the limits. */
  refusal(requirements: Pick<PaymentRequirements, "amount" | "network">, count = 1): string | undefined {
    if (requirements.network === "stellar:pubnet" && !this.limits.allowPubnet) return "the provider is on pubnet, which costs real money: allow it explicitly";
    if (!/^[1-9][0-9]{0,37}$/.test(requirements.amount)) return "the price is not a positive amount in base units";
    const amount = BigInt(requirements.amount);
    if (amount > this.limits.maxPrice) return `the price, ${formatUsdc(amount)}, is above the verifier's limit of ${formatUsdc(this.limits.maxPrice)} per job`;
    if (this.spentUnits + amount * BigInt(count) > this.limits.maxSpend) {
      return `paying ${count} × ${formatUsdc(amount)} would take the run above its limit of ${formatUsdc(this.limits.maxSpend)} (${formatUsdc(this.spentUnits)} signed so far)`;
    }
    return undefined;
  }

  /** Signs one payment for the requirements. Throws PaymentRefused when it breaks a limit. */
  async sign(requirements: PaymentRequirements, resource: ResourceInfo | undefined, label: string): Promise<SignedPayment> {
    const refusal = this.refusal(requirements);
    if (refusal !== undefined) throw new PaymentRefused(refusal);
    const signedAfterLedger = (await this.chain.getLatestLedger()).sequence;
    const { transaction } = await this.payer.sign(requirements);
    // Counted as soon as it exists: a signed payment may be settled, whatever happens next.
    this.spentUnits += BigInt(requirements.amount);

    const passphrase = requirements.network === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET;
    const transfers = signedTransfers(TransactionBuilder.fromXDR(transaction, passphrase).toEnvelope());
    const [signed] = transfers;
    if (
      transfers.length !== 1 ||
      signed === undefined ||
      signed.payer !== this.payer.address ||
      signed.from !== this.payer.address ||
      signed.asset !== requirements.asset ||
      signed.payTo !== requirements.payTo ||
      signed.amount !== requirements.amount
    ) {
      throw new Error("the payer signed something other than the approved transfer; it was not sent");
    }

    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      ...(resource === undefined ? {} : { resource }),
      accepted: requirements,
      payload: { transaction },
    });
    const payment: SignedPayment = {
      network: requirements.network as StellarNetwork,
      label,
      header,
      transaction,
      payer: signed.payer,
      nonce: signed.nonce,
      asset: signed.asset,
      payTo: signed.payTo,
      amount: signed.amount,
      signedAfterLedger,
      expirationLedger: signed.expirationLedger,
    };
    this.payments.push(payment);
    return payment;
  }
}

/** Base units of USDC (7 decimals) as "0.01 USDC". */
export function formatUsdc(units: bigint): string {
  const whole = units / 10_000_000n;
  const fraction = (units % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")} USDC`;
}

/** "0.10" (USDC) as base units. Undefined when it is not an amount with at most 7 decimals. */
export function parseUsdc(decimal: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal.trim());
  if (match === null) return undefined;
  return BigInt(match[1]! + (match[2] ?? "").padEnd(7, "0"));
}
