// @stellar-agent-services/payment-client
//
// DESIGN OPEN. Do not implement until the design in docs/payment-client.md is decided.
//
// Fixed requirements (SOW + IMPLEMENTATION_PLAN.md §5.6), whatever the design:
// - Wallet separation: keys never touch discovery (stellar-agent-search) or provider code.
// - Explicit approval: show the service, price, recipient (payTo), asset and network, and approve
//   that exact payment once.
// - Spending controls: a per-payment cap and a rolling budget. A failed limit check blocks the payment.
// - Challenge validation: the 402 must match the approved manifest.
// - Durable journal: the job id, token and request hash are written BEFORE sending. Never re-sign
//   the same job.
// - Recovery: check-status and get-result only, never re-sending the payment.
// - Settlement proof: confirm the on-chain USDC transfer before showing "paid".

export {};
