// Reading the chain: the Soroban RPC calls the kit makes, and a ledger clock.
//
// The provider still holds no key and sends nothing; it only reads. Two things need the chain:
// - Reconciliation (payments/onchain.ts, jobs/reconcile.ts): a payment_uncertain job is decided from
//   the transactions that did, or did not, use its payment [J13].
// - The ledger clock. A signed payment is valid up to a ledger, not a time [S2]. The clock turns a
//   ledger into an estimated time, from the latest ledger's close time and the recent average ledger
//   duration, so an on-success job's deadline follows its payment however late the client sent it
//   [Q8], and a sweep can tell for sure that a payment expired.
//
// Reads go through Soroban RPC, the same server the facilitator and the payment client use. The URL is
// HTTPS (http://localhost only in development), like the facilitator's.

import { SOROBAN_RPC_URL, type StellarNetwork } from "@stellar-agent-services/protocol";
import { rpc } from "@stellar/stellar-sdk";

/** The RPC calls the kit makes: an rpc.Server, or a fake chain in tests. */
export type ChainReader = Pick<rpc.Server, "getLatestLedger" | "getLedgers" | "getHealth" | "getEvents" | "getTransaction">;

/** An RPC call that takes longer fails, and reconciliation tries again on its next round. */
const RPC_TIMEOUT_MS = 15_000;

/**
 * A Soroban RPC client for `network`: `url`, or the public default. Undefined when there is none, as on
 * pubnet, where SDF runs no public RPC.
 */
export function rpcChain(network: StellarNetwork, url?: string, options: { dev?: boolean } = {}): ChainReader | undefined {
  const target = url ?? SOROBAN_RPC_URL[network];
  if (target === undefined) return undefined;
  const base = new URL(target);
  const loopback = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(options.dev && loopback)) {
    throw new TypeError("the Soroban RPC URL must be https:// (http://localhost is allowed with dev: true)");
  }
  return new rpc.Server(target, { timeout: RPC_TIMEOUT_MS, allowHttp: loopback });
}

export interface LedgerClock {
  /** The latest closed ledger. */
  latest(): Promise<number>;
  /** When `ledger` closes, or closed: an estimate, in epoch ms. */
  closesAt(ledger: number): Promise<number>;
}

/** Ledgers the average duration is measured over: about eight minutes. */
const SAMPLE_LEDGERS = 100;
/** Used when no sample can be read, or a sample looks wrong. Stellar closes a ledger about every 5 s. */
const DEFAULT_LEDGER_MS = 5000;
/** How long a reading is used before the chain is read again. */
const CLOCK_CACHE_MS = 5000;
/**
 * How long a reading may take. Jobs and paid requests wait for the clock, so a slow RPC makes them
 * fall back to their claim-time deadlines instead of waiting for it.
 */
const CLOCK_TIMEOUT_MS = 3000;

interface Reading {
  sequence: number;
  /** Epoch ms. */
  closedAt: number;
  ledgerMs: number;
}

/**
 * A clock on `chain`'s ledgers. Readings are cached for a few seconds, and a failed reading rejects
 * until the next one is due: callers fall back to wall-clock deadlines meanwhile.
 */
export function ledgerClock(chain: Pick<ChainReader, "getLatestLedger" | "getLedgers">): LedgerClock {
  let reading: Promise<Reading> | undefined;
  let readAt = 0;
  let failing = false;

  const read = async (): Promise<Reading> => {
    const latest = await chain.getLatestLedger();
    let sequence = latest.sequence;
    let closedAt = Number(latest.closeTime) * 1000;
    let ledgerMs = DEFAULT_LEDGER_MS;
    try {
      const sample = await chain.getLedgers({ startLedger: Math.max(1, sequence - SAMPLE_LEDGERS), pagination: { limit: 1 } });
      const first = sample.ledgers[0];
      if (first !== undefined && sample.latestLedger > first.sequence) {
        const measured = ((sample.latestLedgerCloseTime - Number(first.ledgerCloseTime)) * 1000) / (sample.latestLedger - first.sequence);
        if (measured >= 1000 && measured <= 60_000) ledgerMs = measured;
      }
      sequence = sample.latestLedger;
      closedAt = sample.latestLedgerCloseTime * 1000;
    } catch {
      // The latest ledger alone is enough, with the default duration.
    }
    // An RPC that does not report close times: the latest ledger closed within the last few seconds.
    if (!Number.isFinite(closedAt) || closedAt <= 0) closedAt = Date.now();
    return { sequence, closedAt, ledgerMs };
  };

  const current = (): Promise<Reading> => {
    if (reading === undefined || Date.now() - readAt >= CLOCK_CACHE_MS) {
      readAt = Date.now();
      reading = withTimeout(read(), CLOCK_TIMEOUT_MS).then(
        (value) => {
          failing = false;
          return value;
        },
        (error: unknown) => {
          if (!failing) console.warn(`[provider-kit] the ledger clock can't read the chain; deadlines fall back to claim times: ${(error as Error).message}`);
          failing = true;
          throw error;
        },
      );
      // Callers catch it; this keeps an unobserved rejection from crashing the process.
      reading.catch(() => undefined);
    }
    return reading;
  };

  return {
    latest: async () => (await current()).sequence,
    async closesAt(ledger) {
      const { sequence, closedAt, ledgerMs } = await current();
      return closedAt + (ledger - sequence) * ledgerMs;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
