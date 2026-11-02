// The state of `verifier watch`, in its data directory:
// - state.json: one small JSON file, rewritten atomically (a temporary file, then a rename) after every
//   step, so a restart picks up where the watcher stopped. It belongs to one validator on one network.
// - watch.lock: two watchers on one data directory would both answer its requests. The lock names its
//   holder and is touched every 30 s; one untouched for 2 minutes is left from a watcher that died.
// The receipts the chain points to are in receipts/, next to them (watch.ts).

import { readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { isObject } from "./json.js";

export const STATE_FILE = "state.json";
export const LOCK_FILE = "watch.lock";
const LOCK_BEAT_MS = 30_000;
const LOCK_STALE_MS = 2 * 60_000;

/**
 * waiting     the watcher resolves and verifies it at `nextAt`
 * publishing  its receipt is issued; validation_response is being sent
 * answered    the registry holds a response to it, this watcher's or another one
 * refused     the watcher will never answer it; `problem` says why
 */
export type RequestStatus = "waiting" | "publishing" | "answered" | "refused";

/** One validation request naming this validator. */
export interface WatchedRequest {
  agentId: number;
  /** The ledger of the validation_request. */
  ledger: number;
  /** When this watcher found it. A provider that is not reachable yet is retried for a while from here. */
  foundAt: string;
  status: RequestStatus;
  /** The manifest URL checked last, and where it came from. */
  manifestUrl?: string;
  manifestFrom?: "request" | "registration";
  /** Tries that did not answer yet, which set the backoff. */
  attempts: number;
  /** Verification runs. */
  runs: number;
  /** Runs that skipped a check without failing any. */
  incomplete: number;
  /** When to work on it next, while waiting or publishing. */
  nextAt?: string;
  /** Why it is not answered yet, or why it was refused. Public: GET /requests/<hash>.json shows it. */
  problem?: string;
  /** sha256 of the receipt that answers it, and its level and score. */
  receipt?: string;
  level?: number;
  score?: number;
  /** When validation_response was last sent. */
  sentAt?: string;
  /** When it was answered or refused. */
  doneAt?: string;
  /** Whose response the registry holds: this watcher's receipt, or another one, such as `verifier publish`'s. */
  answeredBy?: "watch" | "other";
}

export interface WatchState {
  version: 1;
  network: StellarNetwork;
  validator: string;
  /** How many of the requests naming the validator were read: the registry's list only grows. */
  scanned: number;
  /** By request hash. */
  requests: Record<string, WatchedRequest>;
}

export class StateError extends Error {
  override name = "StateError";
}

/** The state in `dir`, or a new one. Throws a StateError for another validator's or network's state, or a damaged file. */
export async function loadState(dir: string, network: StellarNetwork, validator: string): Promise<WatchState> {
  const path = join(dir, STATE_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, network, validator, scanned: 0, requests: {} };
    throw error;
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    state = undefined;
  }
  if (!isObject(state) || state["version"] !== 1 || typeof state["scanned"] !== "number" || !isObject(state["requests"])) {
    // Starting over could lose a response that was sent but is not on chain yet: a person decides.
    throw new StateError(`${path} is not a watcher state file. Move it away to start over.`);
  }
  if (state["network"] !== network || state["validator"] !== validator) {
    throw new StateError(`${dir} holds the state of validator ${String(state["validator"])} on ${String(state["network"])}: give this one its own --data directory`);
  }
  return state as unknown as WatchState;
}

/** Writes the state atomically: a crash leaves the old file or the new one, never half of one. */
export async function saveState(dir: string, state: WatchState): Promise<void> {
  const path = join(dir, STATE_FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

export class LockedError extends Error {
  override name = "LockedError";
}

/** Takes the data directory's lock until release(). Throws a LockedError while another watcher holds it. */
export async function lockDataDir(dir: string): Promise<{ release(): Promise<void> }> {
  const path = join(dir, LOCK_FILE);
  const holder = `${JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() })}\n`;
  try {
    await writeFile(path, holder, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const touched = (await stat(path)).mtimeMs;
    if (Date.now() - touched < LOCK_STALE_MS) {
      const other = (await readFile(path, "utf8").catch(() => "")).trim();
      throw new LockedError(`another watcher uses ${dir} (${other || "unknown"}). Run one watcher per data directory and validator key; if none is running, delete ${path}.`);
    }
    await writeFile(path, holder);
  }
  const timer = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => {});
  }, LOCK_BEAT_MS);
  timer.unref();
  return {
    async release() {
      clearInterval(timer);
      await rm(path, { force: true });
    },
  };
}
