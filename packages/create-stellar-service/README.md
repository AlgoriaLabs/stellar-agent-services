# create-stellar-service

`npm create stellar-service` makes a project that sells an AI service on Stellar: agents pay per call in USDC through
x402, under [Provider Standard v1](../../docs/provider-standard.md). The project runs, takes a paid testnet call and
builds a Docker image as it comes.

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
Set up the account clients pay now? A page opens where your wallet approves a USDC trustline on testnet.
[Y/n]:
```

Then it writes the project, installs it, and opens the approval page of `provider-kit trustline`, where your own
wallet (Freighter, xBull, Albedo and others) adds a USDC trustline. The account's address goes in `.env` as `PAY_TO`.
Next: `npm run dev`, then `npm run try` pays for one call with test money, and `npm run check` shows
[how agents see you](../provider-kit/README.md#how-agents-see-you).

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
database on a volume at `/data`, a `README.md`, and these scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the service, or the gateway, at http://localhost:8787 |
| `npm run try` | Pays for one call with test money, from a throwaway testnet account ([`provider-kit try`](../provider-kit/README.md#trying-a-paid-call)) |
| `npm run check` | Checks the provider against the standard and shows how agents see it |
| `npm run wallet` | Sets up the account clients pay, in your wallet |
| `npm start` | Starts it for production: `PUBLIC_ORIGIN` must be your HTTPS origin |
| `npm run register` | Registers it in the Stellar 8004 registry, once deployed (gateway kinds) |

A gateway config reads `baseUrl`, `payTo` and `store` from `.env` (`env:PUBLIC_ORIGIN`, `env:PAY_TO`,
`env:JOB_DB_PATH`), so the same file runs on a laptop and in a container.

## For scripts and coding agents

Flags answer every question. Without a terminal it asks nothing, and `--kind` is needed:

```bash
create-stellar-service captioner --kind wrap --openapi http://127.0.0.1:8000/openapi.json \
  --description "Captions for product photos, in English and Turkish." --no-wallet
```

| Flag | Answers |
| --- | --- |
| `--kind wrap\|typescript\|python` | What to make |
| `--openapi <file \| url>` | The API's OpenAPI document (`wrap`). It is read first, so nothing is written for an API that isn't running. With a file whose servers are relative, `--upstream` is the API's base URL. |
| `--upstream <url>` | Without `--openapi`: the URL a paid call goes to (`wrap`) |
| `--description <text>` | One sentence on what it offers: search matches it and the name |
| `--name <text>` | The provider's name. Default: the folder's, or the document's title. |
| `--wallet`, `--no-wallet`, `--pay-to <G…>` | Set up the payout account now in your wallet, later, or use an address you have |
| `--yes` | Take the defaults for the questions no flag answers |

`--wallet` opens a page in the user's browser, so a coding agent asks the user first. It signs nothing itself.

## Safety

- **No secret key, anywhere.** It never asks for one, makes one or writes one. The payout account is set up in the
  developer's own wallet, on `provider-kit trustline`'s approval page, and only its public address is saved.
- **It never pays.** `npm run try` pays later, when the developer runs it, from a throwaway account with test money.
- **Testnet only.** Every project starts on `stellar:testnet`.
- **Nothing is overwritten.** It refuses a folder that already has files in it.

## Files

| File | Contents |
| --- | --- |
| `src/main.ts` | The questions, the flags, and the run: write, install, the gateway config, the payout account |
| `src/files.ts` | The files each kind writes: `package.json`, `.env`, the README, the Python kind's gateway config, and the templates filled in |
| `src/kit.ts` | Where the Provider Kit comes from: a clone (packed into `vendor/`) or npm, and the npm overrides a project needs |
| `src/index.ts` | The command |
| `templates/` | The code and Dockerfiles each kind starts from |
