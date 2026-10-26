// What one verification run shares between its checks, and how a check records what it finds.
//
// A check reports findings against rules: "fail" for a MUST that was broken, "warn" for a SHOULD that
// was not met. Its status follows from them: any failure fails it; otherwise anything the verifier
// could not finish (an RPC outage, a provider that stayed busy) makes it "skipped", which earns
// nothing; otherwise it passed.

import {
  RULE_REFERENCE_PATTERN,
  type CheckFinding,
  type CheckId,
  type CheckResult,
  type JsonObject,
  type PaymentReceipt,
  type ProviderManifest,
  type ServiceDescriptor,
} from "@stellar-agent-services/protocol";
import type { PaymentRequired } from "@x402/core/types";
import type { ChainReader } from "./chain.js";
import type { HttpClient } from "./http.js";
import type { Payer, SignedPayment, Wallet } from "./payments.js";
import type { Registry } from "./registry.js";

/** The receipt schema's limits. */
const MAX_FINDINGS = 50;
const MAX_TEXT = 500;

export class Recorder {
  readonly findings: CheckFinding[] = [];
  readonly evidence: JsonObject = {};
  private omitted = 0;
  private reason: string | undefined;

  constructor(readonly check: CheckId) {}

  fail(rule: string, message: string): void {
    this.add({ rule, severity: "fail", message });
  }

  warn(rule: string, message: string): void {
    this.add({ rule, severity: "warn", message });
  }

  /** The check could not finish. Kept unless it also fails; the first reason wins. */
  inconclusive(reason: string): void {
    this.reason ??= truncate(reason);
  }

  get failed(): boolean {
    return this.findings.some((finding) => finding.severity === "fail");
  }

  result(): CheckResult {
    const rules = (severity: CheckFinding["severity"]) => sortRules(this.findings.filter((finding) => finding.severity === severity).map((finding) => finding.rule));
    const failedRules = rules("fail");
    const warnings = rules("warn");
    const status = failedRules.length > 0 ? "failed" : this.reason !== undefined ? "skipped" : "passed";
    const result: CheckResult = { check: this.check, status, failedRules };
    if (warnings.length > 0) result.warnings = warnings;
    if (status === "skipped") result.reason = this.reason!;
    if (this.findings.length > 0) result.findings = [...this.findings];
    const evidence = { ...this.evidence, ...(this.omitted > 0 ? { omittedFindings: this.omitted } : {}) };
    if (Object.keys(evidence).length > 0) result.evidence = evidence;
    return result;
  }

  private add(finding: CheckFinding): void {
    if (!RULE_REFERENCE_PATTERN.test(finding.rule)) throw new TypeError(`not a rule reference: ${finding.rule}`);
    finding.message = truncate(finding.message);
    if (this.findings.some((known) => known.rule === finding.rule && known.severity === finding.severity && known.message === finding.message)) return;
    if (this.findings.length >= MAX_FINDINGS) {
      this.omitted++;
      return;
    }
    this.findings.push(finding);
  }
}

/** A check that did not run. */
export function skipped(check: CheckId, reason: string): CheckResult {
  return { check, status: "skipped", failedRules: [], reason: truncate(reason) };
}

/** Rule ids by letter and number, then spec sections, each once. */
export function sortRules(rules: readonly string[]): string[] {
  const key = (rule: string) =>
    rule.startsWith("§") ? `2${rule.slice(1).split(".").map((part) => part.padStart(3, "0")).join(".")}` : `1${rule[0]}${rule.slice(1).padStart(3, "0")}`;
  return [...new Set(rules)].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/** An input the checks send to a service, and where it came from. */
export interface ProbeInput {
  input: JsonObject;
  source: "option" | "example" | "sample";
}

/** The job C4 paid for, which C5 recovers. */
export interface PaidJob {
  service: ServiceDescriptor;
  input: JsonObject;
  jobId: string;
  token: string;
  payment: SignedPayment;
  /** The final job view. */
  view: JsonObject;
}

export interface RunContext {
  readonly manifestUrl: string;
  /** Development mode: a loopback http:// provider is accepted [M6]. */
  readonly dev: boolean;
  readonly http: HttpClient;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** The service and input the caller chose for the paid call and the load test. */
  readonly service: string | undefined;
  readonly input: JsonObject | undefined;
  /** Unpaid create-job requests in the load burst. */
  readonly burstSize: number;
  /** The test payer, when the paid checks run. */
  readonly payer: Payer | undefined;

  /** Set by C1. */
  manifest: ProviderManifest | undefined;
  manifestSha256: string | undefined;
  /** The manifest can be probed: it passed the JSON Schema, and its baseUrl is on its own origin. */
  usable: boolean;
  /** C1 passed: a conforming client would pay this provider, so the verifier may. */
  conformant: boolean;
  /** Set once the network is known, from the manifest. */
  chain: ChainReader | undefined;
  registry: Registry | undefined;
  wallet: Wallet | undefined;

  /** The input each service is probed with. Services with none are not probed. */
  inputs: Map<string, ProbeInput>;
  /** The service the paid call and the load test use. */
  target: ServiceDescriptor | undefined;
  /** Each service's challenge, when C3 found it matches the manifest. */
  challenges: Map<string, PaymentRequired>;
  paidJob: PaidJob | undefined;
  /** The C4 receipt, once confirmed on chain [J16]. */
  payment: PaymentReceipt | undefined;
  /** Every transaction a job's receipt named, with the job: one transaction proves one job only [J16]. */
  transactions: Map<string, string>;
}
