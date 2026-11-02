// The files a new project gets. Code, Dockerfiles and fly.toml come from templates/, with {{placeholders}} filled in;
// the files that depend on the answers (package.json, .env, the README, the Python kind's gateway config) are built here.
//
// Every kind runs with settings from .env: PAY_TO (the account clients pay), PUBLIC_ORIGIN (where clients reach the
// service), JOB_DB_PATH (the job database) and AGENT_ID (its Stellar 8004 agent id, once launched). A gateway config
// reads them as "env:NAME", so the same file runs on a laptop and in a container. PAY_TO starts empty: on testnet,
// `npm run dev` makes a throwaway account to be paid to, and `npm run launch` replaces it with the developer's own.
// A mainnet project (--network mainnet) also reads FACILITATOR_AUTH, the API key of mainnet's facilitator, and
// SOROBAN_RPC_URL. No file holds a Stellar secret key.

import { readFileSync } from "node:fs";
import { KIT_CLI, OVERRIDES } from "./kit.js";

export type Kind = "wrap" | "typescript" | "python";

/** The network a project takes payments on, as its CAIP-2 id: testnet's test money, or mainnet's (pubnet) real USDC. */
export type Network = "stellar:testnet" | "stellar:pubnet";

/** The facilitator that verifies and settles a project's payments: x402.org's on testnet, OpenZeppelin's on mainnet. */
export const FACILITATORS: Record<Network, string> = {
  "stellar:testnet": "https://x402.org/facilitator",
  "stellar:pubnet": "https://channels.openzeppelin.com/x402",
};

/** Where mainnet's facilitator gives out API keys. */
export const FACILITATOR_KEYS = "https://channels.openzeppelin.com/gen";

/** The Soroban RPC a mainnet project starts with: the one the Stellar 8004 SDK reads the registry through. */
export const MAINNET_RPC = "https://mainnet.sorobanrpc.com";

/** What a mainnet project also reads from .env, kept as secrets: the facilitator's API key, and an RPC URL, which may hold one. */
export const MAINNET_SETTINGS = ["FACILITATOR_AUTH", "SOROBAN_RPC_URL"] as const;

export const KINDS: Record<Kind, string> = {
  wrap: "Wrap an API you already run, in any language (no code changes)",
  typescript: "A new service in TypeScript",
  python: "A new service in Python (FastAPI)",
};

/** What every kind's provider says until the developer writes their own: the template's service. */
export const TEMPLATE_DESCRIPTION = "Summarizes English text for agents: the first sentences, with sentence and word counts.";

/** The price a service starts with, in USDC, when none is given. */
export const DEFAULT_PRICE = "0.01";

