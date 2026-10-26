// The verifier's HTTP client. The provider is untrusted, so every request:
// - never follows a redirect [M3]: a 3xx is recorded as the answer;
// - has a deadline, and reads at most `maxBytes` of the body;
// - goes only to the manifest's origin, once the manifest has named it, so a manifest can't make the
//   verifier send requests to someone else's server;
// - is identified by a User-Agent.
// Every exchange is kept, with the secrets its request carried (job tokens, signed payments), so the
// hygiene check (C6) can look at all of them at the end [E2].

import type { CheckId } from "@stellar-agent-services/protocol";
import { USER_AGENT } from "./tool.js";

export interface HttpRequest {
  method: "GET" | "POST" | "OPTIONS";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Default 15 s. */
  timeoutMs?: number;
  /** Default 1 MiB. A longer body is not read: the exchange records "too_large". */
  maxBytes?: number;
  /** Values this request carries that no response may ever contain: job tokens, signed payments [E2]. */
  secrets?: string[];
  /** A request outside the provider, such as a registration file on another host. Not limited to its origin. */
  external?: boolean;
}

export interface Exchange {
  check: CheckId;
  method: string;
  url: string;
  /** Undefined when no response arrived. */
  status: number | undefined;
  headers: Headers;
  /** The body, as far as it was read. */
  bytes: Uint8Array;
  /** The body as UTF-8, invalid bytes replaced. */
  text: string;
  error?: "timeout" | "network" | "too_large";
  errorMessage?: string;
  ms: number;
  /** Whether the request went to the provider, rather than an external host. */
  provider: boolean;
}

export interface HttpClient {
  request(check: CheckId, request: HttpRequest): Promise<Exchange>;
  /** Every exchange so far, in the order the responses arrived. */
  readonly exchanges: readonly Exchange[];
  /** Every secret sent so far. */
  readonly secrets: ReadonlySet<string>;
  /** From now on, provider requests may go to this origin only. */
  restrictTo(origin: string): void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export function httpClient(fetchFn: typeof fetch = fetch): HttpClient {
  const exchanges: Exchange[] = [];
  const secrets = new Set<string>();
  let origin: string | undefined;

  return {
    exchanges,
    secrets,
    restrictTo(allowed) {
      origin = allowed;
    },
    async request(check, request) {
      const external = request.external ?? false;
      // A programming error, not a provider's: every URL the checks build comes from the manifest.
      if (!external && origin !== undefined && new URL(request.url).origin !== origin) {
        throw new Error(`refusing a request to ${request.url}: provider requests stay on ${origin}`);
      }
      for (const secret of request.secrets ?? []) secrets.add(secret);

      const started = performance.now();
      const exchange: Exchange = {
        check,
        method: request.method,
        url: request.url,
        status: undefined,
        headers: new Headers(),
        bytes: new Uint8Array(),
        text: "",
        ms: 0,
        provider: !external,
      };
      try {
        const response = await fetchFn(request.url, {
          method: request.method,
          headers: { "User-Agent": USER_AGENT, ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: "manual",
          signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        exchange.status = response.status;
        exchange.headers = response.headers;
        const body = await readBounded(response.body, request.maxBytes ?? DEFAULT_MAX_BYTES);
        if (body === undefined) {
          exchange.error = "too_large";
          exchange.errorMessage = `the body is larger than ${request.maxBytes ?? DEFAULT_MAX_BYTES} bytes`;
        } else {
          exchange.bytes = body;
          exchange.text = new TextDecoder().decode(body);
        }
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        exchange.error = timedOut ? "timeout" : "network";
        exchange.errorMessage = timedOut ? `no answer within ${(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s` : describe(error);
      }
      exchange.ms = Math.round(performance.now() - started);
      exchanges.push(exchange);
      return exchange;
    },
  };
}

/** The body, or undefined once it is over `maxBytes`: reading stops there. */
export async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | undefined> {
  const reader = body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A transport error in a few words: the cause's message when fetch wraps it ("fetch failed"). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined ? error.message : `${error.message}: ${cause}`;
}

/** What happened to a request, for messages: "answered 503", "gave no answer within 30 s". */
export function answered(exchange: Exchange): string {
  switch (exchange.error) {
    case "timeout":
      return exchange.status === undefined ? `gave ${exchange.errorMessage}` : `answered ${exchange.status}, but its body did not arrive in time`;
    case "network":
      return `could not be reached (${exchange.errorMessage})`;
    case "too_large":
      return `answered ${exchange.status} with ${exchange.errorMessage}`;
    default:
      return `answered ${exchange.status}`;
  }
}

/** The `code` of a problem answer (§6), or undefined. */
export function problemCode(exchange: Exchange): string | undefined {
  const body = jsonBody(exchange);
  return typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : undefined;
}

/** The body as JSON, or undefined when it is not JSON or was not read in full. */
export function jsonBody(exchange: Exchange): unknown {
  if (exchange.error !== undefined) return undefined;
  try {
    return JSON.parse(exchange.text) as unknown;
  } catch {
    return undefined;
  }
}
