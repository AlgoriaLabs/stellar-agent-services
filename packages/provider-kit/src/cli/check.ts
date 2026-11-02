// provider-kit check: a provider's self-check against Provider Standard v1, with no payment and no key.
//
//   manifest      the JSON Schema and the rules of §2.4 (what clients and verifiers reject)
//   facilitator   settles x402 `exact` on the network, with sponsored fees (gateway configs)
//   payTo         the account exists and has a USDC trustline [P2]
//   8004          the registration names the manifest, the agent and payTo match [I1]–[I3]
// Then how agents see the provider (discovery.ts): what search matches, and hints that never fail the check.
// --fix writes the words search would miss into a gateway config's provider.description. --json prints the result
// as JSON, for scripts and coding agents. `verifier check` goes further, calling create-job without paying (C3, C6, C7).

import { readFile, rename, writeFile } from "node:fs/promises";
import { HORIZON_URL, USDC_ISSUER, type ProviderManifest } from "@stellar-agent-services/protocol";
import { checkFacilitator } from "../payments/facilitator.js";
import { inspectRegistration } from "../registration.js";
import { describedWithServices, howAgentsSeeYou } from "./discovery.js";
import { nextCommand, UsageError, type CliFlags } from "./shared.js";
import { loadTarget } from "./target.js";

type Line = { status: "ok" | "fail" | "warn"; text: string };
const MARK = { ok: "✓", fail: "✗", warn: "!" } as const;

export async function check(flags: CliFlags): Promise<number> {
  if (flags.fix && flags.config === undefined) throw new UsageError("--fix edits a gateway config: pass --config <file>");
  const target = await loadTarget(flags);
  const say = flags.json ? () => {} : (line: string) => console.log(line);
  say(`Provider Standard v1 self-check: ${target.source}`);
  if ("problems" in target) {
    const lines = target.problems.map((problem): Line => ({ status: "fail", text: problem }));
    if (flags.json) console.log(JSON.stringify({ ok: false, source: target.source, checks: lines }, null, 2));
    else lines.forEach(print);
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
  if (manifest.provider.agentId === undefined && manifest.baseUrl.startsWith("http://")) {
    // A provider on this computer isn't registered yet: launch registers it with its public address.
    lines.push({ status: "warn", text: `8004: not registered yet: ${nextCommand("launch")} registers it, with your public address` });
  } else {
    try {
      const registration = await inspectRegistration(manifest, manifestUrl);
      registered = registration.file;
      for (const finding of registration.findings) {
        lines.push({ status: finding.ok ? "ok" : "fail", text: `8004 [${finding.rule}]: ${finding.message}` });
      }
    } catch (error) {
      lines.push({ status: "fail", text: `8004: the identity registry can't be read: ${(error as Error).message}` });
    }
  }

  const agents = howAgentsSeeYou(manifest, registered);
  const suggested = describedWithServices(manifest);
  let fixed: string | undefined;
  if (flags.fix && suggested !== undefined) {
    await writeDescription(flags.config!, suggested);
    fixed = suggested;
  }
  const failed = lines.filter((line) => line.status === "fail").length;
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: failed === 0,
          source: target.source,
          manifestUrl,
          checks: lines,
          howAgentsSeeYou: agents,
          ...(suggested === undefined ? {} : { suggestedDescription: suggested }),
          ...(fixed === undefined ? {} : { fixed: { file: flags.config, description: fixed } }),
        },
        null,
        2,
      ),
    );
    return failed === 0 ? 0 : 1;
  }
  lines.forEach(print);
  console.log(`\n${agents.join("\n")}\n`);
  if (fixed !== undefined) {
    console.log(`✓ Wrote provider.description in ${flags.config}, so search finds your services' words:\n    ${fixed}`);
    console.log(`  Restart the provider to serve it${registered === undefined ? "" : `, and run ${nextCommand("launch")} to update the registration search reads`}.\n`);
  } else if (suggested !== undefined) {
    console.log(
      flags.config === undefined
        ? `Put this in provider.description, so search finds your services' words:\n    ${suggested}\n`
        : `Run check again with --fix to write the missing words into provider.description${nextCommand("check") === "npm run check" ? " (npm run check -- --fix)" : ""}.\n`,
    );
  }
  console.log(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}

/** Sets provider.description in a gateway config, keeping the rest of the file as it was. */
async function writeDescription(path: string, description: string): Promise<void> {
  const text = await readFile(path, "utf8");
  const config = JSON.parse(text) as { provider?: Record<string, unknown> };
  if (typeof config.provider !== "object" || config.provider === null) throw new Error(`${path} has no "provider" object`);
  config.provider["description"] = description;
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, indent)}\n`);
  await rename(temporary, path);
}

async function checkPayTo(manifest: ProviderManifest): Promise<string> {
  const { network, payTo } = manifest.payment.accepts[0];
  // A contract holds SAC balances without a trustline.
  if (payTo.startsWith("C")) return `${payTo} is a contract: no trustline needed`;
  const response = await fetch(`${HORIZON_URL[network]}/accounts/${payTo}`, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) {
    throw new Error(`${payTo} does not exist on ${network}: ${network === "stellar:testnet" ? "provider-kit dev makes a throwaway testnet account, and launch sets up your own" : "send it some XLM first"}`);
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
