// Where a local wallet's key is kept (SECURITY.md, boundary 2): the alternative to signing in a wallet app, for
// `--local-wallet` (cli/local-wallet.ts) and `provider-kit wallet` (cli/wallet.ts).
//
// A local wallet is a Stellar account whose key provider-kit made on this computer. The key never goes in the
// project, a .env file, the environment, a log or the terminal (only `provider-kit wallet export` shows it, to a
// person at a terminal), and the provider never gets it: the provider knows only the public address, as for any payTo.
//
// - The key is kept, by its public address, in the first of these that works: the macOS Keychain (`security`), the
//   Linux Secret Service (`secret-tool`), or a file only this user can read (mode 0600) in provider-kit's own
//   directory, outside every project. A key is read back and checked before its address is ever shown, so nobody
//   funds an account whose key was lost.
// - wallets.json, in the same directory, lists the wallets: public facts only (address, date, the project that made
//   it, where its key is). It is how a project finds its own wallet again.
// The directory is $PROVIDER_KIT_HOME, else $XDG_CONFIG_HOME/provider-kit, else ~/.config/provider-kit (%APPDATA% on
// Windows).

import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

/** The name the keys are filed under in an OS keychain. */
const SERVICE = "stellar-agent-services.provider-kit.local-wallet";
const TOOL_TIMEOUT_MS = 30_000;

/** A local wallet: public facts only. */
export interface WalletRecord {
  /** The account's G... address. */
  address: string;
  /** When it was made, ISO 8601. */
  created: string;
  /** The project directory it was made for. */
  project: string;
  /** Where its key is kept: a backend's name. */
  keptIn: string;
}

/** One place a key can be kept, by address. */
export interface SecretBackend {
  name: string;
  /** In plain words, for the person: such as "the macOS Keychain". */
  describe(address: string): string;
  /** Stores the secret. Throws when this backend doesn't work here. */
  put(address: string, secret: string): Promise<void>;
  /** The secret, or undefined when this backend holds none for the address. */
  get(address: string): Promise<string | undefined>;
}

export interface WalletStore {
  /** Every local wallet on this computer, oldest first. */
  list(): Promise<WalletRecord[]>;
  /** Makes a new wallet for `project`, and keeps its key. The key was read back and checked when this returns. */
  create(project: string): Promise<WalletRecord>;
  /** The key of a local wallet, or undefined when `address` isn't one. Throws when it is one but its key can't be read. */
  keypair(address: string): Promise<Keypair | undefined>;
  /** Where a wallet's key is kept, in plain words. */
  keptWhere(record: WalletRecord): string;
}

export interface WalletStoreOptions {
  /** provider-kit's directory. Tests pass a temporary one. */
  directory?: string;
  /** The places to keep a key, best first. Tests pass their own. */
  backends?: SecretBackend[];
  now?: () => Date;
}

/** provider-kit's own directory, outside every project. */
export function walletDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env["PROVIDER_KIT_HOME"]) return env["PROVIDER_KIT_HOME"];
  if (env["XDG_CONFIG_HOME"]) return join(env["XDG_CONFIG_HOME"], "provider-kit");
  if (process.platform === "win32" && env["APPDATA"]) return join(env["APPDATA"], "provider-kit");
  return join(homedir(), ".config", "provider-kit");
}

