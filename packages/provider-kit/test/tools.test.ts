// The tools launch and dev drive: fly.toml (the app's address, its public settings, the deploy) and the cloudflared
// quick tunnel. flyctl and cloudflared are replaced: nothing here touches the network.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flyApp, flyDeploy, setFlyEnv, type FlyRunner } from "../src/cli/fly.js";
import type { Started } from "../src/cli/processes.js";
import { isTemporaryUrl, quickTunnel } from "../src/cli/tunnel.js";

const directory = mkdtempSync(join(tmpdir(), "provider-kit-tools-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;
const file = (text: string) => {
  const path = join(directory, `fly-${++files}.toml`);
  writeFileSync(path, text);
  return path;
};

describe("fly.toml", () => {
  it("names the app and its public address, which is known before the first deploy", async () => {
    expect(await flyApp(file('# My service\napp = "text-tools"   # its name on Fly.io\nprimary_region = "iad"\n'))).toMatchObject({ app: "text-tools", origin: "https://text-tools.fly.dev" });
    expect(await flyApp(file('primary_region = "iad"\n'))).toBeUndefined();
    expect(await flyApp(join(directory, "none.toml"))).toBeUndefined();
  });

  it("gets public settings in [env], replacing a value in place and adding the table when it is missing", async () => {
    const path = file('app = "x"\n\n[env]\n  JOB_DB_PATH = "/data/jobs.sqlite"\n  PAY_TO = "GOLD"\n\n[[mounts]]\n  source = "data"\n');
    await setFlyEnv(path, { PAY_TO: "GNEW", AGENT_ID: "42" });
    expect(readFileSync(path, "utf8")).toBe('app = "x"\n\n[env]\n  JOB_DB_PATH = "/data/jobs.sqlite"\n  PAY_TO = "GNEW"\n  AGENT_ID = "42"\n\n[[mounts]]\n  source = "data"\n');
    const bare = file('app = "x"\n');
    await setFlyEnv(bare, { PUBLIC_ORIGIN: "https://x.fly.dev" });
    expect(readFileSync(bare, "utf8")).toBe('app = "x"\n\n[env]\n  PUBLIC_ORIGIN = "https://x.fly.dev"\n');
    await expect(setFlyEnv(bare, { "bad name": "1" })).rejects.toThrow(/not an environment variable name/);
  });

  it("deploys an app that exists without creating it, and says why when flyctl is missing or not logged in", async () => {
    const app = { path: "fly.toml", app: "text-tools", origin: "https://text-tools.fly.dev" };
    const calls: string[] = [];
    const fly =
      (answers: Record<string, number>): FlyRunner =>
      async (args) => {
        calls.push(args.join(" "));
        return { code: answers[args[0]!] ?? 0, output: "" };
      };
    expect(await flyDeploy(fly({}), app, () => {})).toBeUndefined();
    expect(calls).toEqual(["version", "auth whoami", "status --app text-tools", "deploy --config fly.toml --app text-tools --ha=false"]);
    expect(await flyDeploy(fly({ version: 127 }), app, () => {})).toMatch(/flyctl isn't installed/);
    expect(await flyDeploy(fly({ auth: 1 }), app, () => {})).toMatch(/isn't logged in/);
    expect(await flyDeploy(fly({ deploy: 1 }), app, () => {})).toMatch(/fly deploy failed/);
  });
});

/** A cloudflared that prints `output`, and exits with `code` if given. */
function cloudflared(output: string, code?: number): (command: string) => Started {
  return () => ({ exited: code === undefined ? new Promise(() => {}) : Promise.resolve(code), output: () => output, stop: async () => {} });
}

describe("the quick tunnel", () => {
  it("gives the https address cloudflared prints", async () => {
    const tunnel = await quickTunnel(8787, cloudflared("INF |  https://calm-river-12-ab.trycloudflare.com  |\n"));
    expect(tunnel.url).toBe("https://calm-river-12-ab.trycloudflare.com");
    expect(isTemporaryUrl(tunnel.url)).toBe(true);
    expect(isTemporaryUrl("https://api.example.com")).toBe(false);
  });

  it("says how to install cloudflared when it isn't there", async () => {
    await expect(quickTunnel(8787, cloudflared("sh: cloudflared: command not found\n", 127))).rejects.toThrow(/cloudflared isn't installed/);
  });
});
