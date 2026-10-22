import { Journal, memoryJournalStorage, type JournalEvent } from "@stellar-agent-services/payment-client";
import type { JsonObject } from "@stellar-agent-services/protocol";
import { describe, expect, it } from "vitest";
import { canRecover, summarizeJobs } from "../src/lib/jobs.js";

const policyHash = "f".repeat(64);
const transaction = "6a8d56b97dd1d927bd01b7469cd30e5a687a3ee166960a9737a0c0fd4491617d";

/** A real journal, so the entries look exactly as the core writes them. */
async function journalOf(jobs: Record<string, [JournalEvent, JsonObject?][]>) {
  const journal = await Journal.open(memoryJournalStorage());
  for (const [jobId, events] of Object.entries(jobs)) {
    for (const [event, details] of events) {
      const intent = { service: "text-stats", baseUrl: "http://localhost:8787" };
      await journal.append(event, jobId, policyHash, event === "intent" ? intent : (details ?? {}));
    }
  }
  return journal.entries();
}

const sending: [JournalEvent, JsonObject] = ["sending", { amount: "100000", payTo: "G…", network: "stellar:testnet", asset: "C…" }];

describe("jobs from the journal", () => {
  it("shows a confirmed payment as paid, with its amount and transfer", async () => {
    const [job] = summarizeJobs(
      await journalOf({ a: [["intent"], ["approved"], sending, ["settled", { transaction, confirmed: true }], ["result", { status: "succeeded" }]] }),
    );
    expect(job).toMatchObject({ jobId: "a", service: "text-stats", state: "paid", amount: "100000", transaction });
    expect(canRecover(job!.state)).toBe(false);
  });

  it("offers recovery for a job that was sent but has no result", async () => {
    const [job] = summarizeJobs(await journalOf({ a: [["intent"], ["approved"], sending, ["uncertain", { reason: "lost" }]] }));
    expect(job?.state).toBe("unfinished");
    expect(canRecover(job!.state)).toBe(true);
  });

  it("tells declined, blocked and unconfirmed jobs apart", async () => {
    const jobs = summarizeJobs(
      await journalOf({
        declined: [["intent"], ["refused", { reasons: ["the user declined"] }]],
        blocked: [["intent"], ["refused", { reasons: ["maxValuePerTx: the amount is above the per-payment limit"] }]],
        unconfirmed: [["intent"], ["approved"], sending, ["settled", { transaction, confirmed: false, reason: "the transaction is not on chain yet" }], ["result"]],
        uncharged: [["intent"], ["approved"], sending, ["failed", { charged: false, code: "handler_failed" }]],
      }),
    );
    expect(jobs.map((job) => [job.jobId, job.state, job.reason])).toEqual([
      ["uncharged", "not-charged", "handler_failed"],
      ["unconfirmed", "unconfirmed", "the transaction is not on chain yet"],
      ["blocked", "blocked", "The amount is above the per-payment limit"],
      ["declined", "declined", undefined],
    ]);
  });

  it("calls a review that was never decided not paid", async () => {
    expect(summarizeJobs(await journalOf({ a: [["intent"]] }))[0]?.state).toBe("not-paid");
  });
});
