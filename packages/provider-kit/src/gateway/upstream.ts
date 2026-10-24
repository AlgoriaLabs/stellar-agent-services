// Gateway mode: the handler that forwards a paid job to the upstream API.
//
// - The validated input is POSTed as JSON to upstream.url, with the configured headers and
//   `Idempotency-Key: <job id>`, so an upstream can recognize a job the gateway runs again after a
//   restart. The upstream never sees payment headers, job tokens or the payer address.
// - A 2xx JSON object is the output; the runner then checks it against outputSchema. Anything else
//   fails the job: service_failed (charged only for upfront services, as with any handler failure).
// - Busy or briefly unavailable upstreams (429, 502, 503, 504, connection errors) are retried within
//   the job's time, honoring Retry-After. The service's capacity.concurrency caps the calls in flight,
//   so set it to what the upstream takes and its 429s stay rare.
// - Redirects are not followed, and responses are size-bounded.
// v1 calls the upstream and waits. Upstreams with their own submit/poll APIs need an adapter: later work.

import type { JsonObject } from "@stellar-agent-services/protocol";
import type { HandlerContext } from "../define-service.js";
import { readBounded } from "../http/bounded.js";

export interface UpstreamConfig {
  /** Where the input is POSTed. http:// is fine for an upstream on a private network. */
  url: string;
  /** Sent with every call, such as the upstream's own API key. Never a Stellar secret. */
  headers?: Record<string, string>;
}

export class UpstreamError extends Error {
  override name = "UpstreamError";
}

/** Largest upstream answer read. */
export const MAX_UPSTREAM_RESPONSE_BYTES = 10 * 1024 * 1024;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 30_000;

export function upstreamHandler(upstream: UpstreamConfig): (input: JsonObject, context: HandlerContext) => Promise<JsonObject> {
  const url = new URL(upstream.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`upstream.url must be http(s): ${upstream.url}`);

  return async (input, { signal, jobId }) => {
    const body = JSON.stringify(input);
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { ...upstream.headers, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": jobId },
          body,
          redirect: "error",
          signal,
        });
      } catch (error) {
        if (signal.aborted || attempt >= MAX_ATTEMPTS) throw new UpstreamError(`the upstream could not be reached: ${(error as Error).message}`);
        await wait(backoff(attempt), signal);
        continue;
      }

      if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel();
        await wait(retryAfterMs(response) ?? backoff(attempt), signal);
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel();
        throw new UpstreamError(`the upstream answered ${response.status}`);
      }
      const bytes = await readBounded(response.body, MAX_UPSTREAM_RESPONSE_BYTES);
      if (bytes === undefined) throw new UpstreamError(`the upstream answer is larger than ${MAX_UPSTREAM_RESPONSE_BYTES} bytes`);
      let output: unknown;
      try {
        output = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new UpstreamError("the upstream did not answer with JSON");
      }
      if (typeof output !== "object" || output === null || Array.isArray(output)) throw new UpstreamError("the upstream did not answer with a JSON object");
      return output as JsonObject;
    }
  };
}

function backoff(attempt: number): number {
  return Math.min(MAX_RETRY_WAIT_MS, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Math.min(MAX_RETRY_WAIT_MS, Number(value.trim()) * 1000);
}

/** Waits `ms`, or rejects as soon as the job runs out of time. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