export function walletStore(options: WalletStoreOptions = {}): WalletStore {
  const directory = options.directory ?? walletDirectory();
  const backends = options.backends ?? defaultBackends(directory);
  const index = join(directory, "wallets.json");

  async function list(): Promise<WalletRecord[]> {
    let text: string;
    try {
      text = await readFile(index, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = JSON.parse(text) as { wallets?: WalletRecord[] };
    return parsed.wallets ?? [];
  }

  async function read(record: WalletRecord): Promise<Keypair> {
    const backend = backends.find((each) => each.name === record.keptIn);
    if (backend === undefined) throw new Error(`the key of ${record.address} is kept in "${record.keptIn}", which isn't available here`);
    const secret = await backend.get(record.address);
    if (secret === undefined) throw new Error(`the key of ${record.address} is gone from ${backend.describe(record.address)}`);
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret.trim());
    } catch {
      throw new Error(`what ${backend.describe(record.address)} holds for ${record.address} isn't a Stellar key`);
    }
    if (keypair.publicKey() !== record.address) throw new Error(`${backend.describe(record.address)} holds another account's key for ${record.address}`);
    return keypair;
  }

  return {
    list,
    async create(project) {
      const keypair = Keypair.random();
      const address = keypair.publicKey();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const problems: string[] = [];
      for (const backend of backends) {
        const record: WalletRecord = { address, created: (options.now?.() ?? new Date()).toISOString(), project, keptIn: backend.name };
        try {
          await backend.put(address, keypair.secret());
          // Read back before anyone sees the address: an account whose key was lost can never be spent from.
          await read(record);
        } catch (error) {
          problems.push(`${backend.name}: ${(error as Error).message}`);
          continue;
        }
        const wallets = [...(await list()), record];
        const temporary = `${index}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ wallets }, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, index);
        return record;
      }
      throw new Error(`a local wallet's key can't be kept on this computer (${problems.join("; ")})`);
    },
    async keypair(address) {
      const record = (await list()).find((each) => each.address === address);
      return record === undefined ? undefined : read(record);
    },
    keptWhere(record) {
      return backends.find((each) => each.name === record.keptIn)?.describe(record.address) ?? record.keptIn;
    },
  };
}

/** The OS keychain where there is one, then a private file. */
function defaultBackends(directory: string): SecretBackend[] {
  const backends: SecretBackend[] = [];
  if (process.platform === "darwin") backends.push(macKeychain());
  if (process.platform === "linux") backends.push(secretService());
  backends.push(privateFile(directory));
  return backends;
}

/** The macOS login keychain, through `security`. The key is passed on standard input, never as an argument. */
function macKeychain(): SecretBackend {
  return {
    name: "macos-keychain",
    describe: () => `the macOS Keychain (login keychain, service "${SERVICE}")`,
    async put(address, secret) {
      // Secrets and addresses are base32, so they need no quoting in `security -i`'s command line.
      const { code } = await runTool("security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${address} -w ${secret}\n`);
      // Its error output isn't repeated: it could quote the command, key and all.
      if (code !== 0) throw new Error(`security answered ${code}`);
    },
    async get(address) {
      const { code, stdout, stderr } = await runTool("security", ["find-generic-password", "-s", SERVICE, "-a", address, "-w"]);
      // 44: no such item.
      if (code === 44) return undefined;
      if (code !== 0) throw new Error(`security answered ${code}${stderr === "" ? "" : `: ${stderr}`}`);
      return stdout.trim();
    },
  };
}

/** The Linux Secret Service (GNOME Keyring, KWallet), through `secret-tool`, which reads the key from standard input. */
function secretService(): SecretBackend {
  const attributes = (address: string) => ["service", SERVICE, "account", address];
  return {
    name: "secret-service",
    describe: () => `your desktop keyring (Secret Service, service "${SERVICE}")`,
    async put(address, secret) {
      const { code, stderr } = await runTool("secret-tool", ["store", "--label", `provider-kit local wallet ${address}`, ...attributes(address)], secret);
      if (code !== 0) throw new Error(`secret-tool answered ${code}${stderr === "" ? "" : `: ${stderr}`}`);
    },
    async get(address) {
      const { code, stdout } = await runTool("secret-tool", ["lookup", ...attributes(address)]);
      return code === 0 && stdout.trim() !== "" ? stdout.trim() : undefined;
    },
  };
}

/** A file only this user can read, for computers with no keychain: servers, containers, Windows. */
export function privateFile(directory: string): SecretBackend {
  const path = (address: string) => join(directory, "wallets", `${address}.key`);
  return {
    name: "file",
    describe: (address) => `${path(address)} (a file only your user can read)`,
    async put(address, secret) {
      await mkdir(join(directory, "wallets"), { recursive: true, mode: 0o700 });
      // "wx": never over another key.
      await writeFile(path(address), `${secret}\n`, { mode: 0o600, flag: "wx" });
      await chmod(path(address), 0o600);
    },
    async get(address) {
      try {
        return (await readFile(path(address), "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}

/** Runs a keychain tool, with `input` on its standard input. A missing tool or a timeout throws. */
function runTool(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], timeout: TOOL_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(new Error(`${command} can't run (${error.message})`)));
    child.on("close", (code, signal) => {
      if (signal !== null) reject(new Error(`${command} didn't answer in ${TOOL_TIMEOUT_MS / 1000} seconds`));
      else resolve({ code: code ?? 1, stdout, stderr: stderr.trim().split("\n")[0] ?? "" });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
