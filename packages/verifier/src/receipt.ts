// The verification receipt (docs/verification.md): issued from a report, and published as RFC 8785
// canonical JSON. The file holds exactly those bytes and is named by their SHA-256, which is also the
// Validation Registry's response_hash: anyone can fetch the response_uri, hash what it serves, and
// compare it with the chain.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  conformanceLevel,
  PROVIDER_STANDARD,
  sha256Hex,
  stellarAddressKind,
  type StellarNetwork,
  type VerificationReceipt,
} from "@stellar-agent-services/protocol";
import { isObject } from "./json.js";
import { schemaErrors, validateReceiptSchema } from "./schemas.js";
import { TOOL } from "./tool.js";
import type { VerificationReport } from "./verify.js";

export interface IssueOptions {
  /** The verifier's G... account, which signs validation_response. */
  validator: string;
  /** The network, when the report has none because the manifest could not be read. */
  network?: StellarNetwork;
  /** The agent, when the report has none: the agent of the validation request being answered. */
  agentId?: number;
}

/** Receipts are evidence about public providers, so a development run gets none. */
export function issueReceipt(report: VerificationReport, options: IssueOptions): VerificationReceipt {
  if (report.dev || !report.manifestUrl.startsWith("https://")) throw new Error("receipts are issued only for providers served over HTTPS, never in development mode");
  if (stellarAddressKind(options.validator) !== "account") throw new TypeError("the validator must be a G... account address");
  const network = report.network ?? options.network;
  if (network === undefined) throw new TypeError("the manifest names no network, so the receipt needs one");
  const agentId = report.agentId ?? options.agentId;

  const receipt: VerificationReceipt = {
    standard: PROVIDER_STANDARD,
    ...(agentId === undefined ? {} : { agentId }),
    network,
    validator: options.validator,
    startedAt: report.startedAt,
    checkedAt: report.checkedAt,
    score: report.score,
    scoreDirection: "higher-is-better",
    level: report.level,
    manifest: { url: report.manifestUrl, ...(report.manifestSha256 === undefined ? {} : { sha256: report.manifestSha256 }) },
    results: report.results,
    ...(report.payment === undefined ? {} : { payment: report.payment }),
    tool: { name: TOOL.name, version: TOOL.version },
  };
  const problems = receiptProblems(receipt);
  if (problems.length > 0) throw new Error(`the receipt would not be valid: ${problems.join("; ")}`);
  return receipt;
}

/**
 * What is wrong with a document that claims to be a receipt: the JSON Schema, plus what it can't express,
 * the level the results reach. Empty when it is a valid receipt.
 */
export function receiptProblems(document: unknown): string[] {
  if (!validateReceiptSchema(document)) {
    return schemaErrors(validateReceiptSchema.errors).map((error) => `${error.pointer || "/"} ${error.message}`);
  }
  const receipt = document as VerificationReceipt;
  const level = conformanceLevel(receipt.results);
  return level === receipt.level ? [] : [`/level is ${receipt.level}, but the results reach level ${level}`];
}

/** The receipt's bytes: UTF-8 canonical JSON. */
export function receiptBytes(receipt: VerificationReceipt): Uint8Array {
  return new TextEncoder().encode(canonicalJson(receipt));
}

/** sha256 of the receipt's bytes: its file name, and the on-chain response_hash. */
export function receiptHash(receipt: VerificationReceipt): Promise<string> {
  return sha256Hex(receiptBytes(receipt));
}

/** Writes `<dir>/<sha256>.json`: exactly the receipt's bytes, with no trailing newline. */
export async function writeReceipt(receipt: VerificationReceipt, dir: string): Promise<{ path: string; sha256: string }> {
  const sha256 = await receiptHash(receipt);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sha256}.json`);
  await writeFile(path, receiptBytes(receipt));
  return { path, sha256 };
}

export class ReceiptError extends Error {
  override name = "ReceiptError";
}

/** Reads and checks a receipt file. Throws a ReceiptError when it is not a valid receipt. */
export async function readReceipt(path: string): Promise<{ receipt: VerificationReceipt; sha256: string }> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ReceiptError(`${path} can't be read as JSON: ${(error as Error).message}`);
  }
  const problems = isObject(document) ? receiptProblems(document) : ["it is not a JSON object"];
  if (problems.length > 0) throw new ReceiptError(`${path} is not a valid verification receipt: ${problems.slice(0, 5).join("; ")}`);
  const receipt = document as VerificationReceipt;
  return { receipt, sha256: await receiptHash(receipt) };
}
