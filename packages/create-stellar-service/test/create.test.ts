// npm create stellar-service: the questions and flags, the files each kind writes, and how it uses the kit, with
// npm, provider-kit and the terminal replaced. Nothing here touches the network.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider, loadGatewayConfig } from "@stellar-agent-services/provider-kit";
import { Keypair } from "@stellar/stellar-sdk";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { adaptInitConfig, envFile, packageJson, pythonGatewayConfig, SUMMARIZE, TEMPLATE_FILES, template, type Kind, type Project } from "../src/files.js";
import { KIT_CLI, kitDependencies, OVERRIDES, type KitSource } from "../src/kit.js";
import { Cancelled, classify, create, packageName, titleCase, UsageError, type CreateIo, type RunResult } from "../src/main.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = join(REPO, "packages/provider-kit/test/fixtures/openapi/fastapi-openapi.json");
const PAY_TO = Keypair.random().publicKey();
const scratch = mkdtempSync(join(tmpdir(), "create-stellar-service-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let folders = 0;
const folder = () => join(scratch, `project-${++folders}`);

/** A clone whose kit packages look built, without building anything. */
function fakeClone(): KitSource {
  const packages = join(scratch, `clone-${++folders}`, "packages");
  for (const file of ["protocol/dist/index.js", "payment-client/dist/index.js", "provider-kit/dist/index.js", "provider-kit/dist/approve/index.html"]) {
    mkdirSync(join(packages, file, ".."), { recursive: true });
    writeFileSync(join(packages, file), "");
  }
  for (const name of ["protocol", "payment-client", "provider-kit"]) writeFileSync(join(packages, name, "package.json"), "{}");
  return { from: "clone", packages };
}

/** An init config as provider-kit init writes one from the fixture: dev mode, a literal baseUrl and store. */
const INIT_CONFIG = {
  $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
  baseUrl: "http://localhost:8787",
  dev: true,
  network: "stellar:testnet",
  payTo: "env:PAY_TO",
  facilitator: "https://x402.org/facilitator",
  provider: { name: "Text Tools API", description: "Summaries, translations and labels for English text." },
  store: "./jobs.sqlite",
  services: [
    { name: "summarize", description: "Summarizes.", price: "0.01", inputSchema: { type: "object" }, outputSchema: { type: "object" }, upstream: { url: "http://127.0.0.1:8000/summarize" } },
    {
      name: "translate",
      description: "Translates.",
      price: "0.01",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      upstream: { url: "http://127.0.0.1:8000/v1/translate", headers: { "X-API-Key": "env:UPSTREAM_X_API_KEY" } },
    },
  ],
};

interface Fake {
  io: CreateIo;
  output: string[];
  runs: { command: string; args: string[]; cwd: string }[];
  questions: string[];
}

/** An io with scripted answers and programs: npm pack and install succeed, init writes INIT_CONFIG, trustline prints PAY_TO. */
function fakeIo(options: { answers?: string[]; interactive?: boolean; kit?: KitSource; programs?: Partial<Record<string, (args: string[], cwd: string) => RunResult>>; fetch?: typeof fetch } = {}): Fake {
  const output: string[] = [];
  const runs: Fake["runs"] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const programs: Record<string, (args: string[], cwd: string) => RunResult> = {
    "npm pack": (_args, cwd) => ({ code: 0, output: `npm notice\n[{"filename":"stellar-agent-services-${cwd.split("/").at(-1)}-0.0.0.tgz"}]` }),
    "npm install": () => ({ code: 0, output: "added 56 packages" }),
    init: (args, cwd) => {
      writeFileSync(join(cwd, args.at(-1)!), JSON.stringify(INIT_CONFIG, null, 2));
      return { code: 0, output: "Read Text Tools API 1.4.0 (OpenAPI 3.1.0) from it\n\nWrote provider.config.json with 2 services:\n\nNext:\n  1. Review provider.config.json\n" };
    },
    trustline: () => ({ code: 0, output: `GABC can now receive USDC on stellar:testnet.\nUse it as your payout address: PAY_TO=${PAY_TO}\n` }),
    ...options.programs,
  };
  const io: CreateIo = {
    log: (text = "") => void output.push(text),
    status: () => {},
    interactive: options.interactive ?? false,
    ask: async (question) => {
      questions.push(question);
      const next = answers.shift();
      if (next === undefined) throw new Cancelled("cancelled");
      return next;
    },
    run: async (command, args, { cwd }) => {
      runs.push({ command, args, cwd });
      const key = command === "npm" ? `npm ${args[0]}` : args[1]!;
      const program = programs[key];
      if (program === undefined) throw new Error(`unexpected program: ${command} ${args.join(" ")}`);
      return program(args, cwd);
    },
    fetch: options.fetch ?? (async () => new Response("{}")),
    kit: options.kit ?? fakeClone(),
  };
  return { io, output, runs, questions };
}

const read = (directory: string, file: string) => readFileSync(join(directory, file), "utf8");
const env = (directory: string) => Object.fromEntries(read(directory, ".env").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split("=") as [string, string]));

describe("create-stellar-service, from flags", () => {
  it("makes a TypeScript project: the kit packed into vendor/, installed, and the account given in .env", async () => {
    const directory = folder();
    const fake = fakeIo();
    expect(await create([directory, "--kind", "typescript", "--description", "Summaries for agents.", "--pay-to", PAY_TO], fake.io)).toBe(0);

    const packs = fake.runs.filter((run) => run.args[0] === "pack");
    expect(packs.map((run) => run.cwd.split("/").at(-1))).toEqual(["protocol", "payment-client", "provider-kit"]);
    expect(packs.every((run) => run.args.includes(join(directory, "vendor")))).toBe(true);
    expect(fake.runs.find((run) => run.args[0] === "install")?.cwd).toBe(directory);

    const pkg = JSON.parse(read(directory, "package.json"));
    expect(pkg.dependencies["@stellar-agent-services/provider-kit"]).toBe("file:vendor/stellar-agent-services-provider-kit-0.0.0.tgz");
    expect(pkg.overrides).toEqual(OVERRIDES);
    for (const [, file] of TEMPLATE_FILES.typescript) expect(existsSync(join(directory, file))).toBe(true);
    expect(read(directory, "src/server.ts")).toContain(`description: "Summaries for agents."`);
    expect(read(directory, "Dockerfile")).toContain("COPY vendor ./vendor");
    expect(env(directory)).toMatchObject({ PAY_TO, PUBLIC_ORIGIN: "http://localhost:8787", JOB_DB_PATH: "./jobs.sqlite" });
    expect(read(directory, ".env.example")).toContain("PAY_TO=\n");
    expect(read(directory, ".gitignore")).toContain(".env");
    expect(read(directory, "README.md")).toContain("vendor/");
    expect(fake.output.join("\n")).toContain("npm run dev        starts the service at http://localhost:8787");
    expect(fake.output.join("\n")).not.toContain("npm run wallet");
  });

  it("wraps an API from its OpenAPI document: init's config made to run anywhere, and the API key it reads left to .env", async () => {
    const directory = folder();
    const fake = fakeIo();
    expect(await create([directory, "--kind", "wrap", "--openapi", FIXTURE, "--upstream", "http://127.0.0.1:8000"], fake.io)).toBe(0);

    const init = fake.runs.find((run) => run.args[1] === "init")!;
    expect(init).toMatchObject({ command: process.execPath, cwd: directory });
    expect(init.args).toEqual([KIT_CLI, "init", "--openapi", FIXTURE, "--upstream", "http://127.0.0.1:8000", "--out", "provider.config.json"]);
    const config = JSON.parse(read(directory, "provider.config.json"));
    expect(config).toMatchObject({ baseUrl: "env:PUBLIC_ORIGIN", store: "env:JOB_DB_PATH", provider: { name: "Text Tools API" } });
    expect(config).not.toHaveProperty("dev");
    expect(env(directory)).toMatchObject({ PAY_TO: "", UPSTREAM_X_API_KEY: "" });

    const text = fake.output.join("\n");
    expect(text).toContain("    Wrote provider.config.json with 2 services:");
    expect(text.match(/^Next:$/gm)).toHaveLength(1);
    expect(text).not.toContain("Review provider.config.json");
    expect(text).toContain("set UPSTREAM_X_API_KEY in .env   the gateway sends it to your API");
    expect(text).toContain("npm run wallet     sets up the account clients pay");
    expect(read(directory, "README.md")).toContain("The gateway calls it at http://127.0.0.1:8000.");
    expect(JSON.parse(read(directory, "package.json")).scripts.dev).toBe(`node --env-file-if-exists=.env ${KIT_CLI} serve --config provider.config.json --dev`);
  });

  it("writes a starter for one URL, named after the folder", async () => {
    const directory = join(scratch, "image-captioner");
    const fake = fakeIo({
      programs: {
        init: (args, cwd) => {
          writeFileSync(join(cwd, "provider.config.json"), JSON.stringify({ ...INIT_CONFIG, provider: { name: "My provider", description: "What you offer, in a sentence or two." } }));
          return { code: 0, output: `Wrote provider.config.json. Next:\n  1. Edit the service (${args.join(" ")})` };
        },
      },
    });
    expect(await create([directory, "--kind", "wrap", "--upstream", "http://127.0.0.1:5000/caption"], fake.io)).toBe(0);
    expect(fake.runs.find((run) => run.args[1] === "init")!.args).toEqual([KIT_CLI, "init", "--upstream", "http://127.0.0.1:5000/caption", "--out", "provider.config.json"]);
    expect(JSON.parse(read(directory, "provider.config.json")).provider.name).toBe("Image Captioner");
    expect(fake.output.join("\n")).toContain("  ✓ provider.config.json: a service to edit, my-service, which calls http://127.0.0.1:5000/caption");
  });

  it("falls back to a starter when init can't use the document, and says why", async () => {
    const directory = folder();
    let calls = 0;
    const fake = fakeIo({
      programs: {
        init: (args, cwd) => {
          if (++calls === 1) return { code: 1, output: "Read Text Tools API\nprovider-kit: none of its operations can be a service" };
          writeFileSync(join(cwd, args.at(-1)!), JSON.stringify(INIT_CONFIG));
          return { code: 0, output: "Wrote provider.config.json. Next: ..." };
        },
      },
    });
    expect(await create([directory, "--kind", "wrap", "--openapi", FIXTURE], fake.io)).toBe(0);
    const text = fake.output.join("\n");
    expect(text).toContain("    provider-kit: none of its operations can be a service");
    expect(text).toContain("! provider.config.json is a starter instead");
  });

  it("makes a Python project whose gateway config passes Provider Standard v1, as provider-kit serve loads it", async () => {
    const directory = folder();
    const fake = fakeIo();
    expect(await create([directory, "--kind", "python", "--name", "Quick Summaries", "--no-wallet"], fake.io)).toBe(0);
    for (const [, file] of TEMPLATE_FILES.python) expect(existsSync(join(directory, file))).toBe(true);
    expect(read(directory, "app.py")).toContain('app = FastAPI(title="Quick Summaries")');
    const { config } = await loadGatewayConfig(join(directory, "provider.config.json"), { env: { PAY_TO, PUBLIC_ORIGIN: "http://localhost:8787", JOB_DB_PATH: "memory" }, openStore: false, overrides: { dev: true } });
    const provider = createProvider({ ...config, rpc: false });
    expect(provider.manifest.services.map((service) => service.name)).toEqual(["summarize"]);
    await provider.close();
    expect(fake.output.join("\n")).toContain("python3 -m venv .venv && .venv/bin/pip install -r requirements.txt");
  });

  it("depends on the released kit when it doesn't run from a clone", async () => {
    const directory = folder();
    const fake = fakeIo({ kit: { from: "npm", version: "0.4.0" } });
    expect(await create([directory, "--kind", "python", "--no-wallet"], fake.io)).toBe(0);
    expect(fake.runs.some((run) => run.args[0] === "pack")).toBe(false);
    expect(JSON.parse(read(directory, "package.json")).dependencies).toEqual({ "@stellar-agent-services/provider-kit": "0.4.0" });
    expect(read(directory, "Dockerfile")).not.toContain("vendor");
  });

  it("refuses bad calls before writing anything", async () => {
    const directory = folder();
    mkdirSync(directory);
    writeFileSync(join(directory, "keep.txt"), "mine");
    await expect(create([directory, "--kind", "typescript"], fakeIo().io)).rejects.toThrow(/already exists and isn't empty/);
    await expect(create([folder()], fakeIo().io)).rejects.toThrow(UsageError);
    await expect(create([folder(), "--kind", "go"], fakeIo().io)).rejects.toThrow(/--kind must be wrap, typescript or python/);
    await expect(create([folder(), "--kind", "wrap"], fakeIo().io)).rejects.toThrow(/needs --openapi/);
    await expect(create([folder(), "--kind", "python", "--openapi", FIXTURE], fakeIo().io)).rejects.toThrow(/for --kind wrap/);
    await expect(create([folder(), "--kind", "python", "--pay-to", "SABC"], fakeIo().io)).rejects.toThrow(/public Stellar account/);
    await expect(create([folder(), "--kind", "python", "--pay-to", PAY_TO, "--wallet"], fakeIo().io)).rejects.toThrow(/pick one/);
    const stopped = fakeIo({ fetch: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) });
    const unread = folder();
    await expect(create([unread, "--kind", "wrap", "--openapi", "http://127.0.0.1:8000/openapi.json"], stopped.io)).rejects.toThrow(/nothing answers there.*Nothing was written/);
    expect(existsSync(unread)).toBe(false);
    expect(read(directory, "keep.txt")).toBe("mine");
  });

  it("asks for a clone to be built first", async () => {
    const kit: KitSource = { from: "clone", packages: join(scratch, "unbuilt", "packages") };
    await expect(create([folder(), "--kind", "typescript"], fakeIo({ kit }).io)).rejects.toThrow(/isn't built .*npm run build/);
  });

  it("says how to go on when npm install fails", async () => {
    const directory = folder();
    const fake = fakeIo({ programs: { "npm install": () => ({ code: 1, output: "npm error code E404\nnpm error 404 Not Found" }) } });
    expect(await create([directory, "--kind", "typescript"], fake.io)).toBe(1);
    expect(fake.output.join("\n")).toMatch(/npm install failed:\nnpm error code E404[\s\S]*run npm install there/);
  });
});

describe("the account clients pay", () => {
  it("is set up in the developer's wallet by provider-kit trustline, and its address goes in .env", async () => {
    const directory = folder();
    const fake = fakeIo();
    expect(await create([directory, "--kind", "typescript", "--wallet"], fake.io)).toBe(0);
    expect(fake.runs.find((run) => run.args[1] === "trustline")!.args).toEqual([KIT_CLI, "trustline", "--network", "testnet"]);
    expect(env(directory)["PAY_TO"]).toBe(PAY_TO);
    expect(fake.output.join("\n")).toContain(`✓ PAY_TO=${PAY_TO} in .env`);
  });

  it("is left for later when the developer doesn't finish, and the project is still made", async () => {
    const directory = folder();
    const fake = fakeIo({ programs: { trustline: () => ({ code: 1, output: "Cancelled in the browser. Nothing was signed." }) } });
    expect(await create([directory, "--kind", "typescript", "--wallet"], fake.io)).toBe(0);
    expect(env(directory)["PAY_TO"]).toBe("");
    expect(fake.output.join("\n")).toContain("The account wasn't set up. npm run wallet tries again later.");
  });
});

describe("create-stellar-service, on a terminal", () => {
  it("asks the four questions, with defaults", async () => {
    const directory = folder();
    const fake = fakeIo({ interactive: true, answers: [directory, "3", "Fast summaries of English text.", "n"] });
    expect(await create([], fake.io)).toBe(0);
    expect(fake.questions).toEqual(["Project folder [my-stellar-service]: ", "Pick 1, 2 or 3 [1]: ", "[Summarizes English text for agents: the…]: ", "[Y/n]: "]);
    expect(read(directory, "provider.config.json")).toContain('"description": "Fast summaries of English text."');
    expect(fake.runs.some((run) => run.args[1] === "trustline")).toBe(false);
  });

  it("asks again for a document it can't read, and takes a URL that isn't one as the endpoint", async () => {
    const directory = folder();
    const fetched: string[] = [];
    const fake = fakeIo({
      interactive: true,
      answers: [directory, "1", "", "http://127.0.0.1:5000/caption", "", "y"],
      fetch: async (url) => {
        fetched.push(String(url));
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    expect(await create([], fake.io)).toBe(0);
    expect(fetched).toEqual(["http://127.0.0.1:8000/openapi.json"]);
    expect(fake.output.join("\n")).toContain("Can't read it: nothing answers there.");
    expect(fake.runs.find((run) => run.args[1] === "init")!.args).toContain("http://127.0.0.1:5000/caption");
    expect(fake.runs.some((run) => run.args[1] === "trustline")).toBe(true);
  });

  it("writes nothing when cancelled at a question", async () => {
    const directory = folder();
    const fake = fakeIo({ interactive: true, answers: [directory] });
    expect(await create([], fake.io)).toBe(130);
    expect(fake.output.at(-1)).toBe("\nCancelled. Nothing was written.");
    expect(existsSync(directory)).toBe(false);
  });

  it("takes the defaults with --yes", async () => {
    const fake = fakeIo({ interactive: true });
    expect(await create([folder(), "--kind", "python", "--yes"], fake.io)).toBe(0);
    expect(fake.questions).toEqual([]);
  });
});

describe("the files", () => {
  const project = (kind: Kind, vendored = true): Project => ({ kind, package: "demo", name: 'Demo "Quoted"', description: "Does things.", vendored });

  it("fills every placeholder in every template", () => {
    for (const kind of ["wrap", "typescript", "python"] as const) {
      for (const vendored of [true, false]) {
        for (const [directory, file] of TEMPLATE_FILES[kind]) {
          const text = template(directory, file, project(kind, vendored));
          expect(text, `${directory}/${file}`).not.toMatch(/\{\{\w+\}\}/);
          if (file === "Dockerfile") expect(text.includes("COPY vendor ./vendor")).toBe(vendored);
        }
      }
    }
    expect(template("typescript", "src/server.ts", project("typescript"))).toContain('name: "Demo \\"Quoted\\""');
  });

  it("describes the template service the same way in TypeScript, Python and the gateway config", () => {
    const flat = (text: string) => text.replace(/"\s*\n\s*"/g, "");
    expect(template("typescript", "src/services/summarize.ts", project("typescript"))).toContain(SUMMARIZE.description);
    expect(flat(template("python", "app.py", project("python")))).toContain(SUMMARIZE.description);
  });

  it("compiles the TypeScript template against the Provider Kit", () => {
    const directory = mkdtempSync(join(scratch, "typescript-"));
    writeFileSync(join(directory, "package.json"), packageJson(project("typescript"), kitDependencies({ from: "npm", version: "0.0.0" })));
    for (const [templates, file] of TEMPLATE_FILES.typescript) {
      mkdirSync(join(directory, file, ".."), { recursive: true });
      writeFileSync(join(directory, file), template(templates, file, project("typescript")));
    }
    const options = ts.convertCompilerOptionsFromJson(JSON.parse(read(directory, "tsconfig.json")).compilerOptions, directory).options;
    const program = ts.createProgram([join(directory, "src/server.ts")], {
      ...options,
      noEmit: true,
      typeRoots: [join(REPO, "node_modules/@types")],
      paths: { "@stellar-agent-services/provider-kit": [join(REPO, "packages/provider-kit/dist/index.d.ts")] },
    });
    const problems = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(problems).toEqual([]);
  });

  it("gives a project the repository's overrides, so it installs one Stellar SDK", () => {
    expect(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).overrides).toEqual(OVERRIDES);
    expect(JSON.parse(packageJson(project("wrap"), kitDependencies({ from: "npm", version: "1.0.0" }))).overrides).toEqual(OVERRIDES);
  });

  it("makes init's config read baseUrl and store from .env, without dev, and lists the other variables it reads", () => {
    const { config, variables } = adaptInitConfig(JSON.stringify(INIT_CONFIG), { description: "Text tools." });
    expect(JSON.parse(config)).toMatchObject({ baseUrl: "env:PUBLIC_ORIGIN", store: "env:JOB_DB_PATH", provider: { name: "Text Tools API", description: "Text tools." } });
    expect(Object.keys(JSON.parse(config))).toEqual(Object.keys(INIT_CONFIG).filter((key) => key !== "dev"));
    expect(variables).toEqual(["UPSTREAM_X_API_KEY"]);
  });

  it("keeps .env free of anything but public settings and the API's own variables", () => {
    const text = envFile(project("wrap"), { payTo: PAY_TO, variables: ["UPSTREAM_X_API_KEY"] });
    expect(text).toContain(`PAY_TO=${PAY_TO}`);
    expect(text).toMatch(/UPSTREAM_X_API_KEY=\n$/);
    expect(text).not.toMatch(/SECRET|SEED|^S[A-Z2-7]{55}/m);
    expect(pythonGatewayConfig(project("python"))).toContain('"payTo": "env:PAY_TO"');
  });
});

describe("helpers", () => {
  it("tells a document from an endpoint", () => {
    expect(classify("http://127.0.0.1:8000/openapi.json")).toEqual({ openapi: "http://127.0.0.1:8000/openapi.json" });
    expect(classify("https://api.example.com/v3/api-docs")).toHaveProperty("openapi");
    expect(classify("http://localhost:8000/api/schema/")).toHaveProperty("openapi");
    expect(classify("./openapi.yaml")).toEqual({ openapi: "./openapi.yaml" });
    expect(classify("http://127.0.0.1:5000/summarize")).toEqual({ upstream: "http://127.0.0.1:5000/summarize" });
  });

  it("names the package and the provider after the folder", () => {
    expect(packageName("My Service!")).toBe("my-service");
    expect(packageName("___")).toBe("stellar-service");
    expect(titleCase("image-captioner_v2")).toBe("Image Captioner V2");
  });
});

describe("provider-kit init, as create runs it", () => {
  it("ends its report with a Next: line, where create cuts it", () => {
    const out = join(scratch, "init.json");
    const output = execFileSync(process.execPath, [resolve(REPO, "packages/provider-kit/dist/cli/index.js"), "init", "--openapi", FIXTURE, "--upstream", "http://127.0.0.1:8000", "--out", out], { encoding: "utf8" });
    expect(output.split("\n")).toContain("Next:");
    expect(output.split("\n").indexOf("Next:")).toBeGreaterThan(output.split("\n").findIndex((line) => line.startsWith("Wrote ")));
  });
});
