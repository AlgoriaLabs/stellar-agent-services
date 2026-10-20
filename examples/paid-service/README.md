# Example paid service

A sample provider built only with `@stellar-agent-services/provider-kit`. Pilot providers can copy it as
their template.

| Service | Charge | Price | Purpose |
| --- | --- | --- | --- |
| `text-stats` | on-success | 0.01 USDC | The basic paid call: finishes at once, failed work is never charged |
| `delayed-report` | upfront | 0.02 USDC | The Job Recovery demo: answers `202`, then check-status and get-result |

Providers with an existing API in another language don't need this template. They can use the kit's gateway
mode (`provider-kit serve --config <file>`) instead.

Status: scaffold only. Setup steps will be in [docs/provider-setup-guide.md](../../docs/provider-setup-guide.md).
