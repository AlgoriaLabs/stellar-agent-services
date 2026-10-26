import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VALIDATION_TAG } from "@stellar-agent-services/protocol";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import type { Io } from "../src/cli/shared.js";
import { AGENT_ID, MANIFEST_URL, setup, validator } from "./support/harness.js";

// The CLI over the offline world: the same commands an operator runs, with the network replaced.

function cli(world: ReturnType<typeof setup>, extra: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line), env: {}, fetch: world.fetch, chain: world.chain.chain, registry: world.registry, ...extra };
  return { io, out, err, run: (...argv: string[]) => main(argv, io) };
}

describe("verifier CLI: usage", () => {
  it("prints the usage", async () => {
    const { run, out } = cli(setup());
    expect(await run("--help")).toBe(0);
    expect(out.join("\n")).toMatch(/^verifier: check a provider against Provider Standard v1/);
    expect(await run()).toBe(2);
  });

  it.each<[string[], RegExp]>([
    [["inspect", MANIFEST_URL], /unknown command "inspect"/],
    [["check"], /check needs <manifest-url>/],
    [["check", MANIFEST_URL, "--pay"], /--pay belongs to verify/],
    [["check", MANIFEST_URL, "extra"], /unexpected argument "extra"/],
    [["verify", MANIFEST_URL, "--input", "{}"], /--input needs --service/],
    [["verify", MANIFEST_URL, "--service", "x", "--input", "[1]"], /must be a JSON object/],
    [["verify", MANIFEST_URL, "--max-price", "lots"], /--max-price must be a USDC amount/],
    [["verify", MANIFEST_URL, "--validator", validator], /--validator and --out go together/],
    [["verify", MANIFEST_URL, "--validator", "GABC", "--out", "x"], /G\.\.\. account address/],
    [["verify", MANIFEST_URL, "--pay"], /VERIFIER_PAYER_SECRET/],
    [["verify", MANIFEST_URL, "--service", "missing"], /no service "missing"/],
    [["publish", "receipt.json", "--source", "v"], /needs --request-hash, --response-uri and --source/],
    [["check", MANIFEST_URL, "--no-such-flag"], /Unknown option/],
  ])("refuses %j with exit code 2", async (argv, message) => {
    const { run, err } = cli(setup());
    expect(await run(...argv)).toBe(2);
    expect(err.join("\n")).toMatch(message);
  });

  it("refuses a payer key that is not a secret key", async () => {
    const { run, err } = cli(setup(), { env: { VERIFIER_PAYER_SECRET: "GABC" } });
    expect(await run("verify", MANIFEST_URL, "--pay")).toBe(2);
    expect(err.join("\n")).toMatch(/not a Stellar secret key/);
  });
});

describe("verifier CLI: check and verify", () => {
  it("checks a provider, printing each check, and exits 0", async () => {
    const { run, out } = cli(setup());
    expect(await run("check", MANIFEST_URL)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`Provider Standard v1 check: ${MANIFEST_URL}`);
    expect(text).toMatch(/✓ C1 Manifest/);
    expect(text).toMatch(/- C4 Paid call: skipped, no test payer/);
    expect(text).toContain("Level 1 (Described): score 33 of 100.");
    expect(text).toContain("Load (C7) passed: Load-safe.");
  });

  it("prints JSON alone on standard output with --json", async () => {
    const { run, out, err } = cli(setup());
    expect(await run("check", MANIFEST_URL, "--json")).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ manifestUrl: MANIFEST_URL, level: 1, results: expect.any(Array) });
    expect(err.join("\n")).toContain("Level 1");
  });

  it("exits 1 when a check fails, naming the rule", async () => {
    const world = setup({ tamper: (request, response) => (request.url === MANIFEST_URL ? new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) : response) });
    const { run, out } = cli(world);
    expect(await run("check", MANIFEST_URL)).toBe(1);
    expect(out.join("\n")).toMatch(/✗ \[M9\] \/ is required|✗ \[M9\] \/standard is required/);
  });

  it("verifies with the test payer and writes the receipt, named by its hash", async () => {
    const world = setup();
    const dir = await mkdtemp(join(tmpdir(), "verifier-cli-"));
    const { run, out } = cli(world, { payer: world.payer });
    expect(await run("verify", MANIFEST_URL, "--pay", "--validator", validator, "--out", dir)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Level 3 (Recoverable): score 100 of 100.");
    expect(text).toContain("The test payer signed for 0.06 USDC.");
    const [file] = await readdir(dir);
    expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(JSON.parse(await readFile(join(dir, file!), "utf8"))).toMatchObject({ validator, level: 3, agentId: AGENT_ID });
  });
});

