# create-stellar-service

`npm create stellar-service` makes a project that sells an AI service on Stellar: agents pay per call in USDC through
x402, under [Provider Standard v1](../../docs/provider-standard.md). The project runs, takes a paid testnet call and
goes live as it comes, with no wallet needed until it goes live.

```text
$ npm create stellar-service

Project folder [my-stellar-service]: captioner
What are you making?
  1. Wrap an API you already run, in any language (no code changes)
  2. A new service in TypeScript
  3. A new service in Python (FastAPI)
Pick 1, 2 or 3 [1]: 1
Your API's OpenAPI document, or the URL a paid call goes to [http://127.0.0.1:8000/openapi.json]:
In one sentence, what does it offer? Agents search for it by these words and its name.
[Enter: the document's]: Captions for product photos, in English and Turkish.
What does a call cost, in USDC? [0.01]: 0.05
```

Then it writes the project and installs it. Next:

```bash
cd captioner
npm run dev       # runs it here, paid to a throwaway testnet account: no wallet needed yet
npm run try       # pays for one call with test money, from another terminal
npm run launch    # goes live: one approval in your wallet, then Fly.io
```

`npm run launch` opens a page where your own wallet (Freighter, xBull, Albedo and others) approves the USDC trustline,
the Stellar 8004 registration and a request for verification, in one go. Then it saves `PAY_TO` and `AGENT_ID`,
deploys to Fly.io if you say yes, and waits until the service answers at its public address. `npm run status` shows
where it stands at any time.

**Until the packages are on npm,** run it from a clone, built once (`npm install && npm run build`):

```bash
node "$REPO/packages/create-stellar-service/dist/index.js" captioner
```

From a clone, it packs the Provider Kit into the project's `vendor/` folder, so the project installs and builds by
itself, in Docker too. Once published, the project depends on the kit's released version instead.

## What it makes

