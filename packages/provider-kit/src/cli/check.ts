// provider-kit check: a provider's self-check against Provider Standard v1, with no payment and no key.
//
//   manifest      the JSON Schema and the rules of §2.4 (what clients and verifiers reject)
//   facilitator   settles x402 `exact` on the network, with sponsored fees (gateway configs)
//   payTo         the account exists and has a USDC trustline [P2]
//   8004          the registration names the manifest, the agent and payTo match [I1]–[I3]
// Then how agents see the provider (discovery.ts): what search matches, and hints that never fail the check.
// `verifier check` goes further, calling create-job without paying (C3, C6, C7).

import { HORIZON_URL, USDC_ISSUER, type ProviderManifest } from "@stellar-agent-services/protocol";
import { checkFacilitator } from "../payments/facilitator.js";
import { inspectRegistration } from "../registration.js";
import { howAgentsSeeYou } from "./discovery.js";
import type { CliFlags } from "./shared.js";
import { loadTarget } from "./target.js";

type Line = { status: "ok" | "fail" | "warn"; text: string };
const MARK = { ok: "✓", fail: "✗", warn: "!" } as const;

export async function check(flags: CliFlags): Promise<number> {
  const target = await loadTarget(flags);
  console.log(`Provider Standard v1 self-check: ${target.source}`);
  if ("problems" in target) {
    for (const problem of target.problems) print({ status: "fail", text: problem });
    return 1;
  }

  const { manifest, manifestUrl } = target;
  const network = manifest.payment.accepts[0].network;
  const lines: Line[] = [
    { status: "ok", text: `manifest: ${manifest.services.length} service(s) on ${network}, served at ${manifestUrl}` },
  ];
  if (manifest.baseUrl.startsWith("http://")) lines.push({ status: "warn", text: "dev mode: clients accept http:// only in development [M6]" });

  if (target.facilitator !== undefined) {
    lines.push(
      await attempt("facilitator", async () => {
        await checkFacilitator(target.facilitator!, network);
        return `settles x402 exact on ${network} with sponsored fees`;
      }),
    );
  }
  lines.push(await attempt("payTo", () => checkPayTo(manifest)));
  let registered: Record<string, unknown> | undefined;
  try {
    const registration = await inspectRegistration(manifest, manifestUrl);
    registered = registration.file;
    for (const finding of registration.findings) {
      lines.push({ status: finding.ok ? "ok" : "fail", text: `8004 [${finding.rule}]: ${finding.message}` });
    }
  } catch (error) {
    lines.push({ status: "fail", text: `8004: the identity registry can't be read: ${(error as Error).message}` });
  }

  lines.forEach(print);
  console.log(`\n${howAgentsSeeYou(manifest, registered).join("\n")}\n`);
  const failed = lines.filter((line) => line.status === "fail").length;
  console.log(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}

async function checkPayTo(manifest: ProviderManifest): Promise<string> {
  const { network, payTo } = manifest.payment.accepts[0];
  // A contract holds SAC balances without a trustline.
  if (payTo.startsWith("C")) return `${payTo} is a contract: no trustline needed`;
  const response = await fetch(`${HORIZON_URL[network]}/accounts/${payTo}`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) {
    throw new Error(`${payTo} does not exist on ${network}: ${network === "stellar:testnet" ? "provider-kit trustline funds it and adds USDC" : "send it some XLM first"}`);
  }
  if (!response.ok) throw new Error(`Horizon answered ${response.status}`);
  const account = (await response.json()) as { balances: { asset_code?: string; asset_issuer?: string }[] };
  const trusted = account.balances.some((balance) => balance.asset_code === "USDC" && balance.asset_issuer === USDC_ISSUER[network]);
  if (!trusted) throw new Error(`${payTo} has no USDC trustline, so it can't be paid [P2]: add one with provider-kit trustline`);
  return `${payTo} exists and has a USDC trustline`;
}

async function attempt(label: string, run: () => Promise<string>): Promise<Line> {
  try {
    return { status: "ok", text: `${label}: ${await run()}` };
  } catch (error) {
    return { status: "fail", text: `${label}: ${(error as Error).message}` };
  }
}

function print(line: Line): void {
  console.log(`  ${MARK[line.status]} ${line.text}`);
}
