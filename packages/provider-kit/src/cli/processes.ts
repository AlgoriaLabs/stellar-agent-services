// Programs the CLI starts and stops: a provider's own command (`dev -- <command>`, `try --start`, `launch --start`),
// a program running next to the gateway (`dev --with`), and tools such as flyctl and cloudflared.
//
// A program started in the background gets its own process group, so stopping it also stops what it started, such as
// the server under `npm run dev`. Its output is kept, and shown only when it fails to start. waitForManifest() is how
// the CLI knows a provider it started is up: its manifest answers.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { ProviderManifest } from "@stellar-agent-services/protocol";

/** A program running in the background. */
export interface Started {
  /** The exit code, once it exits. */
  readonly exited: Promise<number>;
  /** Its output so far, when it isn't shown as it comes. */
  output(): string;
  /** Stops it and what it started: SIGTERM, then SIGKILL if it is still there after a few seconds. */
  stop(): Promise<void>;
}

/** How long stop() waits after SIGTERM. */
const STOP_GRACE_MS = 5000;
const OUTPUT_KEPT = 64 * 1024;

/**
 * Starts a shell command line in the background. `env` is added to this process's environment. With `show`, its output
 * shows as it comes, otherwise it is kept for output().
 */
export function startCommand(command: string, options: { env?: NodeJS.ProcessEnv; show?: boolean; cwd?: string } = {}): Started {
  const ownGroup = process.platform !== "win32";
  const child = spawn(command, {
    shell: true,
    detached: ownGroup,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: options.show ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  return track(child, ownGroup);
}

/** Starts a program in the foreground: it shares the terminal, and Ctrl+C reaches it as it reaches this process. */
export function startForeground(program: string, args: string[], options: { env?: NodeJS.ProcessEnv; shell?: boolean } = {}): Started {
  const child = spawn(program, args, { env: { ...process.env, ...options.env }, stdio: "inherit", shell: options.shell ?? false });
  return track(child, false);
}

function track(child: ChildProcess, ownGroup: boolean): Started {
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_KEPT);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      keep(Buffer.from(`${error.message}\n`));
      resolve(127);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
  let stopping: Promise<void> | undefined;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (ownGroup && child.pid !== undefined) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // Already gone.
    }
  };
  return {
    exited,
    output: () => output,
    stop() {
      stopping ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        signal("SIGTERM");
        const timer = setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
        await exited;
        clearTimeout(timer);
      })();
      return stopping;
    },
  };
}

/** Runs a program to its end. With `inherit` the developer sees it and can answer its questions; `input` goes to its standard input. */
export function runProgram(
  program: string,
  args: string[],
  options: { inherit?: boolean; input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? (options.inherit ? "inherit" : "ignore") : "pipe", options.inherit ? "inherit" : "pipe", options.inherit ? "inherit" : "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.once("error", (error) => resolve({ code: 127, output: `${output}${error.message}\n` }));
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** A free TCP port on this computer. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Waits until `url` serves a provider's manifest, and returns it. Stops waiting with an error when `exited` resolves
 * first (the program that should serve it stopped), or after `timeoutMs`.
 */
export async function waitForManifest(
  url: string,
  options: { exited?: Promise<number>; timeoutMs?: number; fetch?: typeof fetch; intervalMs?: number } = {},
): Promise<ProviderManifest> {
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let stopped: number | undefined;
  void options.exited?.then((code) => (stopped = code));
  let last = "nothing answered";
  while (Date.now() < deadline) {
    if (stopped !== undefined) throw new Error(`it stopped (exit code ${stopped}) before serving its manifest`);
    try {
      const response = await fetcher(url, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (response.status === 200) return (await response.json()) as ProviderManifest;
      last = `the manifest answered ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      last = error instanceof TypeError ? "nothing answered" : (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
  }
  throw new Error(`${url} didn't serve a manifest in time: ${last}`);
}
