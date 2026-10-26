// verifier badge: the SVG badges a receipt earns, written next to it as <sha256>.<badge>.svg.
//
// "8004 validated" is drawn only with --request-hash, and only once the Validation Registry record of
// that request anchors this very receipt (publish.ts, anchorProblems).

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { badgesFor } from "../badges.js";
import { anchorProblems } from "../publish.js";
import { readReceipt } from "../receipt.js";
import { rpcRegistry } from "../registry.js";
import { UsageError, type CliFlags, type Io } from "./shared.js";

export async function badge(path: string, flags: CliFlags, io: Io): Promise<number> {
  for (const flag of ["pay", "service", "input", "validator", "response-uri", "source", "network", "max-age", "dry-run", "max-price", "max-spend"] as const) {
    if (flags[flag] !== undefined) throw new UsageError(`--${flag} does not apply to badge`);
  }
  const { receipt, sha256 } = await readReceipt(path);

  let validated = false;
  let problems: string[] = [];
  const requestHash = flags["request-hash"]?.toLowerCase().replace(/^0x/, "");
  if (requestHash !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(requestHash)) throw new UsageError("--request-hash must be 64 hex characters");
    const registry = io.registry ?? rpcRegistry(receipt.network, flags.rpc);
    problems = anchorProblems(await registry.validation(requestHash), receipt, sha256);
    validated = problems.length === 0;
    if (!validated) io.err(`"8004 validated" is not earned: ${problems.join("; ")}`);
  }

  const out = flags.out ?? dirname(path);
  const badges = badgesFor(receipt, { receiptSha256: sha256, validated });
  for (const each of badges) {
    const file = join(out, `${sha256}.${each.id}.svg`);
    await writeFile(file, each.svg);
    io.out(`${each.label} (${each.message}): ${file}`);
  }
  if (badges.length === 0) io.out("The receipt earns no badge: the provider is not even Described, and C7 did not pass.");
  return problems.length === 0 ? 0 : 1;
}
