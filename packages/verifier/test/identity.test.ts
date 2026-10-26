import { registrationDataUri, registrationFile } from "@stellar-agent-services/provider-kit";
import type { CheckResult } from "@stellar-agent-services/protocol";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../src/index.js";
import { AGENT_ID, MANIFEST_URL, ORIGIN, payTo, setup } from "./support/harness.js";

// C2: the 8004 registration authenticates the manifest [I1]–[I3]. The registry and registration file are fakes.

const identity = (report: VerificationReport) => report.results.find((result) => result.check === "C2") as CheckResult;

function registrationWith(change: (file: any) => void): string {
  const { provider } = setup();
  const file = registrationFile(provider.manifest, provider.manifestUrl) as any;
  change(file);
  return registrationDataUri(file);
}

describe("C2 identity", () => {
  it("passes when the registration lists the manifest and the wallet is payTo", async () => {
    const { verify } = setup();
    const result = identity(await verify());
    expect(result).toMatchObject({ status: "passed", failedRules: [], evidence: { agentId: AGENT_ID, wallet: payTo, agentUri: "data:" } });
    expect(result.warnings).toBeUndefined();
  });

  it("is skipped for a provider that claims no agent", async () => {
    const { verify } = setup({ provider: { provider: { name: "Unregistered" } } });
    expect(identity(await verify())).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no provider.agentId/) });
  });

  it("fails an agent the registry doesn't know [I2]", async () => {
    const { verify, agents } = setup();
    delete agents[AGENT_ID];
    expect(identity(await verify())).toMatchObject({ status: "failed", failedRules: ["I2"] });
  });

  it.each<[string, (file: any) => void]>([
    ["another manifest", (file) => (file.services[0].endpoint = `${ORIGIN}/other.json`)],
    ["the manifest under another name", (file) => (file.services[0].name = "manifest")],
    ["the manifest without version 1", (file) => delete file.services[0].version],
  ])("fails a registration that lists %s [I1]", async (_name, change) => {
    const { verify, agents } = setup();
    agents[AGENT_ID]!.uri = registrationWith(change);
    expect(identity(await verify())).toMatchObject({ status: "failed", failedRules: ["I1"] });
  });

  it("warns when the registration lacks the web endpoint or the x402 flag [I1]", async () => {
    const { verify, agents } = setup();
    agents[AGENT_ID]!.uri = registrationWith((file) => {
      file.services = file.services.filter((service: any) => service.name !== "web");
      delete file.x402;
    });
    expect(identity(await verify())).toMatchObject({ status: "passed", warnings: ["I1"] });
  });

  it("fails an agent whose wallet is not payTo [I3]", async () => {
    const { verify, agents } = setup();
    agents[AGENT_ID]!.wallet = Keypair.random().publicKey();
    expect(identity(await verify())).toMatchObject({ status: "failed", failedRules: ["I3"] });
    delete agents[AGENT_ID]!.wallet;
    expect(identity(await verify()).findings?.[0]?.message).toMatch(/wallet is not set/);
  });

  it("reads a registration served over HTTPS, and refuses one over plain HTTP", async () => {
    const { provider } = setup();
    const file = JSON.stringify(registrationFile(provider.manifest, MANIFEST_URL));
    const { verify, agents } = setup({
      tamper: (request, response) => (request.url === "https://registry.test/agent.json" ? new Response(file, { headers: { "Content-Type": "application/json" } }) : response),
    });
    agents[AGENT_ID]!.uri = "https://registry.test/agent.json";
    expect(identity(await verify())).toMatchObject({ status: "passed", evidence: { agentUri: "https://registry.test/agent.json" } });
    agents[AGENT_ID]!.uri = "http://registry.test/agent.json";
    expect(identity(await verify())).toMatchObject({ status: "failed", failedRules: ["I1"] });
  });

  it("is inconclusive, not failed, when the registry or an IPFS file can't be read", async () => {
    const { verify, registryState, agents } = setup();
    registryState.down = true;
    expect(identity(await verify())).toMatchObject({ status: "skipped", reason: expect.stringMatching(/registry could not be read/) });
    registryState.down = false;
    agents[AGENT_ID]!.uri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(identity(await verify())).toMatchObject({ status: "skipped", reason: expect.stringMatching(/IPFS/) });
  });
});
