// Badges (docs/verification.md): SVG images derived only from a verification receipt, never from what a
// provider says about itself.
//
//   Standard v1        level 1, Described
//   Payment verified   level 2, Payable
//   Recovery verified  level 3, Recoverable
//   Load-safe          C7 passed
//   8004 validated     C2 passed, and the Validation Registry anchors this receipt; the caller confirms
//                      that on chain and says so with `validated`
//
// Each badge names the network, so testnet evidence never passes for mainnet, and its description
// carries the receipt's hash, which links it back to the evidence. The SVG is self-contained (no fonts,
// scripts or links), accessible (role="img" with a title), and the same receipt always gives the same bytes.

import type { VerificationReceipt } from "@stellar-agent-services/protocol";

export type BadgeId = "standard-v1" | "payment-verified" | "recovery-verified" | "load-safe" | "8004-validated";

export interface Badge {
  id: BadgeId;
  label: string;
  /** The network: "testnet" or "mainnet". */
  message: string;
  svg: string;
}

const LABELS: Readonly<Record<BadgeId, string>> = {
  "standard-v1": "Standard v1",
  "payment-verified": "Payment verified",
  "recovery-verified": "Recovery verified",
  "load-safe": "Load-safe",
  "8004-validated": "8004 validated",
};

const NETWORK_LABEL = { "stellar:testnet": "testnet", "stellar:pubnet": "mainnet" } as const;
const NETWORK_COLOR = { "stellar:testnet": "#007ec6", "stellar:pubnet": "#44cc11" } as const;

export interface BadgeOptions {
  /** sha256 of the receipt, which each badge's description names. */
  receiptSha256: string;
  /** The Validation Registry record for this receipt was confirmed on chain. */
  validated?: boolean;
}

/** The badges a receipt earns, in order. */
export function badgesFor(receipt: VerificationReceipt, options: BadgeOptions): Badge[] {
  const passed = (check: string) => receipt.results.some((result) => result.check === check && result.status === "passed");
  const earned: BadgeId[] = [];
  if (receipt.level >= 1) earned.push("standard-v1");
  if (receipt.level >= 2) earned.push("payment-verified");
  if (receipt.level >= 3) earned.push("recovery-verified");
  if (passed("C7")) earned.push("load-safe");
  if (passed("C2") && receipt.agentId !== undefined && options.validated === true) earned.push("8004-validated");

  const network = NETWORK_LABEL[receipt.network];
  return earned.map((id) => {
    const label = LABELS[id];
    const subject = id === "8004-validated" ? `agent ${receipt.agentId}` : "this provider";
    return {
      id,
      label,
      message: network,
      svg: renderBadge({
        id,
        label,
        message: network,
        color: NETWORK_COLOR[receipt.network],
        title: `${label}: Provider Standard v1, ${subject}, Stellar ${network}`,
        description: `Verification receipt sha256 ${options.receiptSha256}, checked ${receipt.checkedAt} by ${receipt.validator}`,
      }),
    };
  });
}

export interface BadgeDesign {
  /** Prefixes the SVG's element ids, so badges can share an HTML page. */
  id: string;
  label: string;
  message: string;
  color: string;
  title: string;
  description: string;
}

/** A flat, two-part badge in the shields.io layout. */
export function renderBadge(design: BadgeDesign): string {
  const labelWidth = Math.round(textWidth(design.label)) + 10;
  const messageWidth = Math.round(textWidth(design.message)) + 10;
  const width = labelWidth + messageWidth;
  // XML ids can't start with a digit, as "8004-validated" does.
  const key = `badge-${design.id}`;
  const label = escapeXml(design.label);
  const message = escapeXml(design.message);
  const text = (x: number, length: number, value: string) =>
    `<text x="${x * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${length * 10}">${value}</text>` +
    `<text x="${x * 10}" y="140" transform="scale(.1)" textLength="${length * 10}">${value}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}: ${message}">`,
    `<title>${escapeXml(design.title)}</title>`,
    `<desc>${escapeXml(design.description)}</desc>`,
    `<linearGradient id="${key}-s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="${key}-r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#${key}-r)"><rect width="${labelWidth}" height="20" fill="#555"/><rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${design.color}"/><rect width="${width}" height="20" fill="url(#${key}-s)"/></g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">`,
    text(labelWidth / 2, labelWidth - 10, label),
    text(labelWidth + messageWidth / 2, messageWidth - 10, message),
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

// Advance widths of Verdana at 11 px, which badges are drawn in. Characters not listed count as 7.
const WIDTHS: Readonly<Record<string, number>> = {
  " ": 3.9, "-": 4.6, ".": 3.9, ":": 4.6, "0": 7, "1": 7, "2": 7, "3": 7, "4": 7, "5": 7, "6": 7, "7": 7, "8": 7, "9": 7,
  a: 6.7, b: 6.9, c: 5.7, d: 6.9, e: 6.6, f: 3.9, g: 6.9, h: 7, i: 3, j: 3.8, k: 6.5, l: 3, m: 10.7, n: 7, o: 6.7, p: 6.9,
  q: 6.9, r: 4.7, s: 5.7, t: 4.3, u: 7, v: 6.5, w: 9, x: 6.5, y: 6.5, z: 5.8,
  A: 7.5, B: 7.6, C: 7.7, D: 8.5, E: 7, F: 6.3, G: 8.5, H: 8.3, I: 4.6, J: 5, K: 7.6, L: 6.1, M: 9.3, N: 8.3, O: 8.7,
  P: 6.6, Q: 8.7, R: 7.7, S: 7.5, T: 6.8, U: 8.1, V: 7.5, W: 10.9, X: 7.5, Y: 6.8, Z: 7.5,
};

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDTHS[char] ?? 7;
  return width;
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
