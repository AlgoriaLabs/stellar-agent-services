# Security

These boundaries apply to every package in this repository.

1. **Discovery holds no keys.** `stellar-agent-search` stays read-only and keyless. It may import only the
   dependency-free `protocol` package.
2. **Provider runtimes hold no keys.** A provider server knows only its `payTo` public address. Owner
   operations are signed in the owner's own wallet, on an approval page the CLI serves on 127.0.0.1 behind a
   one-time token, or with `--source` through the Stellar CLI keychain; never through environment variables. The
   CLI checks that a signed transaction is the one it built before sending it. In gateway mode, the only
   credential is the upstream API's own key, if it has one, and never a Stellar secret key.
3. **Only the payment client signs payments**, once per approved job, after the user approves the exact
   price, recipient, asset and network.
4. **Never pay twice.** The job identity is fixed before payment. Recovery never re-sends a payment
   credential, and an uncertain settlement is never re-charged.
5. **Fail closed.** Unknown or unverifiable states stop the flow.
6. **One network per flow.** Testnet and mainnet are never mixed in one run.

To report a vulnerability, contact the maintainers privately rather than opening a public issue.
