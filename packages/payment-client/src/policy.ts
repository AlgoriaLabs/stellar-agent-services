// Spending policy: ERC-8196 field names plus named Stellar extensions (docs/payment-client.md).
//
// A failed check blocks the payment; it never passes silently. Amounts are in the asset's base
// units (USDC: 7 decimals), not a native value.
//
// TODO:
// - minVerificationScore and stellar.minProviderLevel are stored but not enforced yet: they need the
//   risk source and Validation Registry reads.

import { canonicalSha256, USDC_ASSET, type StellarNetwork } from "@stellar-agent-services/protocol";

export interface SpendingPolicy {
  /** Format version of this document, so a later format can migrate it. */
  version: 1;
  policyId: string;
  /** The human who set the policy, when known. */
  ownerAddress?: string;
  /** The key that pays under this policy. */
  agentAddress: string;
  agentId?: number;
  allowedActions: string[];
  /** Asset contracts that may be paid with. */
  allowedContracts: string[];
  blockedContracts: string[];
  maxValuePerTx: string;
  maxValuePerDay: string;
  /** Unix seconds. */
  validAfter: number;
  validUntil: number;
  minVerificationScore?: number;
  stellar: {
    network: StellarNetwork;
    /** Payee lists, since the real payee is an argument of `transfer`, not the called contract. */
    payees: { allow?: string[]; block: string[] };
    minProviderLevel?: number;
    /** Payments at or below this amount, and inside every limit, need no prompt. "0": approve every payment. */
    autoApproveUpTo: string;
  };
}

export interface PaymentRequest {
  action: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  /** What this policy already paid in the last 24 hours. */
  spentLast24h: bigint;
  now?: Date;
}

export interface PolicyViolation {
  field: string;
  message: string;
}

export interface PolicyDecision {
  allowed: boolean;
  violations: PolicyViolation[];
  /** Allowed, but above autoApproveUpTo: a human must approve this exact payment. */
  needsApproval: boolean;
}

export const PAY_ACTION = "x402.pay";

const DAY_SECONDS = 86400;

export function defaultPolicy(agentAddress: string, network: StellarNetwork, now = new Date()): SpendingPolicy {
  const seconds = Math.floor(now.getTime() / 1000);
  return {
    version: 1,
    policyId: crypto.randomUUID(),
    agentAddress,
    allowedActions: [PAY_ACTION],
    allowedContracts: [USDC_ASSET[network]],
    blockedContracts: [],
    maxValuePerTx: "1000000", // 0.10 USDC
    maxValuePerDay: "10000000", // 1.00 USDC
    validAfter: seconds,
    validUntil: seconds + 30 * DAY_SECONDS,
    stellar: { network, payees: { block: [] }, autoApproveUpTo: "0" },
  };
}

export function policyHash(policy: SpendingPolicy): Promise<string> {
  return canonicalSha256(policy);
}

export function checkPolicy(policy: SpendingPolicy, request: PaymentRequest): PolicyDecision {
  const violations: PolicyViolation[] = [];
  const refuse = (field: string, message: string) => violations.push({ field, message });
  const now = Math.floor((request.now ?? new Date()).getTime() / 1000);
  const amount = BigInt(request.amount);

  if (now < policy.validAfter) refuse("validAfter", "the policy is not active yet");
  if (now >= policy.validUntil) refuse("validUntil", "the policy has expired");
  if (!policy.allowedActions.includes(request.action)) refuse("allowedActions", `"${request.action}" is not an allowed action`);
  if (request.network !== policy.stellar.network) refuse("stellar.network", `the policy is for ${policy.stellar.network}, not ${request.network}`);
  if (!policy.allowedContracts.includes(request.asset)) refuse("allowedContracts", "this asset is not allowed");
  if (policy.blockedContracts.includes(request.asset)) refuse("blockedContracts", "this asset is blocked");
  if (policy.stellar.payees.block.includes(request.payTo)) refuse("stellar.payees.block", "this payee is blocked");
  const allow = policy.stellar.payees.allow;
  if (allow !== undefined && !allow.includes(request.payTo)) refuse("stellar.payees.allow", "this payee is not on the allow list");
  if (amount <= 0n) refuse("amount", "the amount must be above zero");
  if (amount > BigInt(policy.maxValuePerTx)) refuse("maxValuePerTx", "the amount is above the per-payment limit");
  if (request.spentLast24h + amount > BigInt(policy.maxValuePerDay)) refuse("maxValuePerDay", "the payment would exceed the 24-hour limit");

  const allowed = violations.length === 0;
  return { allowed, violations, needsApproval: allowed && amount > BigInt(policy.stellar.autoApproveUpTo) };
}
