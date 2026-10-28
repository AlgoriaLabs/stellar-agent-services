// The files a new project gets. Code and Dockerfiles come from templates/, with {{placeholders}} filled in; the files
// that depend on the answers (package.json, .env, the README, the Python kind's gateway config) are built here.
//
// Every kind runs on testnet with settings from .env: PAY_TO (the account clients pay), PUBLIC_ORIGIN (where clients
// reach the service) and JOB_DB_PATH (the job database). A gateway config reads them as "env:NAME", so the same file
// runs on a laptop and in a container. No file holds a Stellar secret key.

import { readFileSync } from "node:fs";
import { KIT_CLI, OVERRIDES } from "./kit.js";

export type Kind = "wrap" | "typescript" | "python";

export const KINDS: Record<Kind, string> = {
  wrap: "Wrap an API you already run, in any language (no code changes)",
  typescript: "A new service in TypeScript",
  python: "A new service in Python (FastAPI)",
};

/** What every kind's provider says until the developer writes their own: the template's service. */
export const TEMPLATE_DESCRIPTION = "Summarizes English text for agents: the first sentences, with sentence and word counts.";

/** The template service, as the Python kind's gateway config describes it. src/services/summarize.ts and app.py match it. */
export const SUMMARIZE = {
  name: "summarize",
  title: "Summarize",
  description:
    "Returns the first sentences of an English text, with its sentence and word counts. Use it to shorten text before passing it on. Accepts up to 20,000 characters; it does not paraphrase.",
  price: "0.01",
  charge: "on-success",
  expectedDurationSeconds: 2,
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 20000, description: "The text to summarize" },
      sentences: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "How many sentences to keep" },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["summary", "sentences", "words"],
    properties: {
      summary: { type: "string" },
      sentences: { type: "integer", description: "Sentences in the text" },
      words: { type: "integer", description: "Words in the text" },
    },
  },
  examples: [{ input: { text: "Stellar settles in seconds. Fees are tiny.", sentences: 1 }, output: { summary: "Stellar settles in seconds.", sentences: 2, words: 7 } }],
  capacity: { concurrency: 4, maxQueueWaitSeconds: 20 },
  upstream: { url: "http://127.0.0.1:8000/summarize" },
};

/** The settings every project reads from .env, which a gateway config names as "env:NAME". */
export const SETTINGS = ["PAY_TO", "PUBLIC_ORIGIN", "JOB_DB_PATH"] as const;

export interface Project {
  kind: Kind;
  /** The folder's name, which is also the npm package name and the Docker image name. */
  package: string;
  name: string;
  description: string;
  /** Whether the kit's packages are in vendor/, packed from a clone. */
  vendored: boolean;
}

