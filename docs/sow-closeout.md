# SOW closeout and pilot handoff

Reviewed on 2026-11-06 against the [source SOW](https://docs.google.com/document/d/1kIJ5nkwIVaXqHqcNHwuI5JN0Ap6g86wzncMQya6Kv88/edit)
and this checkout. The [implementation plan](../IMPLEMENTATION_PLAN.md) records the build; this page records the
remaining acceptance work. Prepared templates are not evidence of completed pilot work.

## Readiness

| Area | Available | Still needed for SOW acceptance |
| --- | --- | --- |
| D1 | Standard, client, spending controls, publicly hosted approval/limit-block video, screenshots and payment proof | Chapter Lead review |
| D2 | Kit, guide, C1–C7 verifier, live unanchored receipts/badges, publicly hosted recovery and transfer proof | Permanent sample deployment/registration, fresh verification, live validation request/response |
| D3 | Scaffolder and onboarding guide | Independent integrations, user flows, findings/fixes, pilot report and public evidence page |
| Distribution | Six npm packages at 0.1.0 and a successful public release | A later release for the changes in this checkout |
| Discovery | Newer implementation notes report testnet registry scanning and manifest service matching | Confirm the released discovery path in the pilot and show the complete find-to-result flow |

Public release and CI references, and local check results, belong in [readiness evidence](../evidence/readiness.md).
The latest observed daily live workflow failed its paid testnet call; do not treat ordinary CI as a live payment
proof. A trusted registry/risk-source adapter remains application integration work; configured verification limits
now block new payments unless a trusted source can satisfy them [V1].

## Acceptance decisions for the owner

The source SOW conflicts: D3 says three independent providers and five users, while the objective and evidence
section say two providers and two users; its exclusions cap providers at two. The working target is the sample
plus two independent providers, and five distinct pilot users. This interpretation still needs Chapter Lead
agreement. Five flows by one person do not establish five users.

Also confirm that testnet evidence is accepted. Record the agreement and sprint start date in the pilot report;
the SOW's submission date does not establish the sprint deadline.

## Prepare the testnet deployment

Use Node 24, a stable HTTPS provider origin, a separate stable HTTPS verifier origin, a persistent job volume and
a persistent verifier data volume. The provider and verifier are separate processes. Keep their URLs stable:
registration names the manifest, and validation records name the receipt URL.

1. The [D2 sample deployment bundle](../deploy/d2/README.md) is prepared for this checkout, with a stable Fly
   origin candidate and persistent storage. The supplied public payout address already has its testnet USDC
   trustline. Fly login succeeded; the operator still needs to enable deployment in their Fly account.
   No sample app or volume was created. Its Dockerfile remains unverified because the Docker daemon was unavailable.
   Alternatively, follow the [setup guide](provider-setup-guide.md) to create a testnet project. The generated Dockerfile and
   `fly.toml` already describe the provider deployment. For unreleased code, build this checkout and invoke
   `node packages/create-stellar-service/dist/index.js` instead of the npm release.
2. Use the owner's public payout address and wallet for owner transactions. Provider configuration contains
   public values only: `PAY_TO`, `AGENT_ID`, origin, testnet network, facilitator and database path. Use the
   [sample service](../examples/paid-service/README.md) for the delayed-report recovery demonstration.
3. The verifier operator prepares a separate Stellar CLI keychain identity and a dedicated testnet payer through
   their existing credential manager. The payer environment variable is `VERIFIER_PAYER_SECRET`. Neither the
   provider owner's key nor the validator's key is placed in the provider environment.
4. On the verifier host, after installing the released verifier, use this command with the chosen HTTPS origin
   and keychain identity. `watch` makes paid testnet checks and publishes registry responses: the operator must
   authorize and provision those actions before starting it.

```bash
verifier watch --network testnet --source verifier \
  --public-url https://verifier.example.com --port 8080 \
  --data /var/lib/stellar-verifier --max-price 0.10 --max-spend 1.00
```

`--max-spend` is a per-verification-run limit, not a lifetime or daily cap. Terminate TLS at the host's reverse
proxy, preserve `/var/lib/stellar-verifier`, and check `/healthz`. Start one watcher per validator identity.
Provide the validator's public address explicitly to provider launch; there is no default validator configured.

5. In the provider project, review the launch plan, then let the owner approve registration and validation in
   their wallet. Replace both example values first. The second command may deploy and submits owner-approved
   transactions; it is a later operator step, not part of the unattended repository checks.

```bash
npm run launch -- --url https://provider.example.com --validator G... --dry-run --no-open
npm run launch -- --url https://provider.example.com --validator G... --no-open
npm run status -- --json
```

For other hosts use `--no-deploy` and deploy with the saved public settings. Wait for the provider manifest and
verifier health check before asking a pilot user to pay. Run `provider-kit check` and `verifier check` against
the public manifest. A passing unpaid check alone does not prove C4 or C5.

## Collect the reference evidence

1. **D1 captured:** review [the video, screenshots and RPC proof](../evidence/d1/README.md). They show a rejected
   over-budget payment, then the exact terms, approval, result and confirmed transfer of an allowed payment.
2. **D2:** review [the captured live receipts and badges](../evidence/receipts/README.md), including failed and
   skipped checks. They describe an unregistered temporary HTTPS endpoint, so none is an anchored registry record.
   After permanent deployment and registration, run verification again. Retain the identity registration,
   validation request and response references and receipt hash. Follow [the registry checklist](../evidence/validation/README.md).
3. **Recovery captured:** review [the drill recording and RPC proof](../evidence/d2/README.md): lost response,
   recovery of the same job and exactly one matching transfer in the complete observed ledger window [J11], [J13], [J16].
4. The [public evidence page](https://algorialabs.github.io/stellar-agent-services/) serves the recordings and
   proofs, with anonymous downloads checked against SHA-256. Its source is the separate `codex/d2-evidence`
   branch, not an npm release. Add the final registry records there once confirmed.

## Run the independent pilot

Use [the pilot checklist](../evidence/pilot/README.md) and [report template](../evidence/pilot/report.md). Recruit
providers who control their own code, payout wallet and deployment. Have them follow the guide from a clean
environment; record assistance and blockers. Each provider needs a real paid testnet service call and its own
linked evidence. Capture discovery, approval, payment and result for each user; at least one demonstrates recovery.

Resolve blocking issues, retain before/after observations and rerun only affected flows. Submit the evidence index
with completed videos, receipts, transaction references, registry records and report, then request Chapter Lead
acceptance against SOW §6.2.
