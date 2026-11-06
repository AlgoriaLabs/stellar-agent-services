// The application's trusted verification source [V1]. Provider-supplied badges or receipts alone are not proof.
// Sources authenticate their validator and receipt/registry data; the core binds their answer to this payment.

import type { ConformanceLevel, StellarNetwork } from "@stellar-agent-services/protocol";

export interface VerificationSubject {
  network: StellarNetwork;
  payTo: string;
  manifestUrl: string;
  /** SHA-256 of the approved manifest's RFC 8785 canonical JSON. */
  manifestSha256: string;
  agentId?: number;
}

export interface ProviderVerification extends VerificationSubject {
  /** RFC 3339: when the source checked this provider, and when its evidence becomes too old to use. */
  checkedAt: string;
  expiresAt: string;
  /** ERC-8126 risk score, 0–100, lower is better. Separate from the §8 conformance score. */
  riskScore?: number;
  /** Provider Standard §8: 0, Described (1), Payable (2), Recoverable (3). */
  level?: ConformanceLevel;
}

/**
 * Installed by the application, never selected by a provider. A source must authenticate its trusted
 * validators, verify receipt hashes against registry records when used, and apply bounded network timeouts.
 * Return undefined when there is no trustworthy evidence. Do not copy a manifest's claims into an answer.
 */
export interface VerificationSource {
  read(subject: VerificationSubject): Promise<ProviderVerification | undefined>;
}

/** Unknown, stale or mismatched evidence never satisfies a configured minimum [V1]. */
export function matchesVerification(
  evidence: ProviderVerification | undefined,
  subject: VerificationSubject,
  now = Date.now(),
): evidence is ProviderVerification {
  if (evidence === undefined || evidence === null || typeof evidence !== "object") return false;
  if (evidence.network !== subject.network || evidence.payTo !== subject.payTo ||
      evidence.manifestUrl !== subject.manifestUrl || evidence.manifestSha256 !== subject.manifestSha256 ||
      evidence.agentId !== subject.agentId) return false;
  if (evidence.riskScore !== undefined &&
      (!Number.isInteger(evidence.riskScore) || evidence.riskScore < 0 || evidence.riskScore > 100)) return false;
  if (evidence.level !== undefined &&
      (!Number.isInteger(evidence.level) || evidence.level < 0 || evidence.level > 3)) return false;
  // Requiring an explicit time zone avoids interpreting a source's dates in the machine's local zone.
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof evidence.checkedAt !== "string" || typeof evidence.expiresAt !== "string" ||
      !timestamp.test(evidence.checkedAt) || !timestamp.test(evidence.expiresAt)) return false;
  const checkedAt = Date.parse(evidence.checkedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  return Number.isFinite(checkedAt) && Number.isFinite(expiresAt) && checkedAt <= now && now < expiresAt;
}
