// C3 Challenge (docs/provider-standard.md §4.2, §4.3), with no payment:
//
//   invalid input  400 invalid_input, never a 402: nobody pays for invalid input [P8]
//   valid input    402 with the x402 v2 PAYMENT-REQUIRED header [P3]: one accepts entry equal to the
//                  manifest's payment option plus the price [P4], for the public create-job URL [P5],
//                  and SHOULD carry the Bazaar discovery extension [P6]
//   payTo          a G... payTo exists and holds an authorized USDC trustline [P2]
//
// Every service with an input is probed: its example, the caller's --input, or an input built from its
// schema. A challenge that matches the manifest is kept; C4 signs only such a one [P7].

import { checkChallenge as compareChallenge, stellarAddressKind, type CheckResult, type JsonObject } from "@stellar-agent-services/protocol";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { usdcTrustline } from "../chain.js";
import { Recorder, skipped, type RunContext } from "../context.js";
import { answered, problemCode, type Exchange } from "../http.js";
import { createJob, isBusy, newIds } from "../jobs.js";
import { isObject } from "../json.js";
import { invalidInput } from "../schemas.js";

/** How long a probe waits out a busy provider, sending the same request again [Q8]. */
export const BUSY_WAIT_MS = 30_000;

export async function checkChallenge(ctx: RunContext): Promise<CheckResult> {
  const manifest = ctx.manifest;
  if (manifest === undefined || !ctx.usable) return skipped("C3", "the manifest could not be used (C1)");
  const recorder = new Recorder("C3");
  const probed: JsonObject[] = [];
  const unprobed: string[] = [];

  for (const service of manifest.services) {
    const probe = ctx.inputs.get(service.name);
    if (probe === undefined) {
      unprobed.push(service.name);
      continue;
    }
    const name = `create-job for "${service.name}"`;

    const invalid = await createJob(ctx, "C3", service.name, invalidInput(service.inputSchema), { ids: newIds(), busyWaitMs: BUSY_WAIT_MS });
    if (invalid.status === 402) recorder.fail("P8", `${name} asked for payment for an input that fails inputSchema`);
    else if (isBusy(invalid)) recorder.inconclusive(`${name} stayed busy (${invalid.status}), so its input validation was not checked`);
    else if (invalid.status !== 400 || problemCode(invalid) !== "invalid_input") {
      recorder.fail("P8", `${name} ${answered(invalid)} to an input that fails inputSchema; it must answer 400 invalid_input`);
    }

    const exchange = await createJob(ctx, "C3", service.name, probe.input, { ids: newIds(), busyWaitMs: BUSY_WAIT_MS });
    const challenge = readChallenge(exchange, name, probe.source, recorder);
    if (challenge === undefined) continue;
    const violations = compareChallenge(manifest, service.name, challenge);
    for (const violation of violations) recorder.fail(violation.rule, `${name}: the challenge's ${violation.pointer || "/"}: ${violation.message}`);
    const bazaar = isObject(challenge.extensions) && isObject(challenge.extensions["bazaar"]);
    if (!bazaar) recorder.warn("P6", `${name}: the challenge has no Bazaar discovery extension`);
    if (violations.length === 0) ctx.challenges.set(service.name, challenge);
    probed.push({ service: service.name, input: probe.source, amount: service.price.amount, matches: violations.length === 0, bazaar });
  }
  recorder.evidence["services"] = probed;
  if (unprobed.length > 0) recorder.evidence["unprobed"] = unprobed;
  if (probed.length === 0 && !recorder.failed) {
    recorder.inconclusive("no service has an input to probe it with: add examples, or pass --service and --input");
  }

  await checkTrustline(ctx, recorder);
  return recorder.result();
}

/** The decoded PAYMENT-REQUIRED challenge of an unpaid create-job answer [P3], or undefined with the reason recorded. */
export function readChallenge(exchange: Exchange, name: string, source: string, recorder: Recorder): PaymentRequired | undefined {
  if (isBusy(exchange)) {
    recorder.inconclusive(`${name} stayed busy (${exchange.status}), so its challenge was not checked`);
    return undefined;
  }
  if (exchange.status !== 402) {
    // Every probe input matches inputSchema, so a provider that rejects it validates against something else.
    const rejected = exchange.status === 400 && problemCode(exchange) === "invalid_input";
    recorder.fail("P3", rejected ? `${name} rejected the ${source} input, which matches inputSchema, as invalid_input` : `${name} ${answered(exchange)} without payment; it must answer 402`);
    return undefined;
  }
  const header = exchange.headers.get("PAYMENT-REQUIRED");
  if (header === null) {
    recorder.fail("P3", `${name} answered 402 without the PAYMENT-REQUIRED header`);
    return undefined;
  }
  try {
    const challenge = decodePaymentRequiredHeader(header);
    if (isObject(challenge)) return challenge;
  } catch {
    // Reported below.
  }
  recorder.fail("P3", `${name}: PAYMENT-REQUIRED is not a base64-encoded x402 PaymentRequired`);
  return undefined;
}

/** [P2]: a G... payTo exists and can hold USDC. A contract holds SAC balances without a trustline. */
async function checkTrustline(ctx: RunContext, recorder: Recorder): Promise<void> {
  const { network, payTo } = ctx.manifest!.payment.accepts[0];
  const kind = stellarAddressKind(payTo);
  if (kind === "contract") {
    recorder.evidence["payTo"] = "contract";
    return;
  }
  // An invalid address already failed P11 in C1.
  if (kind === undefined) return;
  if (ctx.chain === undefined) {
    recorder.inconclusive("no Soroban RPC to read payTo's USDC trustline");
    return;
  }
  let state;
  try {
    state = await usdcTrustline(ctx.chain, network, payTo);
  } catch (error) {
    recorder.inconclusive(`payTo's USDC trustline could not be read: ${(error as Error).message}`);
    return;
  }
  recorder.evidence["payTo"] = state;
  if (state === "no_account") recorder.fail("P2", `payTo ${payTo} does not exist on ${network}`);
  if (state === "missing") recorder.fail("P2", `payTo ${payTo} has no USDC trustline, so it can't be paid`);
  if (state === "unauthorized") recorder.fail("P2", `payTo ${payTo} holds a USDC trustline the issuer has not authorized`);
}
