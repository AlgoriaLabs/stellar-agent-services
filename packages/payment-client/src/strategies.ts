// The two strategies the core plugs in (docs/payment-client.md, "Strategies"):
//
//   Signer         who holds the key: the built-in local key, later browser wallets, passkey smart
//                  accounts or other policy wallets
//   PaymentMethod  how an x402 challenge entry is paid and proven: the built-in x402 `exact` on Stellar
//
// The core keeps every safety step whatever is plugged in. The terms the user approves come from the
// challenge, never from an adapter. Policy and approval run before any signing, `sending` is journaled
// before anything is sent, and confirmation runs against the journal. Adapters can add capabilities,
// but they can't skip any of these steps.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";

/** Who holds the key: the SEP-43 shape @x402/stellar signs with. */
export interface Signer extends ClientStellarSigner {
  /**
   * For a wallet that enforces its own limits on chain: what it can still pay of `asset`, in base units.
   * Undefined when it sets no limit. The core refuses a payment above it, and refuses when it throws.
   */
  budget?(network: StellarNetwork, asset: string): Promise<string | undefined>;
}

/** A challenge entry's payment, signed and ready for the PAYMENT-SIGNATURE header. */
export type SignedPayload = Pick<PaymentPayload, "x402Version" | "payload">;

/** What the user approved, as journaled in `sending`. */
export interface ExpectedPayment {
  network: StellarNetwork;
  /** The asset's contract address (C...), as in the challenge. */
  asset: string;
  /** Base units. */
  amount: string;
  payTo: string;
  payer: string;
}

export interface Confirmation {
  confirmed: boolean;
  /** Why the payment is not confirmed. */
  reason?: string;
}

/** How an x402 challenge entry is paid, and how that payment is proven. */
export interface PaymentMethod {
  /** A stable name. It is journaled with each payment, so recovery confirms with the same method. */
  readonly id: string;
  /** Whether this method can pay the entry. False for any scheme or network it does not know. */
  matches(requirements: PaymentRequirements): boolean;
  /** Signs the payment. The only step that uses the signer; the core runs it once per job. */
  createPayload(requirements: PaymentRequirements, signer: Signer): Promise<SignedPayload>;
  /** Checks the transaction against what the user approved, never against the provider's receipt [J16]. */
  confirm(transaction: string, expected: ExpectedPayment): Promise<Confirmation>;
}
