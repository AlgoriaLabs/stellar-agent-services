// A public HTTPS address for a provider running on this computer: `provider-kit dev --tunnel`.
//
// It runs a Cloudflare quick tunnel, `cloudflared tunnel --url http://localhost:<port>`, which needs no account and
// prints an https://<words>.trycloudflare.com address. The provider is then served under that address, so its manifest
// passes the HTTPS rule [M6] and anyone can reach it: a teammate, `verifier check`, an agent on another computer. The
// address changes every run, so it is for trying things out: `provider-kit launch` refuses to register it.

import { startCommand, type Started } from "./processes.js";

/** The domain of quick tunnels' addresses. */
export const QUICK_TUNNEL_DOMAIN = "trycloudflare.com";
const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const WAIT_MS = 45_000;

export interface Tunnel {
  /** The public origin, such as https://calm-river-1234.trycloudflare.com. */
  url: string;
  stop(): Promise<void>;
}

/** Whether a URL is a quick tunnel's, which lasts only as long as the tunnel. */
export function isTemporaryUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === QUICK_TUNNEL_DOMAIN || hostname.endsWith(`.${QUICK_TUNNEL_DOMAIN}`);
  } catch {
    return false;
  }
}

/** Opens a quick tunnel to `port` on this computer. `start` stands in for running cloudflared in tests. */
export async function quickTunnel(port: number, start: (command: string) => Started = (command) => startCommand(command)): Promise<Tunnel> {
  const tunnel = start(`cloudflared tunnel --no-autoupdate --url http://localhost:${port}`);
  const deadline = Date.now() + WAIT_MS;
  let exitCode: number | undefined;
  void tunnel.exited.then((code) => (exitCode = code));
  while (Date.now() < deadline) {
    const found = ADDRESS.exec(tunnel.output())?.[0];
    if (found !== undefined) return { url: found, stop: () => tunnel.stop() };
    if (exitCode !== undefined) {
      const missing = exitCode === 127 || /not found|ENOENT/i.test(tunnel.output());
      throw new Error(
        missing
          ? "cloudflared isn't installed. Install it (macOS: brew install cloudflared; others: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or run without --tunnel"
          : `cloudflared stopped (exit code ${exitCode}): ${tunnel.output().trim().split("\n").slice(-3).join(" ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await tunnel.stop();
  throw new Error("cloudflared didn't give a public address in time. Try again, or run without --tunnel");
}
