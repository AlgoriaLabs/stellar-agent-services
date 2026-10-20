# @stellar-agent-services/protocol

Provider Standard v1 as code. It holds the manifest, job, receipt and header definitions that every other
package shares.

- No runtime dependencies and no signing code, so the read-only discovery server can import it safely.
- Specification: [docs/provider-standard.md](../../docs/provider-standard.md).
- The manifest JSON Schema and test vectors published here let implementations in other languages check
  themselves.
