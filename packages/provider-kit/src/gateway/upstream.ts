// Gateway mode: the handler that forwards a paid job to the upstream API.
//
// TODO:
// - upstreamHandler(service): POST the validated input JSON to upstream.url, with the configured
//   headers and an AbortSignal for timeoutSeconds.
// - A 2xx JSON response is the output (then validated against outputSchema). Anything else fails the
//   job with service_failed, output_invalid or timeout.
// - The service's capacity.concurrency caps the calls in flight to the upstream, so its own 429s are
//   rare. An upstream 429 or 503 is retried within the job's budget, honoring its Retry-After.
// - The upstream never sees payment headers, job tokens or the payer address.
// - v1 calls the upstream and waits. Adapters for upstreams with their own submit/poll APIs are later
//   work.

export {};
