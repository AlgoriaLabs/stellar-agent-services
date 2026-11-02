// The verifier `provider-kit launch` asks for validation when --validator names none (docs/verification.md). A verifier
// that runs `verifier watch` answers every validation request naming its account, with no hand-off: it checks the
// provider, publishes its receipt and answers on chain.
//
// STELLAR_VALIDATOR names another one from the environment. A network with no default verifier gets no request
// unless one is named.

import type { StellarNetwork } from "@stellar-agent-services/protocol";

/** The default verifier's account, per network. Fill in a verifier's G... address once it runs `verifier watch`. */
export const DEFAULT_VALIDATORS: Partial<Record<StellarNetwork, string>> = {};

/** The verifier to ask: STELLAR_VALIDATOR, else the network's default. */
export function defaultValidator(network: StellarNetwork, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env["STELLAR_VALIDATOR"];
  return named !== undefined && named !== "" ? named : DEFAULT_VALIDATORS[network];
}
