// Standard identity, version and limits (docs/provider-standard.md).
//
// Structural limits (field lengths, counts, ranges) live in schemas/manifest.schema.json. This file
// holds only what code needs.

/** The manifest's `standard` field. Clients reject a different major version [M8]. */
export const PROVIDER_STANDARD = "stellar-agent-services/provider@1";

/** Default manifest location on the provider's origin [M2]. */
export const DEFAULT_MANIFEST_PATH = "/.well-known/stellar-agent-services.json";

/**
 * `$id` of schemas/manifest.schema.json. Provisional until the v1 freeze picks the published URL
 * (IMPLEMENTATION_PLAN.md, open decision 6).
 */
export const MANIFEST_SCHEMA_ID =
  "https://algorialabs.github.io/stellar-agent-services/schemas/provider/1/manifest.schema.json";

/** Largest manifest a client reads [M3]. */
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** Largest inputSchema or outputSchema, measured as UTF-8 canonical JSON [S6]. */
export const SERVICE_SCHEMA_MAX_BYTES = 32 * 1024;

/** A service name is a URL path segment, an MCP tool name and an LLM function name (§3.1). */
export const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Base of the problem `type` URIs (§6): `${SPEC_URL}#error-<code>`. Provisional until the v1 freeze
 * picks the published URL (IMPLEMENTATION_PLAN.md, open decision 6).
 */
export const SPEC_URL = "https://algorialabs.github.io/stellar-agent-services/provider/1";

/** Longest a provider holds the create-job response open before it must answer 202 [J9]. */
export const CREATE_JOB_HOLD_MAX_SECONDS = 30;

/** How long finished jobs stay retrievable when the manifest sets no `jobs.retentionSeconds` [J15]. */
export const DEFAULT_RETENTION_SECONDS = 86400;