/** The template service, as the Python kind's gateway config describes it. src/services/summarize.ts and app.py match it. */
export const SUMMARIZE = {
  name: "summarize",
  title: "Summarize",
  description:
    "Returns the first sentences of an English text, with its sentence and word counts. Use it to shorten text before passing it on. Accepts up to 20,000 characters; it does not paraphrase.",
  price: DEFAULT_PRICE,
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
export const SETTINGS = ["PAY_TO", "PUBLIC_ORIGIN", "JOB_DB_PATH", "AGENT_ID"] as const;

export interface Project {
  kind: Kind;
  /** The folder's name, which is also the npm package name and the Docker image name. */
  package: string;
  /** The Fly.io app name in fly.toml: its public address is https://<app>.fly.dev. */
  app: string;
  name: string;
  description: string;
  /** Each service's price in USDC, such as "0.01". */
  price: string;
  network: Network;
  /** Whether the kit's packages are in vendor/, packed from a clone. */
  vendored: boolean;
  /** Python: whether uv runs the API, so no virtual environment has to be made first. */
  uv?: boolean;
}

/** The command that starts the Python kind's API on this computer: with uv when it is installed, else from .venv. */
export function apiCommand(project: Pick<Project, "uv">): string {
  return project.uv
    ? "uv run --no-project --with-requirements requirements.txt -- uvicorn app:app --port 8000 --reload"
    : ".venv/bin/uvicorn app:app --port 8000 --reload";
}

/** A file from templates/<directory>/, with every {{placeholder}} filled in. */
export function template(directory: string, file: string, project: Project): string {
  const text = readFileSync(new URL(`../templates/${directory}/${file}`, import.meta.url), "utf8");
  const values: Record<string, string> = {
    name: project.name,
    nameJson: JSON.stringify(project.name),
    descriptionJson: JSON.stringify(project.description),
    package: project.package,
    app: project.app,
    price: project.price,
    apiCommand: apiCommand(project),
  };
  return text
    .replace(/^\{\{vendor\}\}\n/gm, project.vendored ? "COPY vendor ./vendor\n" : "")
    .replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

/** The template files each kind copies: [template directory, file]. */
export const TEMPLATE_FILES: Record<Kind, [string, string][]> = {
  wrap: [
    ["gateway", "Dockerfile"],
    ["fly", "fly.toml"],
  ],
  typescript: [
    ["typescript", "Dockerfile"],
    ["typescript", "tsconfig.json"],
    ["typescript", "src/server.ts"],
    ["typescript", "src/services/summarize.ts"],
    ["fly", "fly.toml"],
  ],
  python: [
    ["python", "Dockerfile"],
    ["python", "app.py"],
    ["python", "requirements.txt"],
    ["python", "start.sh"],
    ["fly", "fly.toml"],
  ],
};

export function packageJson(project: Project, dependencies: Record<string, string>): string {
  const kit = (command: string) => `node --env-file-if-exists=.env ${KIT_CLI} ${command}`;
  const server = "node --disable-warning=ExperimentalWarning dist/server.js";
  const deploy = "fly deploy --ha=false";
  const scripts =
    project.kind === "typescript"
      ? {
          build: "tsc",
          dev: `tsc && provider-kit dev -- ${server}`,
          try: 'provider-kit try --start "npm run dev"',
          check: "provider-kit check --manifest http://localhost:8787/.well-known/stellar-agent-services.json --dev",
          status: "provider-kit status",
          launch: `tsc && provider-kit launch --start "${server}"`,
          deploy,
          start: `node --env-file-if-exists=.env --disable-warning=ExperimentalWarning dist/server.js`,
        }
      : {
          dev: kit(`dev --config provider.config.json${project.kind === "python" ? ` --with "${apiCommand(project)}"` : ""}`),
          // A Python project's API runs next to the gateway, which `npm run dev` starts too.
          try: kit(`try --config provider.config.json${project.kind === "python" ? ' --start "npm run dev"' : ""}`),
          check: kit("check --config provider.config.json --dev"),
          status: kit("status --config provider.config.json"),
          launch: kit("launch --config provider.config.json"),
          deploy,
          start: kit("serve --config provider.config.json"),
        };
  // try pays with test money, which only testnet has.
  const { try: _try, ...mainnetScripts } = scripts;
  const file = {
    name: project.package,
    version: "0.1.0",
    private: true,
    description: project.description,
    type: "module",
    engines: { node: ">=22.13" },
    scripts: project.network === "stellar:pubnet" ? mainnetScripts : scripts,
    dependencies,
    ...(project.kind === "typescript" ? { devDependencies: { "@types/node": "22.20.5", typescript: "6.0.3" } } : {}),
    overrides: OVERRIDES,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The Python kind's gateway config: the template service in front of app.py, at the project's price. */
export function pythonGatewayConfig(project: Project): string {
  return `${JSON.stringify(gatewayConfig(project.name, project.description, [{ ...SUMMARIZE, price: project.price }], project.network), null, 2)}\n`;
}

function gatewayConfig(name: string, description: string, services: object[], network: Network): object {
  return {
    $schema: "./node_modules/@stellar-agent-services/provider-kit/schemas/gateway-config.schema.json",
    baseUrl: "env:PUBLIC_ORIGIN",
    network,
    payTo: "env:PAY_TO",
    ...facilitatorSettings(network),
    provider: { name, description, agentId: "env:AGENT_ID", dataUse: { storesInputs: false, trainsOnInputs: false } },
    store: "env:JOB_DB_PATH",
    services,
  };
}

/** A gateway config's facilitator: on mainnet with its API key, and the RPC that decides uncertain payments, from .env. */
function facilitatorSettings(network: Network): Record<string, unknown> {
  if (network !== "stellar:pubnet") return { facilitator: FACILITATORS["stellar:testnet"] };
  return { facilitator: FACILITATORS[network], facilitatorHeaders: { Authorization: "env:FACILITATOR_AUTH" }, rpcUrl: "env:SOROBAN_RPC_URL" };
}

/**
 * A config `provider-kit init` wrote, made to run anywhere: baseUrl, store and the agent id from .env, no "dev" (npm run
 * dev runs in development), the name, description and price given, and on mainnet its facilitator, key and RPC. Returns
 * the config and the other variables it reads, such as the API key init named for an upstream header.
 */
export function adaptInitConfig(
  text: string,
  provider: { name?: string; description?: string; price?: string },
  network: Network = "stellar:testnet",
): { config: string; variables: string[] } {
  type Config = Record<string, unknown> & { provider: Record<string, unknown>; services?: Record<string, unknown>[] };
  let config = JSON.parse(text) as Config;
  config["baseUrl"] = "env:PUBLIC_ORIGIN";
  config["store"] = "env:JOB_DB_PATH";
  delete config["dev"];
  // init writes a testnet config: the network and facilitator settings change in their places.
  const facilitator = facilitatorSettings(network);
  if (!("facilitator" in config)) config["facilitator"] = facilitator["facilitator"];
  config = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]): [string, unknown][] => {
      if (key === "network") return [[key, network]];
      if (key === "facilitator") return Object.entries(facilitator);
      return key in facilitator ? [] : [[key, value]];
    }),
  ) as Config;
  if (provider.name !== undefined) config.provider["name"] = provider.name;
  if (provider.description !== undefined) config.provider["description"] = provider.description;
  config.provider["agentId"] = "env:AGENT_ID";
  if (provider.price !== undefined) for (const service of config.services ?? []) service["price"] = provider.price;
  const variables = new Set<string>();
  JSON.stringify(config, (_key, value: unknown) => {
    if (typeof value === "string" && value.startsWith("env:")) variables.add(value.slice("env:".length));
    return value;
  });
  for (const setting of SETTINGS) variables.delete(setting);
  // A mainnet project's .env has these with their own notes (envFile).
  if (network === "stellar:pubnet") for (const setting of MAINNET_SETTINGS) variables.delete(setting);
  return { config: `${JSON.stringify(config, null, 2)}\n`, variables: [...variables] };
}