| Kind | You get |
| --- | --- |
| `wrap` | The [gateway](../provider-kit/README.md#gateway-mode) in front of an API you already run, in any language, with no code changes. With an OpenAPI document (FastAPI serves `/openapi.json`), `provider-kit init --openapi` makes a service of each POST endpoint it can call; without one, a starter service calls the URL you give. |
| `typescript` | A new service with the [Provider Kit library](../provider-kit/README.md#library-in-short): `src/server.ts` and an example service to replace, `src/services/summarize.ts`. |
| `python` | A new FastAPI app, `app.py`, with the gateway in front of it, and one container that runs both. |

Every project has `.env` (the settings, kept out of git) and `.env.example`, a `Dockerfile` that keeps the job
database on a volume at `/data`, a `fly.toml` for Fly.io, a `README.md`, and these scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the service, or the gateway (and the Python kind's API), at http://localhost:8787. With `PAY_TO` empty it is paid to a throwaway testnet account ([`provider-kit dev`](../provider-kit/README.md#the-throwaway-payout-account)) |
| `npm run try` | Pays for one call with test money, from a throwaway testnet account, and starts the service for it when it isn't running ([`provider-kit try`](../provider-kit/README.md#trying-a-paid-call)) |
| `npm run check` | Checks the provider against the standard and shows how agents see it |
| `npm run launch` | Takes it live: one page in your wallet for the trustline, the 8004 registration and verification, then the deploy ([`provider-kit launch`](../provider-kit/README.md#launching)) |
| `npm run status` | Where it stands, from running here to verified, and the command to run next |
| `npm run deploy` | Deploys again to Fly.io (`fly deploy`) |
| `npm start` | Starts it for production: `PUBLIC_ORIGIN` must be your HTTPS origin |

A gateway config reads `baseUrl`, `payTo`, `store` and the agent id from `.env` (`env:PUBLIC_ORIGIN`, `env:PAY_TO`,
`env:JOB_DB_PATH`, `env:AGENT_ID`), so the same file runs on a laptop and in a container.

**Fly.io.** `fly.toml` names the app after the folder, so the public address, `https://<app>.fly.dev`, is known before
the first deploy: `launch` registers the service with it, writes `PUBLIC_ORIGIN`, `PAY_TO` and `AGENT_ID` under
`[env]`, and deploys once. The job database lives on a volume Fly makes on the first deploy. Another host works too:
`npm run launch -- --url https://your.domain --no-deploy`.

**Python.** With [uv](https://docs.astral.sh/uv/) installed, `npm run dev` starts the API with
`uv run --with-requirements requirements.txt`, so there is no virtual environment to make. Without it, the next steps
give the two commands that make `.venv`.

## Mainnet

`--network mainnet` makes a project that takes real USDC on `stellar:pubnet`. What changes:

- **The facilitator.** Payments settle through OpenZeppelin's facilitator, `https://channels.openzeppelin.com/x402`,
  which Stellar's docs list for mainnet (x402.org's settles testnet only). It wants an API key: get one at
  [channels.openzeppelin.com/gen](https://channels.openzeppelin.com/gen) and set `FACILITATOR_AUTH="Bearer <key>"` in
  `.env`. A gateway config sends it as `"facilitatorHeaders": { "Authorization": "env:FACILITATOR_AUTH" }`; the
  TypeScript service reads it in `src/server.ts`. Without it, the service stops at start and says so.
- **The RPC.** `SOROBAN_RPC_URL` in `.env` starts as `https://mainnet.sorobanrpc.com`, the RPC the Stellar 8004 SDK
  uses. Mainnet has no default one. For production traffic, an [RPC provider](https://developers.stellar.org/docs/data/apis/rpc/providers)'s
  is safer.
- **No test money.** There is no throwaway account and no `npm run try`. `npm run launch` sets up the account clients
  pay in your own wallet, which needs a few XLM, and `npm run dev` runs once `PAY_TO` is set.
- **The deploy.** `launch` stages `FACILITATOR_AUTH` and `SOROBAN_RPC_URL` as Fly secrets. A TypeScript service reads its
  network from `STELLAR_NETWORK`, which `launch` also writes to `fly.toml`. It won't call a deploy live while it takes
  payments on another network than the one it registered on.

To take a testnet project to mainnet, make these changes by hand: in a gateway config, `network`, `facilitator`,
`facilitatorHeaders` and `rpcUrl`; in a TypeScript project's `.env`, `STELLAR_NETWORK=stellar:pubnet`. In both, add
`FACILITATOR_AUTH` and `SOROBAN_RPC_URL` to `.env`. Then empty `PAY_TO` and `AGENT_ID` (testnet's agent ids don't exist
on mainnet), delete `DEV_PAY_TO`, and run `npm run launch`.

## For scripts and coding agents

Flags answer every question. Without a terminal it asks nothing, and `--kind` is needed:

```bash
create-stellar-service captioner --kind wrap --openapi http://127.0.0.1:8000/openapi.json \
  --description "Captions for product photos, in English and Turkish." --price 0.05
```

| Flag | Answers |
| --- | --- |
| `--kind wrap\|typescript\|python` | What to make |
| `--openapi <file \| url>` | The API's OpenAPI document (`wrap`). It is read first, so nothing is written for an API that isn't running. With a file whose servers are relative, `--upstream` is the API's base URL. |
| `--upstream <url>` | Without `--openapi`: the URL a paid call goes to (`wrap`) |
| `--description <text>` | One sentence on what it offers: search matches it and the name |
| `--name <text>` | The provider's name. Default: the folder's, or the document's title. |
| `--price <usdc>` | What a call costs, in USDC. Default `0.01`. |
| `--network testnet\|mainnet` | Where clients pay. Default `testnet`, with test money. `mainnet` takes real USDC: see [Mainnet](#mainnet). |
| `--wallet`, `--pay-to <G…>` | Set up the payout account now in your wallet, or use an address you have. Without either, nothing is needed until `npm run launch`. |
| `--yes` | Take the defaults for the questions no flag answers |

`--wallet` opens a page in the user's browser, so a coding agent asks the user first. It signs nothing itself. So
does `npm run launch` later: a coding agent runs it with `--no-open` and gives the user the link.

## Safety

- **No secret key, anywhere.** It never asks for one, makes one or writes one. The payout account is set up in the
  developer's own wallet, on `provider-kit launch`'s approval page, and only its public address is saved. Until then,
  `npm run dev`'s throwaway testnet account has no key anyone keeps.
- **It never pays.** `npm run try` pays later, when the developer runs it, from a throwaway account with test money.
- **Testnet unless asked.** Every project starts on `stellar:testnet`; only `--network mainnet` makes a mainnet one.
- **Nothing is overwritten.** It refuses a folder that already has files in it.

## Files

| File | Contents |
| --- | --- |
| `src/main.ts` | The questions, the flags, and the run: write, install, the gateway config, the payout account if asked |
| `src/files.ts` | The files each kind writes: `package.json` and its scripts, `.env`, the README, the Python kind's gateway config, and the templates filled in |
| `src/kit.ts` | Where the Provider Kit comes from: a clone (packed into `vendor/`) or npm, and the npm overrides a project needs |
| `src/index.ts` | The command |
| `templates/` | The code and Dockerfiles each kind starts from, and `fly.toml` |
