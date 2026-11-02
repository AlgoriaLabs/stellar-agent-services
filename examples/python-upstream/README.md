# Python API behind the gateway

An existing Python API, [app.py](app.py), that knows nothing about payments, sold as a paid Stellar service
with only a config file: [provider.config.json](provider.config.json). This is gateway mode of the
[Provider Kit](../../packages/provider-kit).

| Piece | Role |
| --- | --- |
| `app.py` | The existing API: `POST /summarize` takes `{ "text", "sentences" }`, answers JSON. Python standard library only. |
| `provider.config.json` | The gateway config: price (0.01 USDC, charged on success), schemas, capacity, upstream URL |
| `schemas/` | The input and output JSON Schemas, kept as files |

The gateway publishes the manifest, refuses invalid input before anyone pays, asks for the x402 payment, calls
`app.py` with only the validated input, checks its answer against the output schema, settles, and keeps the job
so a client that lost the response can collect it.

## Run it

From the repository root, after `npm install && npm run build`:

```bash
PUBLIC_ORIGIN=http://localhost:8787 node packages/provider-kit/dist/cli/index.js dev \
  --config examples/python-upstream/provider.config.json --with "python3 examples/python-upstream/app.py"
```

`dev` starts the API on 127.0.0.1:5000, waits until it takes connections, then serves the gateway in front of it.
`PAY_TO` is the public address that receives the USDC. Without one, `dev` makes a throwaway testnet account to be paid
to, whose key is dropped at once; set `PAY_TO=G...` to an account in your own wallet to be paid there instead (see the
[setup guide](../../docs/provider-setup-guide.md)). Then pay it once from another terminal, with its example input:

```bash
node packages/provider-kit/dist/cli/index.js try summarize --manifest http://localhost:8787/.well-known/stellar-agent-services.json
```

It pays from a throwaway testnet account it funds itself, after you approve the exact payment, and shows the summary
and the transfer on chain.

`packages/provider-kit/test/gateway.test.ts` runs this example end to end, with a stand-in facilitator.

## In Docker

Build the image as the [setup guide](../../docs/provider-setup-guide.md) shows. On Docker, the gateway reaches
`app.py` at the host's address rather than `127.0.0.1`, so change `upstream.url` accordingly (for example
`http://host.docker.internal:5000/summarize`) and set `"store": "/data/jobs.sqlite"`.