/** .env, or .env.example with `example`: the settings, and the variables a gateway config also reads. */
export function envFile(project: Project, values: { payTo?: string; variables?: string[] }, example = false): string {
  const testnet = project.network !== "stellar:pubnet";
  const lines = [
    example
      ? "# The settings npm run dev and the other scripts read. Copy this file to .env and fill it in; .env stays out of git."
      : "# The settings npm run dev and the other scripts read. This file stays out of git; .env.example lists the same.",
    "# No Stellar secret key goes here, or anywhere else in this project.",
    "",
    ...(testnet
      ? ["# The account clients pay, in USDC: a public G... address. Leave it empty: npm run dev makes a throwaway testnet", "# account to be paid to, and npm run launch sets up one in your own wallet."]
      : ["# The account clients pay, in USDC: a public G... address in your own wallet. Leave it empty: npm run launch sets", "# one up. Mainnet has no throwaway accounts."]),
    `PAY_TO=${example ? "" : (values.payTo ?? "")}`,
    "# Where clients reach this service on this computer. npm run launch takes the public one from fly.toml.",
    "PUBLIC_ORIGIN=http://localhost:8787",
    "# The job database: paid jobs live here, so keep it on a disk that survives restarts.",
    "JOB_DB_PATH=./jobs.sqlite",
    "# Your Stellar 8004 agent id: npm run launch saves it.",
    "AGENT_ID=",
  ];
  if (project.kind === "typescript") {
    // A gateway's network is in provider.config.json; the TypeScript service reads it here, as provider-kit does.
    lines.push("# The network: stellar:testnet takes test money, stellar:pubnet is mainnet, real USDC.", `STELLAR_NETWORK=${project.network}`);
    if (testnet) lines.push("# A Soroban RPC, to decide uncertain payments from the chain. Testnet has a default.", "# SOROBAN_RPC_URL=");
  }
  if (!testnet) {
    lines.push(
      "",
      `# Mainnet's facilitator settles payments with an API key: get one at ${FACILITATOR_KEYS}, and write it here`,
      '# as "Bearer <key>". npm run launch stages it, and SOROBAN_RPC_URL, as Fly secrets.',
      "FACILITATOR_AUTH=",
      "# A Soroban RPC, to decide uncertain payments from the chain: mainnet has no default. This is the one the Stellar",
      "# 8004 SDK uses; for production traffic, a provider's is safer: https://developers.stellar.org/docs/data/apis/rpc/providers",
      `SOROBAN_RPC_URL=${MAINNET_RPC}`,
    );
  }
  const variables = values.variables ?? [];
  if (variables.length > 0) lines.push("", "# What provider.config.json sends your API, such as its key. npm run launch stages it as a Fly secret.", ...variables.map((name) => `${name}=`));
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

/** The project's README: run it, try it, take it live, see where it stands, and make it yours. */
export function readme(project: Project, options: { services: string; upstream?: string }): string {
  const docs = "https://github.com/AlgoriaLabs/stellar-agent-services/blob/main";
  const run = {
    wrap: [
      `1. Start your API, if it isn't running. ${options.upstream === undefined ? "" : `The gateway calls it at ${options.upstream}.`}`.trimEnd(),
      "2. `npm run dev` starts the gateway at http://localhost:8787, in front of your API.",
      "3. `npm run try` pays for one call with test money, from another terminal. It starts the gateway itself when it isn't running.",
    ],
    typescript: [
      "1. `npm run dev` builds the service and starts it at http://localhost:8787.",
      "2. `npm run try` pays for one call with test money, from another terminal. It starts the service itself when it isn't running.",
    ],
    python: project.uv
      ? [
          "1. `npm run dev` starts the API (with uv, which installs its packages) and the gateway in front of it, at http://localhost:8787.",
          "2. `npm run try` pays for one call with test money, from another terminal. It starts both itself when they aren't running.",
        ]
      : [
          "1. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` installs the API's packages, once.",
          "2. `npm run dev` starts the API and the gateway in front of it, at http://localhost:8787.",
          "3. `npm run try` pays for one call with test money, from another terminal. It starts both itself when they aren't running.",
        ],
  }[project.kind];
  const testnet = project.network !== "stellar:pubnet";
  // Mainnet has no test money and no throwaway account: launch sets up the account clients pay before anything runs.
  const starts = { wrap: "the gateway, in front of your API,", typescript: "the service", python: "the API and the gateway in front of it," }[project.kind];
  const steps = testnet
    ? run
    : [
        ...(project.kind === "python" && !project.uv ? ["`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` installs the API's packages, once."] : []),
        `Set \`FACILITATOR_AUTH\` in \`.env\`: mainnet's facilitator settles payments with an API key, from ${FACILITATOR_KEYS}.`,
        "`npm run launch` sets up the account clients pay in your own wallet, registers the service and deploys it: see below.",
        `\`npm run dev\` then runs ${starts} at http://localhost:8787 too.${project.kind === "wrap" ? " Start your API first." : ""}`,
      ].map((line, index) => `${index + 1}. ${line}`);
  const yours = {
    wrap: [
      "`provider.config.json` describes each service: its price in USDC, when it's charged (`on-success` or `upfront`),",
      "its description and schemas, and the URL of your API it calls. The timing and capacity are first guesses.",
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
    ["`Dockerfile`", "The image to deploy, on any host that runs a container"],
    ["`fly.toml`", `Fly.io's settings: the app, ${project.app}, and the volume for the job database`],
    ...(project.vendored ? ([["`vendor/`", "The Provider Kit, packed from your clone until it is on npm. Commit it."]] as [string, string][]) : []),
  ];
  return `# ${project.name}

${project.description}

A paid service on Stellar: agents pay for each call in USDC, through x402, under
[Provider Standard v1](${docs}/docs/provider-standard.md). Made with \`npm create stellar-service\`.

## Run it

${steps.join("\n")}

${
  testnet
    ? `No wallet yet: while \`PAY_TO\` in \`.env\` is empty, \`npm run dev\` makes a throwaway testnet account to be paid to. Its
key is dropped at once, so the test money it receives can't be spent.`
    : `This project takes real USDC on Stellar mainnet, so there is no throwaway account and no test money: to try paid
calls first, make a testnet project.`
} \`npm run check\` checks the service against the
standard and shows how agents see it.

## Take it live

\`npm run launch\` does the rest, on ${testnet ? "testnet" : "mainnet"}:

1. It reads your service's public address from \`fly.toml\`: https://${project.app}.fly.dev.
2. A page opens where your own wallet (Freighter, xBull, Albedo and others) approves, in one go: a USDC trustline, so
   the account can be paid; the registration in the Stellar 8004 registry, where agents find you; and a request to a
   verifier to check the service.${testnet ? "" : " The account needs a few XLM, for the trustline's reserve and the fees."}
3. It saves \`PAY_TO\` and \`AGENT_ID\` in \`.env\` and \`fly.toml\`, deploys to Fly.io with \`flyctl\` if you say yes, and
   waits until the service answers at its public address.${testnet ? "" : " `FACILITATOR_AUTH` and `SOROBAN_RPC_URL` go to\n   Fly as secrets."}

\`npm run status\` shows where it stands at any time, from running here to verified, and the command to run next.
\`npm run deploy\` deploys again after a change.

Another host works too: \`npm run launch -- --url https://your.domain --no-deploy\` registers that address and prints
the settings to deploy with. Run the \`Dockerfile\` there with a persistent volume at \`/data\` for the job database.
${project.kind === "wrap" ? "In the container, 127.0.0.1 is the container itself: point each `upstream.url` at an address it reaches your API on.\n" : ""}
Search matches the provider's name and description (on testnet, its services too), so use the words buyers type. More:
[the setup guide](${docs}/docs/provider-setup-guide.md).

## Make it yours

${yours.join("\n")}

## Files

| File | What it is |
| --- | --- |
${files.map(([file, what]) => `| ${file} | ${what} |`).join("\n")}
`;
}