describe("verifier CLI: badge and publish", () => {
  async function receiptFile() {
    const world = setup();
    const dir = await mkdtemp(join(tmpdir(), "verifier-cli-"));
    expect(await cli(world, { payer: world.payer }).run("verify", MANIFEST_URL, "--pay", "--validator", validator, "--out", dir)).toBe(0);
    const [file] = await readdir(dir);
    return { world, dir, path: join(dir, file!), sha256: file!.replace(".json", "") };
  }

  it("writes the badges a receipt earns, and 8004 validated once anchored", async () => {
    const { world, dir, path, sha256 } = await receiptFile();
    const { run, err } = cli(world);
    expect(await run("badge", path)).toBe(0);
    expect((await readdir(dir)).filter((name) => name.endsWith(".svg")).sort()).toEqual(
      ["load-safe", "payment-verified", "recovery-verified", "standard-v1"].map((id) => `${sha256}.${id}.svg`),
    );

    const requestHash = "cd".repeat(32);
    expect(await run("badge", path, "--request-hash", requestHash)).toBe(1);
    expect(err.join("\n")).toMatch(/not earned: there is no validation request/);
    world.validations.set(requestHash, { validator, agentId: AGENT_ID, hasResponse: true, response: 100, responseHash: sha256, tag: VALIDATION_TAG, lastUpdate: 1 });
    expect(await run("badge", path, "--request-hash", requestHash)).toBe(0);
    expect(await readdir(dir)).toContain(`${sha256}.8004-validated.svg`);
  });

  it("publishes through the Stellar CLI, after checking everything, and confirms on chain", async () => {
    const { world, path, sha256 } = await receiptFile();
    const requestHash = "ef".repeat(32);
    const responseUri = "https://evidence.test/receipts/r.json";
    world.validations.set(requestHash, { validator, agentId: AGENT_ID, hasResponse: false, response: 0, responseHash: "0".repeat(64), tag: "", lastUpdate: 1 });
    const served = await readFile(path);
    const fetch = (async (url: string) => (url === responseUri ? new Response(served) : new Response("", { status: 404 }))) as unknown as typeof globalThis.fetch;
    const calls: string[][] = [];
    const stellar = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "keys") return `${validator}\n`;
      // The registry records what validation_response sent.
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      world.validations.set(value("--request_hash"), { validator, agentId: AGENT_ID, hasResponse: true, response: Number(value("--response")), responseHash: value("--response_hash"), tag: value("--tag"), lastUpdate: 2 });
      return "";
    };
    const { run, out } = cli(world, { fetch, stellar });
    const argv = ["publish", path, "--request-hash", requestHash, "--response-uri", responseUri, "--source", "verifier"];

    expect(await run(...argv, "--dry-run")).toBe(0);
    expect(out.join("\n")).toContain("Dry run. This would run:");
    expect(calls.map((call) => call[0])).toEqual(["keys"]);

    expect(await run(...argv)).toBe(0);
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["validation_response", "--response_hash", sha256, "--tag", VALIDATION_TAG]));
    expect(out.join("\n")).toContain("Published.");
  });

  it("refuses to publish with a key that is not the receipt's validator", async () => {
    const { world, path } = await receiptFile();
    const requestHash = "ab".repeat(32);
    const responseUri = "https://evidence.test/receipts/r.json";
    world.validations.set(requestHash, { validator, agentId: AGENT_ID, hasResponse: false, response: 0, responseHash: "0".repeat(64), tag: "", lastUpdate: 1 });
    const served = await readFile(path);
    const fetch = (async () => new Response(served)) as unknown as typeof globalThis.fetch;
    const stellar = async () => "GBZSBASBFMV5RGKPRIPCB5QQVAJ35IXKMTF2A2766MOA4ZHQ7MLSIPXU\n";
    const { run, err } = cli(world, { fetch, stellar });
    expect(await run("publish", path, "--request-hash", requestHash, "--response-uri", responseUri, "--source", "other")).toBe(1);
    expect(err.join("\n")).toMatch(/but the receipt's validator is/);
  });
});
