// What identifies this verifier: the User-Agent of its requests, so providers can tell a verification
// run in their logs, and the `tool` of the receipts it issues.

export const TOOL = { name: "@stellar-agent-services/verifier", version: "0.0.0" } as const;

export const USER_AGENT = `stellar-agent-services-verifier/${TOOL.version} (+https://github.com/AlgoriaLabs/stellar-agent-services)`;
