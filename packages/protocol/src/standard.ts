// Standard identity, version and limits (docs/provider-standard.md).
//
// TODO:
// - PROVIDER_STANDARD = "stellar-agent-services/provider@1" (the manifest's `standard` field).
//   Clients reject a different major version and ignore unknown fields [M8].
// - DEFAULT_MANIFEST_PATH = "/.well-known/stellar-agent-services.json". The manifest may live at any
//   HTTPS URL on the same origin as baseUrl; the 8004 registration points to the real one [M2].
// - Job paths, fixed relative to baseUrl [§5.1]: /services/{name}/jobs, /jobs/{jobId},
//   /jobs/{jobId}/result.
// - SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/: valid as a URL segment, an MCP tool name and
//   an LLM function name.
// - Limits: manifest 256 KiB, provider name 120, provider description 500, service title 120,
//   service description 1000, URL 300, at most 25 services, schema 32 KiB, at most 5 examples,
//   at most 10 tags, maxInputBytes default 1 MiB and at most 10 MiB.
// - Timing: maxTimeoutSeconds 30–300, create-job holds the response at most 30 s [J9],
//   retentionSeconds default 86400 and at least 3600.
// - SPEC_URL: base of the problem `type` URIs (set at the v1 freeze).

export {};
