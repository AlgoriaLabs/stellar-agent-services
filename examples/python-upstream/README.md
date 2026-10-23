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
python3 examples/python-upstream/app.py &          # the API, on 127.0.0.1:5000

PUBLIC_ORIGIN=http://localhost:8787 PAY_TO=G... \
  node packages/provider-kit/dist/cli/index.js serve --config examples/python-upstream/provider.config.json --dev
```

`PAY_TO` is the public address that receives the USDC; it needs a USDC trustline (see the
[setup guide](../../docs/provider-setup-guide.md)). Then pay it from another terminal:

```bash
MANIFEST=http://localhost:8787/.well-known/stellar-agent-services.json
npx stellar-pay pay $MANIFEST summarize '{"text":"Stellar settles in seconds. Fees are tiny.","sentences":1}' --dev
```

`packages/provider-kit/test/gateway.test.ts` runs this example end to end, with a stand-in facilitator.

## In Docker

Build the image as the [setup guide](../../docs/provider-setup-guide.md) shows. On Docker, the gateway reaches
`app.py` at the host's address rather than `127.0.0.1`, so change `upstream.url` accordingly (for example
`http://host.docker.internal:5000/summarize`) and set `"store": "/data/jobs.sqlite"`.
