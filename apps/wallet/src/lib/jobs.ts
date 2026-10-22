// What happened to each job, read back from the journal: the "Recent payments" list and its buttons.

import type { JournalEntry } from "@stellar-agent-services/payment-client";

export type JobState =
  /** Charged, and the transfer is confirmed on chain. */
  | "paid"
  /** The provider says it charged, but the transfer is not confirmed (yet). */
  | "unconfirmed"
  /** Finished or failed without a charge. */
  | "not-charged"
  /** Failed after the charge, as an upfront service can. */
  | "failed"
  /** Sent, but no result yet: the response was lost or the job is still running. Recover it. */
  | "unfinished"
  | "declined"
  /** A check stopped it before anything was sent. */
  | "blocked"
  /** Reviewed but never decided, for example because the page was closed. */
  | "not-paid";

export interface JobSummary {
  jobId: string;
  service: string;
  baseUrl: string | undefined;
  at: string;
  /** In base units, once the payment was sent. */
  amount: string | undefined;
  transaction: string | undefined;
  state: JobState;
  reason: string | undefined;
}

/** Newest first. */
export function summarizeJobs(entries: readonly JournalEntry[]): JobSummary[] {
  const jobs = new Map<string, JournalEntry[]>();
  for (const entry of entries) {
    const events = jobs.get(entry.jobId);
    if (events === undefined) jobs.set(entry.jobId, [entry]);
    else events.push(entry);
  }
  return [...jobs.values()].map(summarize).reverse();
}

/** Recovery only reads the job's status and result, so it is safe whenever a job was sent. */
export function canRecover(state: JobState): boolean {
  return state === "unfinished" || state === "unconfirmed";
}

function summarize(events: JournalEntry[]): JobSummary {
  const first = events[0]!;
  const last = (event: JournalEntry["event"]) => events.findLast((entry) => entry.event === event);
  const intent = last("intent");
  const sending = last("sending");
  const failed = last("failed");
  const refused = last("refused");
  const settled = events.filter((entry) => entry.event === "settled");
  const confirmed = settled.some((entry) => entry.details["confirmed"] === true);

  let state: JobState;
  let reason: string | undefined;
  if (failed !== undefined) {
    state = failed.details["charged"] === true ? "failed" : "not-charged";
    reason = text(failed.details["code"]) ?? text(failed.details["reason"]);
  } else if (last("result") !== undefined) {
    state = settled.length === 0 ? "not-charged" : confirmed ? "paid" : "unconfirmed";
    if (state === "unconfirmed") reason = text(settled.at(-1)?.details["reason"]);
  } else if (sending !== undefined) {
    state = "unfinished";
  } else if (refused !== undefined) {
    const reasons = Array.isArray(refused.details["reasons"]) ? refused.details["reasons"].map(String) : [];
    state = reasons.includes("the user declined") ? "declined" : "blocked";
    if (state === "blocked" && reasons[0] !== undefined) reason = readable(reasons[0]);
  } else {
    state = "not-paid";
  }

  return {
    jobId: first.jobId,
    service: text(intent?.details["service"]) ?? "unknown service",
    baseUrl: text(intent?.details["baseUrl"]),
    at: first.at,
    amount: text(sending?.details["amount"]),
    transaction: text((settled.find((entry) => entry.details["confirmed"] === true) ?? settled.at(-1))?.details["transaction"]) || undefined,
    state,
    reason,
  };
}

/** "maxValuePerTx: the amount is above the per-payment limit" → "The amount is above the per-payment limit". */
function readable(reason: string): string {
  const message = reason.replace(/^[\w.]+: /, "");
  return message.charAt(0).toUpperCase() + message.slice(1);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
