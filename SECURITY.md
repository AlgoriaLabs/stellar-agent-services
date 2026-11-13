# Security

These boundaries apply to every package in this repository.

1. **Discovery holds no keys.** `stellar-agent-search` stays read-only and keyless. It may import only the
   dependency-free `protocol` package.
2. **Provider runtimes hold no keys.** A provider server knows only its `payTo` public address. Owner
   operations are signed in the owner's own wallet, on an approval page the CLI serves on 127.0.0.1 behind a
   one-time token, or with `--source` through the Stellar CLI keychain; never through environment variables. The
   CLI checks that a signed transaction is the one it built before sending it. In gateway mode, the only
   credential is the upstream API's own key, if it has one, and never a Stellar secret key. The only keys the CLI
   makes are throwaway testnet ones, held in memory and never written: `provider-kit try`'s payer, and the payout
   account `provider-kit dev` makes while `PAY_TO` is empty. That key signs the account's USDC trustline and is
   dropped; the provider gets only the public address.
   **The local wallet is the one exception, and only when asked for** (`--local-wallet`): the CLI then makes the
   owner's account itself and signs the owner's steps with it, so the developer needs no wallet app. Its key is
   kept in the OS keychain (macOS Keychain, Linux Secret Service), or where there is none in a file only the user
   can read, in provider-kit's own directory outside every project. It is never written to the project, a `.env`
   file, the environment or a log, and never printed, except by `provider-kit wallet export`, which runs only for
   a person at a terminal. The provider runtime still gets only the public address. Every transaction goes through
   the same checks as one signed in a wallet app, and money leaves the wallet only with `provider-kit wallet
   withdraw`, which names the network and the payment and asks first. As with any key kept on a computer, it is
   not protected from other programs that run as the same user.
3. **Only the payment client signs payments**, once per approved job, after the user approves the exact
   price, recipient, asset and network.
4. **Never pay twice.** The job identity is fixed before payment. Recovery never re-sends a payment
   credential, and an uncertain settlement is never re-charged.
5. **Fail closed.** Unknown or unverifiable states stop the flow.
6. **One network per flow.** Testnet and mainnet are never mixed in one run.

To report a vulnerability, contact the maintainers privately rather than opening a public issue.
