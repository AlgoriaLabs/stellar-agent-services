import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { indexedDbJournalStorage, indexedDbSecretStore } from "../src/browser-storage.js";
import { Journal, verifyChain } from "../src/index.js";

let count = 0;
const freshDatabase = () => `test-${++count}`;
const policyHash = "f".repeat(64);

describe("IndexedDB storage", () => {
  it("reads the journal back in the order it was written", async () => {
    const database = freshDatabase();
    const journal = await Journal.open(indexedDbJournalStorage(database));
    for (const event of ["intent", "approved", "sending", "settled", "result"] as const) await journal.append(event, "job-1", policyHash);

    const reopened = await Journal.open(indexedDbJournalStorage(database));
    expect(reopened.entries().map((entry) => entry.event)).toEqual(["intent", "approved", "sending", "settled", "result"]);
    expect(await verifyChain(reopened.entries())).toBeUndefined();
  });

  it("keeps job tokens next to the journal, not in it", async () => {
    const database = freshDatabase();
    await indexedDbSecretStore(database).set("job-1", "token-1");

    expect(await indexedDbSecretStore(database).get("job-1")).toBe("token-1");
    expect(await indexedDbSecretStore(database).get("job-2")).toBeUndefined();
    expect(await indexedDbJournalStorage(database).readLines()).toEqual([]);
  });

  it("keeps databases apart", async () => {
    const [first, second] = [freshDatabase(), freshDatabase()];
    await (await Journal.open(indexedDbJournalStorage(first))).append("intent", "job-1", policyHash);

    expect(await indexedDbJournalStorage(second).readLines()).toEqual([]);
  });
});
