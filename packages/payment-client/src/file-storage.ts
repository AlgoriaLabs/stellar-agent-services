// Node storage for the journal and job tokens: files only the owner can read, flushed to disk before a
// write resolves. The "./node" entry point; browsers use browser-storage.ts instead.
//
// One process writes a journal at a time, as with any append-only file.

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalStorage, SecretStore } from "./journal.js";

export function fileJournalStorage(path: string): JournalStorage {
  return {
    async readLines() {
      try {
        return (await readFile(path, "utf8")).split("\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async appendLine(line) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, "a", 0o600);
      try {
        await handle.appendFile(`${line}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

export function fileSecretStore(path: string): SecretStore {
  const load = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    async get(jobId) {
      return (await load())[jobId];
    },
    async set(jobId, token) {
      const tokens = { ...(await load()), [jobId]: token };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(tokens, null, 2), { mode: 0o600, flush: true });
    },
  };
}
