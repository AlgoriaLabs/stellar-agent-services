// The x402 facilitator: verifies and settles payments for the provider, which holds no secret key.
//
// httpFacilitator() is the kit's own client rather than @x402/core's HTTPFacilitatorClient, so that:
// - the URL is HTTPS (http://localhost only in development) and redirects are refused, so a payment
//   is never sent anywhere the operator did not configure;
// - every call has a deadline. settle's waits for the transaction's ledger, so its default deadline is
//   the payment's maxTimeoutSeconds plus a margin. A settle call that runs out of time is "uncertain",
//   never "failed" (settlement.ts);
// - only the fields a facilitator needs are sent, and its answers are size-bounded and shape-checked.
// Testnet: https://x402.org/facilitator supports stellar:testnet + exact with sponsored fees.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { readBounded } from "../http/bounded.js";

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

/** The facilitator calls the provider makes. httpFacilitator() implements it; tests pass a fake. */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  /** GET /supported. A fake may leave it out; the startup check is then skipped. */
  supported?(): Promise<{ kinds: SupportedKind[] }>;
}

export interface FacilitatorOptions {
  /** Allows an http://localhost facilitator, for local development. */
  dev?: boolean;
  /** Default 20. */
  verifyTimeoutSeconds?: number;
  /** Default: the payment's maxTimeoutSeconds + 30, since settle waits for the transaction's ledger. */
  settleTimeoutSeconds?: number;
  /** Sent with every call, for facilitators that want an API key. Never a Stellar secret. */
  headers?: Record<string, string>;
}

export class FacilitatorError extends Error {
  override name = "FacilitatorError";
}

const DEFAULT_VERIFY_TIMEOUT_SECONDS = 20;
const SETTLE_TIMEOUT_MARGIN_SECONDS = 30;
const SUPPORTED_TIMEOUT_SECONDS = 15;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** How long a settle call may take before the kit treats it as uncertain. */
export function settleTimeoutSeconds(maxTimeoutSeconds: number, options: FacilitatorOptions = {}): number {
  return options.settleTimeoutSeconds ?? maxTimeoutSeconds + SETTLE_TIMEOUT_MARGIN_SECONDS;
}

export function httpFacilitator(url: string, options: FacilitatorOptions = {}): Facilitator {
  const base = new URL(url);
  const loopback = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(options.dev && loopback)) {
    throw new TypeError("the facilitator URL must be https:// (http://localhost is allowed with dev: true)");
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
    throw new TypeError("the facilitator URL must not have user info, a query or a fragment");
  }
  const root = base.toString().replace(/\/+$/, "");

  const call = async (path: string, init: { method: string; body?: unknown; timeoutSeconds: number }) => {
    const response = await fetch(`${root}/${path}`, {
      method: init.method,
      headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutSeconds * 1000),
    });
    const bytes = await readBounded(response.body, MAX_RESPONSE_BYTES);
    if (bytes === undefined) throw new FacilitatorError(`${path} answered with more than ${MAX_RESPONSE_BYTES} bytes`);
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new FacilitatorError(`${path} answered ${response.status} without JSON`);
    }
    return { status: response.status, body: isObject(body) ? body : {} };
  };

  // Only what the scheme needs: no resource description, no extensions.
  const request = (payload: PaymentPayload, requirements: PaymentRequirements) => ({
    x402Version: 2,
    paymentPayload: { x402Version: payload.x402Version, accepted: payload.accepted, payload: payload.payload },
    paymentRequirements: requirements,
  });

  return {
    async verify(payload, requirements) {
      const { status, body } = await call("verify", {
        method: "POST",
        body: request(payload, requirements),
        timeoutSeconds: options.verifyTimeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS,
      });
      // A facilitator may answer an invalid payment with 400 and a verify body.
      if (typeof body["isValid"] !== "boolean") throw new FacilitatorError(`verify answered ${status}`);
      const result: VerifyResult = { isValid: body["isValid"] };
      if (typeof body["invalidReason"] === "string") result.invalidReason = body["invalidReason"];
      if (typeof body["payer"] === "string") result.payer = body["payer"];
      return result;
    },

    async settle(payload, requirements) {
      const { status, body } = await call("settle", {
        method: "POST",
        body: request(payload, requirements),
        timeoutSeconds: settleTimeoutSeconds(requirements.maxTimeoutSeconds, options),
      });
      if (typeof body["success"] !== "boolean") throw new FacilitatorError(`settle answered ${status}`);
      const response: SettleResponse = {
        success: body["success"],
        transaction: typeof body["transaction"] === "string" ? body["transaction"] : "",
        network: (typeof body["network"] === "string" ? body["network"] : "") as SettleResponse["network"],
      };
      if (typeof body["payer"] === "string") response.payer = body["payer"];
      if (typeof body["errorReason"] === "string") response.errorReason = body["errorReason"];
      return response;
    },

    async supported() {
      const { status, body } = await call("supported", { method: "GET", timeoutSeconds: SUPPORTED_TIMEOUT_SECONDS });
      if (status !== 200 || !Array.isArray(body["kinds"])) throw new FacilitatorError(`supported answered ${status}`);
      return { kinds: body["kinds"].filter(isObject) as unknown as SupportedKind[] };
    },
  };
}

/**
 * Startup check: the facilitator settles x402 v2 `exact` payments on the network, with fees
 * sponsored as the manifest promises. Throws with the reason otherwise.
 */
export async function checkFacilitator(facilitator: Facilitator, network: StellarNetwork): Promise<void> {
  if (facilitator.supported === undefined) return;
  const { kinds } = await facilitator.supported();
  const kind = kinds.find((candidate) => candidate.x402Version === 2 && candidate.scheme === "exact" && candidate.network === network);
  if (kind === undefined) throw new FacilitatorError(`the facilitator does not support x402 v2 "exact" payments on ${network}`);
  if (kind.extra?.["areFeesSponsored"] !== true) throw new FacilitatorError(`the facilitator does not sponsor fees on ${network}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
