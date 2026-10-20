import { describe, expect, it } from "vitest";
import { checkChallenge, type ProviderManifest } from "../src/index.js";
import { applyPatch, loadVectors, ruleIds, type PatchOperation } from "./support/vectors.js";

interface ChallengeVectors {
  manifest: ProviderManifest;
  service: string;
  challenge: Record<string, unknown>;
  cases: { name: string; patch: PatchOperation[]; valid: boolean; violations: { rule: string; pointer: string }[] }[];
}

const vectors = loadVectors<ChallengeVectors>("challenges.json");

describe("checkChallenge: test-vectors/challenges.json", () => {
  it.each(vectors.cases)("$name", ({ patch, violations }) => {
    const challenge = applyPatch(vectors.challenge, patch);
    expect(ruleIds(checkChallenge(vectors.manifest, vectors.service, challenge))).toEqual(ruleIds(violations));
  });
});

describe("checkChallenge", () => {
  it("rejects a challenge that is not an object", () => {
    for (const challenge of [null, "402", [vectors.challenge]]) {
      expect(ruleIds(checkChallenge(vectors.manifest, vectors.service, challenge))).toEqual([{ rule: "P3", pointer: "" }]);
    }
  });

  it("throws for a service that is not in the manifest", () => {
    expect(() => checkChallenge(vectors.manifest, "summarize", vectors.challenge)).toThrow(TypeError);
  });
});
