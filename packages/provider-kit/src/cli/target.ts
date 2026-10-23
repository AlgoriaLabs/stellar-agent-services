// The provider a CLI command looks at: built from a gateway config (--config), or fetched from a
// running provider of any kind, library, gateway or native (--manifest).

import { MANIFEST_MAX_BYTES, type ProviderManifest } from "@stellar-agent-services/protocol";
import { loadGatewayConfig } from "../gateway/config.js";
import { checkManifest } from "../manifest.js";
import type { Facilitator } from "../payments/facilitator.js";
import { createProvider } from "../provider.js";
import { UsageError, type CliFlags } from "./shared.js";

export type Target =
  | { manifest: ProviderManifest; manifestUrl: string; facilitator?: Facilitator; source: string }
  | { problems: string[]; source: string };

export async function loadTarget(flags: CliFlags): Promise<Target> {
  if ((flags.config === undefined) === (flags.manifest === undefined)) throw new UsageError("pass --config <file> or --manifest <url>");

  if (flags.config !== undefined) {
    const source = flags.config;
    const { config } = await loadGatewayConfig(source, { openStore: false, overrides: flags.dev ? { dev: true } : {} });
    try {
      const provider = createProvider(config);
      await provider.close();
      const facilitator = typeof config.facilitator === "string" ? undefined : config.facilitator;
      return { manifest: provider.manifest, manifestUrl: provider.manifestUrl, source, ...(facilitator === undefined ? {} : { facilitator }) };
    } catch (error) {
      return { problems: [(error as Error).message], source };
    }
  }

  const url = flags.manifest!;
  const response = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) return { problems: [`[M1] the manifest answered ${response.status}; redirects are not followed [M3]`], source: url };
  const text = await response.text();
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) return { problems: ["[M3] the manifest is larger than 256 KiB"], source: url };
  let manifest: ProviderManifest;
  try {
    manifest = JSON.parse(text) as ProviderManifest;
  } catch {
    return { problems: ["the manifest is not valid JSON"], source: url };
  }
  const violations = checkManifest(manifest, url, flags.dev ?? false);
  if (violations.length > 0) return { problems: violations.map((violation) => `[${violation.rule}] ${violation.pointer || "/"}: ${violation.message}`), source: url };
  return { manifest, manifestUrl: url, source: url };
}
