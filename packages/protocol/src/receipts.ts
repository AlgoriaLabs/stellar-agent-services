// Receipts: the payment receipt in a job view (provider-standard.md §5.7) and the verification
// receipt the verifier issues (docs/verification.md).

import type { JsonObject } from "./canonical-json.js";
import type { StellarNetwork } from "./networks.js";
import type { PROVIDER_STANDARD } from "./standard.js";

/**
 * JobView.payment, using x402 SettleResponse names where they exist. A receipt is a claim: clients
 * confirm the transaction on chain before showing "paid" [J16].
 */
export interface PaymentReceipt {
  network: StellarNetwork;
  asset: string;
  /** Base units, as in the challenge. */
  amount: string;
  payTo: string;
  payer: string;
  /** Stellar transaction hash. */
  transaction: string;
  /** RFC 3339: when the provider saw the settlement. */
  settledAt: string;
}

/** The Validation Registry tag of every record this standard's verifiers publish (erc-compatibility.md, T2). */
export const VALIDATION_TAG = "provider-standard-v1";

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7";
export const CHECK_IDS: readonly CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];

/**
 * A rule a check cites: a rule id such as "P4", or a section such as "§5.5" for a requirement the
 * standard states without an id.
 */
export const RULE_REFERENCE_PATTERN = /^(?:[A-Z][0-9]{1,2}|§[0-9]{1,2}(?:\.[0-9]{1,2})?)$/;

/** One thing a check found: the rule, and what the verifier observed. */
export interface CheckFinding {
  rule: string;
  /** "fail" breaks the check. "warn" is a SHOULD rule that was not met. */
  severity: "fail" | "warn";
  /** In the verifier's own words: never a secret, and never text copied from the provider. */
  message: string;
}

export interface CheckResult {
  check: CheckId;
  /**
   * "skipped" when the check was not run, e.g. C4 without a test payer, or could not finish, e.g. the
   * chain could not be read. A skipped check earns nothing.
   */
  status: "passed" | "failed" | "skipped";
  /** The rules that failed, such as "P4". Empty unless failed. */
  failedRules: string[];
  /** SHOULD rules that were not met. They never fail the check. */
  warnings?: string[];
  /** Why the check was skipped. */
  reason?: string;
  /** What failed or was warned about, with the verifier's explanation. */
  findings?: CheckFinding[];
  /** What the verifier observed: hashes, the decoded challenge, transaction hashes. Never a secret. */
  evidence?: JsonObject;
}

/** 0 when even Described is not reached (provider-standard.md §8). */
export type ConformanceLevel = 0 | 1 | 2 | 3;

/** Each level and the checks it needs, including those of the levels below (§8). */
export const CONFORMANCE_LEVELS: readonly { level: 1 | 2 | 3; name: string; checks: readonly CheckId[] }[] = [
  { level: 1, name: "Described", checks: ["C1", "C6"] },
  { level: 2, name: "Payable", checks: ["C1", "C6", "C3", "C4"] },
  { level: 3, name: "Recoverable", checks: ["C1", "C6", "C3", "C4", "C5"] },
];

/**
 * The receipt's `score`, and the `response` posted to the Validation Registry, for each level:
 * higher is better, and 100 means fully conformant (erc-compatibility.md, T2).
 */
export const CONFORMANCE_SCORES: Readonly<Record<ConformanceLevel, number>> = { 0: 0, 1: 33, 2: 67, 3: 100 };

/** The highest level whose checks all passed. Registered (C2) and Load-safe (C7) are separate and don't count here. */
export function conformanceLevel(results: readonly CheckResult[]): ConformanceLevel {
  const passed = new Set(results.filter((result) => result.status === "passed").map((result) => result.check));
  let reached: ConformanceLevel = 0;
  for (const { level, checks } of CONFORMANCE_LEVELS) {
    if (!checks.every((check) => passed.has(check))) break;
    reached = level;
  }
  return reached;
}

/**
 * What the verifier issues and anchors in the Stellar 8004 Validation Registry. Published as canonical
 * JSON; canonicalSha256(receipt) is the on-chain `response_hash`. schemas/verification-receipt.schema.json
 * describes it.
 *
 * `standard`, `agentId`, `network`, `validator`, `checkedAt`, `score`, `scoreDirection` and `results`
 * are the envelope shared with Stellar ERC-8126 records (erc-compatibility.md, T2).
 */
export interface VerificationReceipt {
  standard: typeof PROVIDER_STANDARD;
  /** The provider's Stellar 8004 agent id. Required to publish to the Validation Registry. */
  agentId?: number;
  network: StellarNetwork;
  /** The verifier's G... address, which signs validation_response. */
  validator: string;
  /** RFC 3339. */
  startedAt: string;
  checkedAt: string;
  /** CONFORMANCE_SCORES[level]. */
  score: number;
  scoreDirection: "higher-is-better";
  level: ConformanceLevel;
  /**
   * The manifest that was checked. sha256 is canonicalSha256 of the parsed manifest, absent when the
   * manifest could not be read as JSON.
   */
  manifest: { url: string; sha256?: string };
  /** One entry per check, in order from C1 to C7, including skipped ones. */
  results: CheckResult[];
  /** The receipt of the C4 paid call, after the verifier confirmed it on chain. */
  payment?: PaymentReceipt;
  /** The software that issued the receipt, so receipts from a faulty version can be found. */
  tool?: { name: string; version: string };
}

/** `$id` of schemas/verification-receipt.schema.json. */
export const VERIFICATION_RECEIPT_SCHEMA_ID =
  "https://algorialabs.github.io/stellar-agent-services/schemas/provider/1/verification-receipt.schema.json";
