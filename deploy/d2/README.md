# D2 sample deployment

Prepared for the sample's live identity and verification evidence. This is a deployment configuration, not
evidence of a deployed or registered service. The existing D1/D2 throwaway payout account cannot register:
its private key was intentionally discarded. Use an owner-controlled wallet instead [I3].

The owner supplied `GDZTNESUUP2YODFWW5TIOVV2PN43JTJFIEZ7ML4JC2VCHOXWNSTV44SC`; its testnet USDC trustline
was confirmed. The dedicated validator is `GB5PKQ7G64QCV6D2X3CZSQZYIMWHL2URBBAVO3Z5T4WA6IL3J7BEVH22`,
funded on testnet and held by Stellar CLI alias `sas-d2-validator-20261106` in macOS Keychain (`--secure-store`).
Its secret was neither written to a file nor displayed. It is operated for this project, not an independent auditor.

Fly login and configuration validation succeeded. The operator still needs to enable deployment in their Fly
account. The candidate app name is not reserved and no machine or volume was created. The container build
could not be checked while Docker was stopped.

| File | Purpose |
| --- | --- |
| `sample.Dockerfile` | Builds this checkout's sample with Node 24; no provider signing key |
| `fly.toml` | Candidate stable HTTPS origin and a persistent SQLite volume |

Run commands from the repository root. Fly login is already established; reserve an available app name.
The candidate is `sas-d2-sample-berkin`. If changed, update both `app` and `PUBLIC_ORIGIN` in `fly.toml`.
Fly hosting uses the operator's account and may incur hosting charges.

Use the provider launch approval page with that stable origin and the chosen validator's public address:

```bash
node packages/provider-kit/dist/cli/index.js launch \
  --start 'node examples/paid-service/dist/server.js' \
  --url https://sas-d2-sample-berkin.fly.dev \
  --validator GB5PKQ7G64QCV6D2X3CZSQZYIMWHL2URBBAVO3Z5T4WA6IL3J7BEVH22 \
  --no-deploy --no-wait --no-open
```

The owner connects their wallet and signs the USDC trustline, identity registration and validation request.
Set the supplied owner `PAY_TO` in the command's environment before launch. Launch saves only public `PAY_TO`
and `AGENT_ID` settings in the local `.env`. `PAY_TO` is already in the Fly configuration; put the resulting
`AGENT_ID` under `[env]` too. Do not copy `DEV_PAY_TO` or the earlier disposable payout address.

```bash
fly apps create sas-d2-sample-berkin
fly deploy --config deploy/d2/fly.toml --ha=false
node packages/provider-kit/dist/cli/index.js check \
  --manifest https://sas-d2-sample-berkin.fly.dev/.well-known/stellar-agent-services.json
node packages/verifier/dist/cli/index.js check \
  https://sas-d2-sample-berkin.fly.dev/.well-known/stellar-agent-services.json
```

Keep one provider machine: SQLite owns one volume. The container drops to `node` after fixing the mount's owner.
Leave `DRILL_LOSE_RESPONSE` unset on the deployed provider; the deliberate interruption was recorded separately.

The validator then runs the paid verification, publishes its canonical receipt at a stable HTTPS URL and
answers the saved validation request through their Stellar CLI keychain. See
[verification](../../docs/verification.md) and [the registry checklist](../../evidence/validation/README.md).
The verifier payer is a separate account, never the provider owner or validator. No validator or payer secret
is put in the provider container.

For this machine, Stellar CLI 30.0.1 was downloaded from the official release into
`/private/tmp/stellar-d2-tools/stellar`. Add that directory to `PATH` before `verifier publish --source
sas-d2-validator-20261106 --network testnet`, or install the official CLI normally. The alias's secure-store
reference is in the user's standard Stellar CLI configuration directory; it contains no plaintext secret.
The temporary test payers are discarded, not reused for the final registered-provider verification.

The public evidence site can be built separately, with only checksum-listed artifacts:

```bash
node scripts/evidence-site.mjs /tmp/stellar-evidence-site
```

The target directory must be empty. The builder checks all copied checksums and local HTML links; it never
copies `.env`, keys, databases or journals. The Pages branch contains evidence only, separately from a release.
