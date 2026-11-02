// Fly.io, where `npm create stellar-service` sets a project up to run. fly.toml names the app, so the service's public
// address is known before its first deploy (https://<app>.fly.dev). That lets `provider-kit launch` register first and
// deploy once, with the agent id in place.
//
// - flyApp(): the app and its public origin, from fly.toml.
// - setFlyEnv(): writes public settings (PUBLIC_ORIGIN, PAY_TO, AGENT_ID) into fly.toml's [env], so every deploy has
//   them. Only public values: an API's key goes in Fly's secrets (flySecrets()), never in fly.toml.
// - flyDeploy(): creates the app the first time, then `fly deploy` with a single machine. The job database is SQLite on
//   a volume, which one machine holds; fly.toml's [[mounts]] has Fly make that volume on the first deploy.

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";

export const FLY_TOML = "fly.toml";

export interface FlyApp {
  /** fly.toml's path. */
  path: string;
  app: string;
  /** https://<app>.fly.dev */
  origin: string;
}

/** Runs flyctl. `inherit` shows it in this terminal, so it can ask the developer things; `input` goes to its standard input. */
export type FlyRunner = (args: string[], options?: { inherit?: boolean; input?: string }) => Promise<{ code: number; output: string }>;

/** The app fly.toml names, or undefined when there is no fly.toml or it names none. */
export async function flyApp(path: string = FLY_TOML): Promise<FlyApp | undefined> {
  if (!existsSync(path)) return undefined;
  const app = /^\s*app\s*=\s*["']([a-z0-9][a-z0-9-]*)["']\s*(?:#.*)?$/m.exec(await readFile(path, "utf8"))?.[1];
  return app === undefined ? undefined : { path, app, origin: `https://${app}.fly.dev` };
}

/** Sets values in fly.toml's [env] table, keeping the rest of the file as it was. The table is added when missing. */
export async function setFlyEnv(path: string, values: Record<string, string>): Promise<void> {
  const lines = (await readFile(path, "utf8")).replace(/\n$/, "").split("\n");
  let header = lines.findIndex((line) => /^\s*\[env\]\s*(?:#.*)?$/.test(line));
  if (header === -1) {
    lines.push("", "[env]");
    header = lines.length - 1;
  }
  let end = lines.findIndex((line, index) => index > header && /^\s*\[/.test(line));
  if (end === -1) end = lines.length;
  for (const [name, setting] of Object.entries(named(values))) {
    const entry = `  ${name} = ${JSON.stringify(setting)}`;
    const index = lines.findIndex((line, at) => at > header && at < end && new RegExp(`^\\s*${name}\\s*=`).test(line));
    if (index !== -1) {
      lines[index] = entry;
      continue;
    }
    // After the table's last entry, before the blank lines that end it.
    let at = end;
    while (at - 1 > header && lines[at - 1]!.trim() === "") at -= 1;
    lines.splice(at, 0, entry);
    end += 1;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join("\n")}\n`);
  await rename(temporary, path);
}

/** The values, once each name is checked to be an environment variable's. */
function named(values: Record<string, string>): Record<string, string> {
  for (const name of Object.keys(values)) if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`${name} is not an environment variable name`);
  return values;
}

/** Stages secrets for the app's next deploy, read by flyctl from its standard input so they never show in a process list. */
export async function flySecrets(fly: FlyRunner, app: string, secrets: Record<string, string>): Promise<boolean> {
  if (Object.keys(secrets).length === 0) return true;
  const input = Object.entries(named(secrets)).map(([name, secret]) => `${name}=${secret}`).join("\n");
  return (await fly(["secrets", "import", "--stage", "--app", app], { input })).code === 0;
}

/**
 * Deploys the app: flyctl must be installed and logged in. The app is created the first time. Returns why it couldn't,
 * or undefined once `fly deploy` succeeded.
 */
export async function flyDeploy(fly: FlyRunner, app: FlyApp, log: (line: string) => void): Promise<string | undefined> {
  if ((await fly(["version"])).code !== 0) return "flyctl isn't installed: https://fly.io/docs/flyctl/install/";
  if ((await fly(["auth", "whoami"])).code !== 0) {
    log("  … Log in to Fly.io (flyctl opens your browser)");
    if ((await fly(["auth", "login"], { inherit: true })).code !== 0) return "flyctl isn't logged in: run fly auth login";
  }
  const status = await fly(["status", "--app", app.app]);
  if (status.code !== 0) {
    if (!/could not find app|not found/i.test(status.output)) return `fly status failed: ${lastLine(status.output)}`;
    log(`  … Creating the Fly.io app ${app.app}`);
    if ((await fly(["apps", "create", app.app], { inherit: true })).code !== 0) {
      return `the app ${app.app} couldn't be created (its name may be taken: change "app" in fly.toml, then launch again)`;
    }
  }
  log(`  … Deploying ${app.app} (fly deploy)`);
  if ((await fly(["deploy", "--config", app.path, "--app", app.app, "--ha=false"], { inherit: true })).code !== 0) return "fly deploy failed: see its output above";
  return undefined;
}

function lastLine(output: string): string {
  return output.trim().split("\n").at(-1) ?? "no output";
}
