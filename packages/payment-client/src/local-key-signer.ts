// The built-in signer: a Stellar secret key held in this process. For developers, CI and an agent's
// allowance wallet. A plain key enforces no limits of its own, so it has no budget(); the spending
// policy applies on its own.

import type { StellarNetwork } from "@stellar-agent-services/protocol";
import { createEd25519Signer } from "@x402/stellar";
import type { Signer } from "./strategies.js";

export function localKeySigner(secret: string, network: StellarNetwork): Signer {
  return createEd25519Signer(secret, network);
}
