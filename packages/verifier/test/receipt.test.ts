import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonicalJson, VALIDATION_TAG, type VerificationReceipt } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  anchorProblems,
  badgesFor,
  checkPublication,
  invokeArguments,
  issueReceipt,
  PublicationError,
  readReceipt,
  receiptHash,
  receiptProblems,
  renderBadge,
  writeReceipt,
  type ValidationRecord,
  type VerificationReport,
} from "../src/index.js";
import { AGENT_ID, fakeRegistry, MANIFEST_URL, setup, validator } from "./support/harness.js";

let level3: VerificationReport | undefined;
/** A full, passing report, made once. */
async function passingReport(): Promise<VerificationReport> {
  if (level3 === undefined) {
    const { verify, payer } = setup();
    level3 = await verify({ payer });
  }
  return structuredClone(level3);
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "verifier-test-"));
}

describe("verification receipts", () => {
  it("are issued from a report, valid against the receipt schema", async () => {
    const receipt = issueReceipt(await passingReport(), { validator });
    expect(receiptProblems(receipt)).toEqual([]);
    expect(receipt).toMatchObject({
      standard: "stellar-agent-services/provider@1",
      agentId: AGENT_ID,
      network: "stellar:testnet",
      validator,
      level: 3,
      score: 100,
      scoreDirection: "higher-is-better",
      manifest: { url: MANIFEST_URL },
      tool: { name: "@stellar-agent-services/verifier", version: "0.0.0" },
    });
    expect(receipt.payment?.transaction).toMatch(/^[0-9a-f]{64}$/);
  });

  it("are issued for failing providers too, and never for development runs", async () => {
    const { verify } = setup({ tamper: (_request, response) => new Response("nope", { status: 500, headers: response.headers }) });
    const failing = await verify();
    // An unreadable manifest names no network or agent: the validation request being answered does.
    expect(() => issueReceipt(failing, { validator })).toThrow(/needs one/);
    const receipt = issueReceipt(failing, { validator, network: "stellar:testnet", agentId: AGENT_ID });
    expect(receipt).toMatchObject({ level: 0, score: 0, agentId: AGENT_ID, manifest: { url: MANIFEST_URL } });
    expect(receipt.manifest.sha256).toBeUndefined();
    expect(receiptProblems(receipt)).toEqual([]);

    expect(() => issueReceipt({ ...failing, dev: true }, { validator })).toThrow(/development/);
    expect(() => issueReceipt(failing, { validator: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" })).toThrow(/G\.\.\. account/);
  });

  it("are written as their canonical bytes, named by their hash, which is the response_hash", async () => {
    const receipt = issueReceipt(await passingReport(), { validator });
    const { path, sha256 } = await writeReceipt(receipt, await tempDir());
    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).toBe(canonicalJson(receipt));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    expect(basename(path)).toBe(`${sha256}.json`);
    expect(await receiptHash(receipt)).toBe(sha256);
    expect(await readReceipt(path)).toEqual({ receipt, sha256 });
  });

  it("are refused when tampered with", async () => {
    const receipt = issueReceipt(await passingReport(), { validator });
    const dir = await tempDir();
    const cases: [string, (receipt: any) => void, RegExp][] = [
      ["a higher level than the results reach", (r) => ((r.results[3].status = "skipped"), (r.results[3].reason = "x")), /level is 3, but the results reach level 1/],
      ["a score that is not the level's", (r) => (r.score = 67), /score/],
      ["a result removed", (r) => r.results.pop(), /results/],
    ];
    for (const [name, change, problem] of cases) {
      const tampered = structuredClone(receipt);
      change(tampered);
      const path = join(dir, `${name}.json`);
      await writeFile(path, JSON.stringify(tampered));
      await expect(readReceipt(path), name).rejects.toThrow(problem);
    }
    await writeFile(join(dir, "broken.json"), "{");
    await expect(readReceipt(join(dir, "broken.json"))).rejects.toThrow(/can't be read as JSON/);
  });
});

describe("badges", () => {
  it("follow the receipt: one per level, Load-safe, and 8004 validated only once anchored", async () => {
    const receipt = issueReceipt(await passingReport(), { validator });
    const sha256 = await receiptHash(receipt);
    expect(badgesFor(receipt, { receiptSha256: sha256 }).map((badge) => badge.id)).toEqual(["standard-v1", "payment-verified", "recovery-verified", "load-safe"]);
    expect(badgesFor(receipt, { receiptSha256: sha256, validated: true }).map((badge) => badge.id)).toContain("8004-validated");

    const unregistered: VerificationReceipt = { ...receipt, results: receipt.results.map((result) => (result.check === "C2" ? { check: "C2", status: "skipped", failedRules: [], reason: "x" } : result)) };
    expect(badgesFor(unregistered, { receiptSha256: sha256, validated: true }).map((badge) => badge.id)).not.toContain("8004-validated");

    const failing: VerificationReceipt = { ...receipt, level: 0, score: 0, results: receipt.results.map((result) => ({ ...result, status: "failed", failedRules: ["M1"] })) };
    expect(badgesFor(failing, { receiptSha256: sha256 })).toEqual([]);
  });

  it("name the network and the receipt, and are accessible, self-contained SVG", async () => {
    const receipt = issueReceipt(await passingReport(), { validator });
    const sha256 = await receiptHash(receipt);
    const [badge] = badgesFor(receipt, { receiptSha256: sha256 });
    expect(badge).toMatchObject({ id: "standard-v1", label: "Standard v1", message: "testnet" });
    expect(badge!.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20" role="img" aria-label="Standard v1: testnet">/);
    expect(badge!.svg).toContain(`<desc>Verification receipt sha256 ${sha256}`);
    expect(badge!.svg).not.toMatch(/<script|<image|href=|@import/);
    expect(badgesFor({ ...receipt, network: "stellar:pubnet" }, { receiptSha256: sha256 })[0]?.message).toBe("mainnet");
    // The same receipt, the same bytes.
    expect(badgesFor(receipt, { receiptSha256: sha256 })).toEqual(badgesFor(receipt, { receiptSha256: sha256 }));
  });

  it("escape their text, and use ids that are valid XML names", () => {
    const svg = renderBadge({ id: "8004-validated", label: `<b>&"'`, message: "x", color: "#000", title: "t", description: "d" });
    expect(svg).toContain("&lt;b&gt;&amp;&quot;&apos;");
    expect([...svg.matchAll(/id="([^"]+)"/g)].map((match) => match[1])).toEqual(["badge-8004-validated-s", "badge-8004-validated-r"]);
  });
});

describe("publishing to the Validation Registry", () => {
  const requestHash = "ab".repeat(32);
  const responseUri = "https://evidence.test/receipts/receipt.json";

  async function world(record: Partial<ValidationRecord> | undefined, served?: (receipt: VerificationReceipt) => BodyInit) {
    const receipt = issueReceipt(await passingReport(), { validator });
    const { registry, validations, state } = fakeRegistry();
    if (record !== undefined) validations.set(requestHash, { validator, agentId: AGENT_ID, hasResponse: false, response: 0, responseHash: "0".repeat(64), tag: "", lastUpdate: 1, ...record });
    const body = served === undefined ? canonicalJson(receipt) : served(receipt);
    const fetch = (async (url: string) => (url === responseUri ? new Response(body) : new Response("missing", { status: 404 }))) as unknown as typeof globalThis.fetch;
    const options = { requestHash, responseUri, registry, fetch };
    return { receipt, registry, validations, state, options };
  }

  it("prepares validation_response once everything checks out", async () => {
    const { receipt, options } = await world({});
    const publication = await checkPublication(receipt, options);
    expect(publication).toEqual({
      network: "stellar:testnet",
      contractId: options.registry.contracts.validation,
      validator,
      agentId: AGENT_ID,
      requestHash,
      response: 100,
      responseUri,
      responseHash: await receiptHash(receipt),
      tag: VALIDATION_TAG,
      updates: false,
    });
    expect(invokeArguments(publication, { source: "verifier", network: "testnet" })).toEqual([
      "contract", "invoke", "--id", options.registry.contracts.validation, "--source-account", "verifier", "--network", "testnet", "--",
      "validation_response", "--caller", validator, "--request_hash", requestHash, "--response", "100",
      "--response_uri", responseUri, "--response_hash", publication.responseHash, "--tag", VALIDATION_TAG,
    ]);
    expect((await checkPublication(receipt, { ...options, requestHash: `0x${requestHash.toUpperCase()}` })).requestHash).toBe(requestHash);
  });

  it.each<[string, Partial<ValidationRecord> | undefined, ((receipt: VerificationReceipt) => BodyInit) | undefined, Record<string, unknown>, RegExp]>([
    ["no such request", undefined, undefined, {}, /no validation request/],
    ["a request for another validator", { validator: Keypair.random().publicKey() }, undefined, {}, /names validator/],
    ["a request for another agent", { agentId: 99 }, undefined, {}, /for agent 99/],
    ["a response URI that serves other bytes", {}, (receipt) => JSON.stringify(receipt, null, 2), {}, /other bytes than the receipt/],
    ["a response URI that is not served yet", {}, undefined, { responseUri: "https://evidence.test/other.json" }, /answered 404/],
    ["a response URI over plain HTTP", {}, undefined, { responseUri: "http://evidence.test/receipt.json" }, /https/],
    ["a request hash that is not one", {}, undefined, { requestHash: "1234" }, /64 hex/],
    ["a stale receipt", {}, undefined, { now: () => Date.now() + 2 * 24 * 3600_000 }, /verify the provider again/],
  ])("refuses %s", async (_name, record, served, overrides, problem) => {
    const { receipt, options } = await world(record, served);
    const error = await checkPublication(receipt, { ...options, ...overrides }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublicationError);
    expect((error as PublicationError).message).toMatch(problem);
  });

  it("refuses when the registry can't be read, and says when it replaces a response", async () => {
    const down = await world({});
    down.state.down = true;
    await expect(checkPublication(down.receipt, down.options)).rejects.toThrow(/could not be read/);
    const answered = await world({ hasResponse: true, response: 33 });
    expect((await checkPublication(answered.receipt, answered.options)).updates).toBe(true);
  });

  it("knows when a record anchors a receipt", async () => {
    const receipt = issueReceipt(await passingReport(), { validator });
    const sha256 = await receiptHash(receipt);
    const anchored: ValidationRecord = { validator, agentId: AGENT_ID, hasResponse: true, response: 100, responseHash: sha256, tag: VALIDATION_TAG, lastUpdate: 9 };
    expect(anchorProblems(anchored, receipt, sha256)).toEqual([]);
    expect(anchorProblems(undefined, receipt, sha256)).toEqual(["there is no validation request with that hash"]);
    expect(anchorProblems({ ...anchored, hasResponse: false }, receipt, sha256)).toContain("the request has no response yet");
    expect(anchorProblems({ ...anchored, responseHash: "0".repeat(64) }, receipt, sha256)).toContain("the response anchors another receipt");
    expect(anchorProblems({ ...anchored, tag: "erc8126" }, receipt, sha256).join()).toMatch(/tag/);
    expect(anchorProblems({ ...anchored, response: 67 }, receipt, sha256).join()).toMatch(/not the receipt's score/);
  });
});
