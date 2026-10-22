// The payment journal: an append-only, hash-chained log in the shape of ERC-8196's audit trail
// (docs/payment-client.md). Each entry names the policy it ran under.
//
// `sending` is written, and flushed, BEFORE the paid request goes out. Recovery starts from it and
// never signs that job again.
//
// Job tokens are secrets, so they live in a SecretStore next to the journal, never in it.
//
// This module runs in Node and the browser. Storage plugs in: memory here, files in Node
// (file-storage.ts, the "./node" entry point), IndexedDB in the browser (browser-storage.ts, "./browser").
//
// TODO: anchoring a Merkle root on chain.

import { canonicalSha256, type JsonObject } from "@stellar-agent-services/protocol";

export type JournalEvent =
  | "intent"
  | "refused"
  | "approved"
  | "sending"
  | "uncertain"
  | "settled"
  | "failed"
  | "recovered"
  | "result";

export interface JournalEntry {
  /** Format version, so a later format can migrate old journals. */
  version: 1;
  seq: number;
  at: string;
  event: JournalEvent;
  jobId: string;
  policyHash: string;
  details: JsonObject;
  /** The previous entry's hash; 64 zeros for the first entry. */
  previousHash: string;
  /** sha256(JCS(entry without `hash`)). */
  hash: string;
}

export interface JournalStorage {
  readLines(): Promise<string[]>;
  /** Must be durable when it resolves. */
  appendLine(line: string): Promise<void>;
}

const GENESIS = "0".repeat(64);

export class Journal {
  private constructor(
    private readonly storage: JournalStorage,
    private readonly log: JournalEntry[],
  ) {}

  /** Loads the journal and refuses to continue from a broken chain (fail closed). */
  static async open(storage: JournalStorage): Promise<Journal> {
    const entries = (await storage.readLines()).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as JournalEntry);
    const broken = await verifyChain(entries);
    if (broken !== undefined) throw new Error(`the journal is broken at entry ${broken}; refusing to continue`);
    return new Journal(storage, entries);
  }

  entries(): readonly JournalEntry[] {
    return this.log;
  }

  forJob(jobId: string): JournalEntry[] {
    return this.log.filter((entry) => entry.jobId === jobId);
  }

  async append(event: JournalEvent, jobId: string, policyHash: string, details: JsonObject = {}): Promise<JournalEntry> {
    const previous = this.log.at(-1);
    const body = {
      version: 1 as const,
      seq: (previous?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      event,
      jobId,
      policyHash,
      details,
      previousHash: previous?.hash ?? GENESIS,
    };
    const entry: JournalEntry = { ...body, hash: await canonicalSha256(body) };
    await this.storage.appendLine(JSON.stringify(entry));
    this.log.push(entry);
    return entry;
  }

  /** What was sent for payment since `since`, in base units (totalSpentSince). */
  spentSince(since: Date): bigint {
    return totalSpentSince(this.log, since);
  }
}

/**
 * What was sent for payment since `since`, in base units. Fail closed: every `sending` counts, unless
 * the job later failed without a charge. A UI shows the same total the policy checks.
 */
export function totalSpentSince(entries: readonly JournalEntry[], since: Date): bigint {
  const notCharged = new Set(entries.filter((entry) => entry.event === "failed" && entry.details["charged"] === false).map((entry) => entry.jobId));
  return entries
    .filter((entry) => entry.event === "sending" && Date.parse(entry.at) >= since.getTime() && !notCharged.has(entry.jobId))
    .reduce((sum, entry) => sum + BigInt(String(entry.details["amount"] ?? "0")), 0n);
}

/** The seq of the first entry whose hash or link is wrong, or undefined if the chain is intact. */
export async function verifyChain(entries: readonly JournalEntry[]): Promise<number | undefined> {
  let previousHash = GENESIS;
  for (const entry of entries) {
    const { hash, ...body } = entry;
    if (entry.previousHash !== previousHash || (await canonicalSha256(body)) !== hash) return entry.seq;
    previousHash = hash;
  }
  return undefined;
}

export function memoryJournalStorage(lines: string[] = []): JournalStorage {
  return {
    async readLines() {
      return [...lines];
    },
    async appendLine(line) {
      lines.push(line);
    },
  };
}

/** Where job tokens are kept: next to the journal, never in it. */
export interface SecretStore {
  get(jobId: string): Promise<string | undefined>;
  /** Must be durable when it resolves. */
  set(jobId: string, token: string): Promise<void>;
}

export function memorySecretStore(): SecretStore {
  const tokens = new Map<string, string>();
  return {
    async get(jobId) {
      return tokens.get(jobId);
    },
    async set(jobId, token) {
      tokens.set(jobId, token);
    },
  };
}
