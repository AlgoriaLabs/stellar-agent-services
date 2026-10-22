// Browser storage for the journal and job tokens: IndexedDB, readable only by the page's origin. The
// "./browser" entry point; Node uses file-storage.ts instead.
//
// Writes commit with strict durability, so `sending` is on disk before the paid request goes out. One
// writer at a time, as with the file storage: a page that can be open in several tabs holds a Web Lock
// while it uses the journal (apps/wallet does).

import type { JournalStorage, SecretStore } from "./journal.js";

/** Matches the CLI's ~/.stellar-pay. */
const DEFAULT_DATABASE = "stellar-pay";
const JOURNAL = "journal";
const TOKENS = "job-tokens";

const databases = new Map<string, Promise<IDBDatabase>>();

export function indexedDbJournalStorage(database = DEFAULT_DATABASE): JournalStorage {
  return {
    async readLines() {
      const store = (await open(database)).transaction(JOURNAL).objectStore(JOURNAL);
      return (await request(store.getAll())) as string[];
    },
    async appendLine(line) {
      await commit(await open(database), JOURNAL, (store) => store.add(line));
    },
  };
}

export function indexedDbSecretStore(database = DEFAULT_DATABASE): SecretStore {
  return {
    async get(jobId) {
      const store = (await open(database)).transaction(TOKENS).objectStore(TOKENS);
      return (await request(store.get(jobId))) as string | undefined;
    },
    async set(jobId, token) {
      await commit(await open(database), TOKENS, (store) => store.put(token, jobId));
    },
  };
}

function open(name: string): Promise<IDBDatabase> {
  let database = databases.get(name);
  if (database === undefined) {
    database = new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        // Keys count up, so reading the store returns the lines in the order they were appended.
        opening.result.createObjectStore(JOURNAL, { autoIncrement: true });
        opening.result.createObjectStore(TOKENS);
      };
      opening.onsuccess = () => {
        const db = opening.result;
        // Another tab is upgrading or deleting the database: let it, and reopen on the next call.
        db.onversionchange = () => {
          db.close();
          databases.delete(name);
        };
        resolve(db);
      };
      opening.onerror = () => {
        databases.delete(name);
        reject(opening.error ?? new Error(`the "${name}" database could not be opened`));
      };
    });
    databases.set(name, database);
  }
  return database;
}

/** Resolves once the write is committed to disk. */
function commit(db: IDBDatabase, storeName: string, write: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite", { durability: "strict" });
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("the write was aborted"));
    write(transaction.objectStore(storeName));
  });
}

function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error ?? new Error("the read failed"));
  });
}
