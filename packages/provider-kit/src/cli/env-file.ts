// .env files: the settings a project keeps out of git (docs/provider-setup-guide.md §1).
//
// `provider-kit dev`, `launch` and `status` read the project's .env, as `node --env-file` would: a variable already set
// in the environment wins. `dev` and `launch` write back the values they settle (PAY_TO, DEV_PAY_TO, AGENT_ID), keeping
// the file as it was: a value replaces its own line, or a commented-out "# NAME=" line, and a new one goes at the end.
// Only public values are ever written here. No secret key goes in a .env file, and none comes from one.

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

/** The env file the commands read and write when --env-file doesn't name another. */
export const ENV_FILE = ".env";

/** The values in an env file. {} when there is none. */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  return parseEnv(await readFile(path, "utf8")) as Record<string, string>;
}

/** Loads an env file into `env`, leaving every variable that is already set as it is. Returns whether the file exists. */
export async function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!existsSync(path)) return false;
  for (const [name, value] of Object.entries(await readEnvFile(path))) {
    if (env[name] === undefined) env[name] = value;
  }
  return true;
}

/**
 * Sets values in an env file, keeping everything else as it was. `undefined` removes a value's line. A new value goes at
 * the end, after its comment from `comments` when there is one. Without the file, nothing is written and it returns
 * false, unless `create` is set.
 */
export async function updateEnvFile(
  path: string,
  values: Record<string, string | undefined>,
  options: { comments?: Record<string, string>; create?: boolean } = {},
): Promise<boolean> {
  const exists = existsSync(path);
  if (!exists && options.create !== true) return false;
  const lines = exists ? (await readFile(path, "utf8")).replace(/\n$/, "").split("\n") : [];
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${name} is not an environment variable name`);
    const set = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*${name}\\s*=`);
    let index = lines.findIndex((line) => set.test(line));
    if (value === undefined) {
      if (index !== -1) lines.splice(index, 1);
      continue;
    }
    if (index === -1) index = lines.findIndex((line) => commented.test(line));
    const line = `${name}=${envValue(value)}`;
    if (index !== -1) {
      lines[index] = line;
      continue;
    }
    const comment = options.comments?.[name];
    if (lines.length > 0 && lines.at(-1) !== "" && comment !== undefined) lines.push("");
    if (comment !== undefined) lines.push(...comment.split("\n").map((text) => `# ${text}`));
    lines.push(line);
  }
  // Written beside the file, then renamed over it, so an interrupted write never leaves half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join("\n")}\n`);
  await rename(temporary, path);
  return true;
}

/** A value as an env file holds it: bare when it can be, else in double quotes. The values written here are public and plain. */
function envValue(value: string): string {
  if (/^[\w@%+=:,./-]*$/.test(value)) return value;
  if (/["\\\n\r]/.test(value)) throw new Error(`can't write ${JSON.stringify(value)} to an env file`);
  return `"${value}"`;
}