/** A file from templates/<directory>/, with {{name}}, {{nameJson}}, {{descriptionJson}}, {{package}} and {{vendor}} filled in. */
export function template(directory: string, file: string, project: Project): string {
  const text = readFileSync(new URL(`../templates/${directory}/${file}`, import.meta.url), "utf8");
  const values: Record<string, string> = {
    name: project.name,
    nameJson: JSON.stringify(project.name),
    descriptionJson: JSON.stringify(project.description),
    package: project.package,
  };
  return text
    .replace(/^\{\{vendor\}\}\n/gm, project.vendored ? "COPY vendor ./vendor\n" : "")
    .replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

/** The template files each kind copies: [template directory, file]. */
export const TEMPLATE_FILES: Record<Kind, [string, string][]> = {
  wrap: [["gateway", "Dockerfile"]],
  typescript: [
    ["typescript", "Dockerfile"],
    ["typescript", "tsconfig.json"],
    ["typescript", "src/server.ts"],
    ["typescript", "src/services/summarize.ts"],
  ],
  python: [
    ["python", "Dockerfile"],
    ["python", "app.py"],
    ["python", "requirements.txt"],
    ["python", "start.sh"],
  ],
};

export function packageJson(project: Project, dependencies: Record<string, string>): string {
  const kit = (command: string) => `node --env-file-if-exists=.env ${KIT_CLI} ${command}`;
  const scripts =
    project.kind === "typescript"
      ? {
          build: "tsc",
          dev: "tsc && node --env-file-if-exists=.env --disable-warning=ExperimentalWarning dist/server.js",
          start: "node --env-file-if-exists=.env --disable-warning=ExperimentalWarning dist/server.js",
          try: "provider-kit try",
          check: "provider-kit check --manifest http://localhost:8787/.well-known/stellar-agent-services.json --dev",
          wallet: "provider-kit trustline --network testnet",
        }
      : {
          dev: kit("serve --config provider.config.json --dev"),
          start: kit("serve --config provider.config.json"),
          try: kit("try --config provider.config.json"),
          check: kit("check --config provider.config.json --dev"),
          wallet: "provider-kit trustline --network testnet",
          register: kit("register --config provider.config.json"),
        };
  const file = {
    name: project.package,
    version: "0.1.0",
    private: true,
    description: project.description,
    type: "module",
    engines: { node: ">=22.13" },
    scripts,
    dependencies,
    ...(project.kind === "typescript" ? { devDependencies: { "@types/node": "22.20.5", typescript: "6.0.3" } } : {}),
    overrides: OVERRIDES,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The Python kind's gateway config: the template service in front of app.py. */
export function pythonGatewayConfig(project: Project): string {
  return `${JSON.stringify(gatewayConfig(project.name, project.description, [SUMMARIZE]), null, 2)}\n`;
}

function gatewayConfig(name: string, description: string, services: object[]): object {
  return {
    $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
    baseUrl: "env:PUBLIC_ORIGIN",
    network: "stellar:testnet",
    payTo: "env:PAY_TO",
    facilitator: "https://x402.org/facilitator",
    provider: { name, description, dataUse: { storesInputs: false, trainsOnInputs: false } },
    store: "env:JOB_DB_PATH",
    services,
  };
}

/**
 * A config `provider-kit init` wrote, made to run anywhere: baseUrl and store from .env, no "dev" (npm run dev passes
 * --dev), and the name and description given. Returns the config and the other variables it reads, such as the API
 * key init named for an upstream header.
 */
export function adaptInitConfig(text: string, provider: { name?: string; description?: string }): { config: string; variables: string[] } {
  const config = JSON.parse(text) as Record<string, unknown> & { provider: Record<string, unknown> };
  config["baseUrl"] = "env:PUBLIC_ORIGIN";
  config["store"] = "env:JOB_DB_PATH";
  delete config["dev"];
  if (provider.name !== undefined) config.provider["name"] = provider.name;
  if (provider.description !== undefined) config.provider["description"] = provider.description;
  const variables = new Set<string>();
  JSON.stringify(config, (_key, value: unknown) => {
    if (typeof value === "string" && value.startsWith("env:")) variables.add(value.slice("env:".length));
    return value;
  });
  for (const setting of SETTINGS) variables.delete(setting);
  return { config: `${JSON.stringify(config, null, 2)}\n`, variables: [...variables] };
}

/** .env, or .env.example with `example`: the settings, and the variables a gateway config also reads. */
export function envFile(project: Project, values: { payTo?: string; variables?: string[] }, example = false): string {
  const lines = [
    example
      ? "# The settings npm run dev and the other scripts read. Copy this file to .env and fill it in; .env stays out of git."
      : "# The settings npm run dev and the other scripts read. This file stays out of git; .env.example lists the same.",
    "# No Stellar secret key goes here, or anywhere else in this project.",
    "",
    "# The account clients pay, in USDC: a public G... address with a USDC trustline. npm run wallet sets one up.",
    `PAY_TO=${example ? "" : (values.payTo ?? "")}`,
    "# Where clients reach this service. Your public HTTPS origin once deployed.",
    "PUBLIC_ORIGIN=http://localhost:8787",
    "# The job database: paid jobs live here, so keep it on a disk that survives restarts.",
    "JOB_DB_PATH=./jobs.sqlite",
  ];
  if (project.kind === "typescript") {
    lines.push("# After registering in Stellar 8004: the service's agent id.", "# AGENT_ID=", "# A Soroban RPC, to decide uncertain payments from the chain. Testnet has a default.", "# SOROBAN_RPC_URL=");
  }
  const variables = values.variables ?? [];
  if (variables.length > 0) lines.push("", "# What provider.config.json sends your API, such as its key:", ...variables.map((name) => `${name}=`));
  return `${lines.join("\n")}\n`;
}

export function gitignore(project: Project): string {
  const lines = ["node_modules/", ".env", "jobs.sqlite*"];
  if (project.kind === "typescript") lines.push("dist/");
  if (project.kind === "python") lines.push(".venv/", "__pycache__/");
  return `${lines.join("\n")}\n`;
}

export function dockerignore(project: Project): string {
  return `${[".git", ...gitignore(project).trimEnd().split("\n")].join("\n")}\n`;
}

/** The project's README: how to run it, try it, get paid, deploy it and get found. */
export function readme(project: Project, options: { services: string; upstream?: string }): string {
  const docs = "https://github.com/AlgoriaLabs/stellar-agent-services/blob/main";
  const run = {
    wrap: [
      `1. Start your API, if it isn't running. ${options.upstream === undefined ? "" : `The gateway calls it at ${options.upstream}.`}`.trimEnd(),
      "2. `npm run dev` starts the gateway at http://localhost:8787, in front of your API.",
      "3. `npm run try` pays for one call with test money, from another terminal.",
    ],
    typescript: ["1. `npm run dev` builds the service and starts it at http://localhost:8787.", "2. `npm run try` pays for one call with test money, from another terminal."],
    python: [
      "1. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` installs the API's packages, once.",
      "2. `.venv/bin/uvicorn app:app --port 8000 --reload` starts the API.",
      "3. `npm run dev` starts the gateway at http://localhost:8787, in front of the API, from another terminal.",
      "4. `npm run try` pays for one call with test money, from a third.",
    ],
  }[project.kind];
  const yours = {
    wrap: [
      "`provider.config.json` describes each service: its price in USDC, when it's charged (`on-success` or `upfront`),",
      "its description and schemas, and the URL of your API it calls. The price and timing are first guesses.",
      `Its JSON Schema gives your editor help with every field. Reference: [gateway mode](${docs}/packages/provider-kit/README.md#gateway-mode).`,
    ],
    typescript: [
      "`src/services/summarize.ts` is an example service. Replace its handler with your own work, such as a model call, and",
      "keep its description, schemas and example in step: agents read them before they pay. Add more services next to it",
      `and list them in \`src/server.ts\`. Reference: [the Provider Kit](${docs}/packages/provider-kit/README.md).`,
    ],
    python: [
      "`app.py` is the service: replace the work in `summarize` with your own, such as a model call. The gateway's",
      "`provider.config.json` describes it to agents: price, charge, description and schemas. Keep its schemas in step with",
      "the models in `app.py`. A new endpoint needs a service there too. With the API running,",
      "`npx provider-kit init --openapi http://127.0.0.1:8000/openapi.json --out new.config.json` writes one from FastAPI's document.",
    ],
  }[project.kind];
  const register =
    project.kind === "typescript"
      ? "`npx provider-kit register --manifest https://your.domain/.well-known/stellar-agent-services.json`, then set `AGENT_ID` to the id it prints."
      : "`PUBLIC_ORIGIN=https://your.domain npm run register`. It saves the agent id to `provider.config.json`: deploy it again.";
  const files: [string, string][] = [
    ...(project.kind === "typescript"
      ? ([
          ["`src/server.ts`", "The provider: settings, the services it offers, the job database"],
          ["`src/services/summarize.ts`", "An example service, to replace"],
        ] as [string, string][])
      : []),
    ...(project.kind === "python" ? ([["`app.py`", "The service, a FastAPI app"], ["`start.sh`", "Starts the app and the gateway together, in Docker"]] as [string, string][]) : []),
    ...(project.kind === "typescript" ? [] : ([["`provider.config.json`", `The gateway config, for ${options.services}`]] as [string, string][])),
    ["`.env`", "Your settings, kept out of git. `.env.example` lists them."],
    ["`Dockerfile`", "The image to deploy"],
    ...(project.vendored ? ([["`vendor/`", "The Provider Kit, packed from your clone until it is on npm. Commit it."]] as [string, string][]) : []),
  ];
  return `# ${project.name}

${project.description}

A paid service on Stellar: agents pay for each call in USDC, through x402, under
[Provider Standard v1](${docs}/docs/provider-standard.md). Made with \`npm create stellar-service\`.

## Run it

${run.join("\n")}

\`npm run check\` checks it against the standard and shows how agents see it: what search matches, and what to improve.

## Get paid

Clients pay \`PAY_TO\` in \`.env\`: a public address in your own wallet, with a USDC trustline. \`npm run wallet\` sets one
up: a page opens where your wallet (Freighter, xBull, Albedo and others) approves the trustline on testnet, and it
prints the address for \`.env\`. Nothing in this project holds a secret key.

## Make it yours

${yours.join("\n")}

## Deploy

\`docker build -t ${project.package} .\`, then run the image with \`PAY_TO\`, \`PUBLIC_ORIGIN\` set to your public HTTPS
origin, and a persistent volume at \`/data\` for the job database. Clients accept \`http://\` only in development.
${project.kind === "wrap" ? "In the container, 127.0.0.1 is the container itself: point each `upstream.url` at an address it reaches your API on.\n" : ""}More: [deploy on HTTPS](${docs}/docs/provider-setup-guide.md#7-deploy-on-https).

## Get found

Once deployed, register the service in the Stellar 8004 registry, approved in your wallet:
${register}
Search matches only the provider's name and description, so use the words buyers type.

## Files

| File | What it is |
| --- | --- |
${files.map(([file, what]) => `| ${file} | ${what} |`).join("\n")}
`;
}
