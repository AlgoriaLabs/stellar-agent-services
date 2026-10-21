import { describe, expect, it } from "vitest";
import { Journal, memoryJournalStorage, verifyChain } from "../src/index.js";

describe("journal", () => {
  it("chains every entry to the one before it", async () => {
    const journal = await Journal.open(memoryJournalStorage());
    await journal.append("intent", "job-1", "policy");
    await journal.append("sending", "job-1", "policy", { amount: "100000" });
    const [first, second] = journal.entries();

    expect(first!.previousHash).toBe("0".repeat(64));
    expect(second!.previousHash).toBe(first!.hash);
    expect(await verifyChain(journal.entries())).toBeUndefined();
  });

  it("refuses to open a journal that was edited", async () => {
    const lines: string[] = [];
    const journal = await Journal.open(memoryJournalStorage(lines));
    await journal.append("sending", "job-1", "policy", { amount: "100000" });
    await journal.append("sending", "job-2", "policy", { amount: "100000" });

    lines[0] = lines[0]!.replace('"100000"', '"1"');
    await expect(Journal.open(memoryJournalStorage(lines))).rejects.toThrow(/broken at entry 1/);
  });

  it("counts sent payments, except jobs that failed without a charge", async () => {
    const journal = await Journal.open(memoryJournalStorage());
    await journal.append("sending", "job-1", "policy", { amount: "100000" });
    await journal.append("sending", "job-2", "policy", { amount: "200000" });
    await journal.append("failed", "job-2", "policy", { charged: false });
    await journal.append("sending", "job-3", "policy", { amount: "300000" });
    await journal.append("uncertain", "job-3", "policy");

    expect(journal.spentSince(new Date(0))).toBe(400000n);
  });
});
