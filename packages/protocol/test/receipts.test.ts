import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  CONFORMANCE_LEVELS,
  CONFORMANCE_SCORES,
  conformanceLevel,
  PROVIDER_STANDARD,
  RULE_REFERENCE_PATTERN,
  USDC_ASSET,
  VERIFICATION_RECEIPT_SCHEMA_ID,
  type CheckId,
  type CheckResult,
  type VerificationReceipt,
} from "../src/index.js";

const ALL_CHECKS: CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];

function results(passed: CheckId[]): CheckResult[] {
  return ALL_CHECKS.map((check) => ({
    check,
    status: passed.includes(check) ? "passed" : "failed",
    failedRules: [],
  }));
}

describe("conformanceLevel", () => {
  it.each([
    { passed: [], level: 0 },
    { passed: ["C1"], level: 0 },
    { passed: ["C1", "C6"], level: 1 },
    { passed: ["C1", "C6", "C3"], level: 1 },
    { passed: ["C1", "C6", "C3", "C4"], level: 2 },
    { passed: ["C1", "C6", "C3", "C4", "C5"], level: 3 },
    { passed: ["C3", "C4", "C5"], level: 0 },
    { passed: ["C1", "C6", "C5"], level: 1 },
  ] as { passed: CheckId[]; level: number }[])("$passed -> level $level", ({ passed, level }) => {
    expect(conformanceLevel(results(passed))).toBe(level);
  });

  it("ignores C2 and C7, which only decide Registered and Load-safe", () => {
    expect(conformanceLevel(results(["C1", "C6", "C3", "C4", "C5", "C2", "C7"]))).toBe(3);
    expect(conformanceLevel(results(["C2", "C7"]))).toBe(0);
  });

  it("does not count skipped checks as passed", () => {
    const skipped = results(["C1", "C6", "C3"]).map((result) =>
      result.check === "C4" ? { ...result, status: "skipped" as const } : result,
    );
    expect(conformanceLevel(skipped)).toBe(1);
  });
});

describe("conformance levels", () => {
  it("each include the checks of the level below", () => {
    for (let i = 1; i < CONFORMANCE_LEVELS.length; i++) {
      expect(CONFORMANCE_LEVELS[i]?.checks).toEqual(expect.arrayContaining([...(CONFORMANCE_LEVELS[i - 1]?.checks ?? [])]));
    }
  });

  it("score 0 to 100, higher is better", () => {
    expect(Object.values(CONFORMANCE_SCORES)).toEqual([0, 33, 67, 100]);
  });
});

describe("verification receipt JSON Schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/verification-receipt.schema.json", import.meta.url), "utf8"));
  // Every Ajv strict check except strictRequired, as for the manifest schema.
  const validate = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, validateFormats: false }).compile(schema);

  const receipt = (): VerificationReceipt => ({
    standard: PROVIDER_STANDARD,
    agentId: 42,
    network: "stellar:testnet",
    validator: "GBZSBASBFMV5RGKPRIPCB5QQVAJ35IXKMTF2A2766MOA4ZHQ7MLSIPXU",
    startedAt: "2026-10-26T10:00:00.000Z",
    checkedAt: "2026-10-26T10:01:30.000Z",
    score: 100,
    scoreDirection: "higher-is-better",
    level: 3,
    manifest: { url: "https://api.example.com/.well-known/stellar-agent-services.json", sha256: "a".repeat(64) },
    results: ALL_CHECKS.map((check) =>
      check === "C2"
        ? { check, status: "skipped", failedRules: [], reason: "the manifest has no provider.agentId" }
        : { check, status: "passed", failedRules: [], ...(check === "C3" ? { warnings: ["P6"], findings: [{ rule: "P6", severity: "warn" as const, message: "no Bazaar extension" }] } : {}) },
    ),
    payment: {
      network: "stellar:testnet",
      asset: USDC_ASSET["stellar:testnet"],
      amount: "100000",
      payTo: "GBZSBASBFMV5RGKPRIPCB5QQVAJ35IXKMTF2A2766MOA4ZHQ7MLSIPXU",
      payer: "GBH3JLK366N4L5XCLJRCYLE6K6K3PUWBBEOLNBJMLORSKUNR5WY2IRKZ",
      transaction: "3b1f".padEnd(64, "0"),
      settledAt: "2026-10-26T10:00:02Z",
    },
    tool: { name: "@stellar-agent-services/verifier", version: "0.0.0" },
  });

  it("uses the same constants as the code", () => {
    expect(schema.$id).toBe(VERIFICATION_RECEIPT_SCHEMA_ID);
    expect(schema.properties.standard.const).toBe(PROVIDER_STANDARD);
    expect(schema.properties.score.enum).toEqual(Object.values(CONFORMANCE_SCORES));
    expect(schema.$defs.checkResult.properties.check.enum).toEqual(CHECK_IDS);
    expect(schema.$defs.rule.pattern).toBe(RULE_REFERENCE_PATTERN.source);
    expect(schema.properties.results.prefixItems.map((item: any) => item.properties.check.const)).toEqual(CHECK_IDS);
  });

  it("accepts a receipt", () => {
    expect(validate(receipt())).toBe(true);
    const { agentId: _agentId, payment: _payment, tool: _tool, ...minimal } = receipt();
    expect(validate({ ...minimal, manifest: { url: minimal.manifest.url } })).toBe(true);
  });

  it.each<[string, (receipt: any) => void]>([
    ["a score that is not the level's", (r) => (r.score = 67)],
    ["a missing check", (r) => r.results.pop()],
    ["checks out of order", (r) => r.results.reverse()],
    ["a failed check without a rule", (r) => (r.results[0] = { check: "C1", status: "failed", failedRules: [] })],
    ["a passed check with a failed rule", (r) => (r.results[0].failedRules = ["M1"])],
    ["a skipped check without a reason", (r) => (r.results[3] = { check: "C4", status: "skipped", failedRules: [] })],
    ["a rule that is neither an id nor a section", (r) => (r.results[0] = { check: "C1", status: "failed", failedRules: ["manifest"] })],
    ["a validator that is not an account", (r) => (r.validator = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")],
    ["a timestamp that is not RFC 3339", (r) => (r.checkedAt = "26.10.2026 10:00")],
    ["a manifest hash that is not SHA-256", (r) => (r.manifest.sha256 = "abc")],
    ["a payment transaction that is not a hash", (r) => (r.payment.transaction = "0x1234")],
    ["another standard", (r) => (r.standard = "stellar-agent-services/provider@2")],
  ])("rejects %s", (_name, change) => {
    const invalid = receipt();
    change(invalid);
    expect(validate(invalid)).toBe(false);
  });

  it("allows rule ids and spec sections", () => {
    for (const rule of ["M1", "J17", "Q9", "§5.5", "§10"]) expect(RULE_REFERENCE_PATTERN.test(rule)).toBe(true);
    for (const rule of ["m1", "M", "§", "§5.5.1", "P100", "S 4"]) expect(RULE_REFERENCE_PATTERN.test(rule)).toBe(false);
  });
});
