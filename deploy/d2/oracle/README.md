# Oracle testnet sample

Runs the sample beside Logo Maker on the existing Oracle Ampere A1 VM. It uses a separate user, localhost
port 8789 and SQLite directory, capped at 384 MiB and 25% of one CPU. The deployment creates no VM, volume or
networking resource. Oracle Always Free limits apply to the tenancy's total usage; reusing the VM adds no
compute allocation. See [Oracle's limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

| File | Purpose |
| --- | --- |
| `stellar-sas-testnet.service` | Dedicated testnet process and persistent data directory |
| `install.sh` | Verifies the release, installs production dependencies, starts the process and gracefully adds HTTPS |
| `../../../scripts/oracle-testnet-bundle.mjs` | Explicit allowlist of compiled code, schemas and locked npm metadata |

Build the checkout with Node 24, then create a new output directory:

```bash
npm run build
node scripts/oracle-testnet-bundle.mjs /tmp/sas-oracle-release
```

Upload `release.tgz` as `/tmp/stellar-sas-testnet-release.tgz` and the service file as
`/tmp/stellar-sas-testnet.service`. Run `install.sh` over the operator's pinned SSH connection, with its release
id, exact archive SHA-256, hostname, public testnet payout and optional registered testnet agent id. The script
accepts only the testnet hostname pattern and always writes `stellar:testnet` into its public environment.
Never upload a Stellar key or the operator's OCI credentials.

The Caddy wrapper imports the existing `/etc/caddy/Caddyfile` unchanged, followed by the testnet site. A small
systemd override makes future mainnet deploys and reboots load both. Validation happens before a graceful reload;
if reload fails, the previous unit is restored. No mainnet provider restart is needed.

To remove the testnet route, stop and disable only `stellar-sas-testnet`, remove the managed Caddy drop-in,
run `systemctl daemon-reload` and gracefully reload Caddy. Preserve `/var/lib/stellar-sas-testnet/jobs.sqlite`
for paid-job recovery. The original mainnet Caddyfile and `/opt/logo-agent` are not changed by this installer.

## Running deployment

- Manifest: https://sas-testnet.79-76-99-174.sslip.io/.well-known/stellar-agent-services.json
- Health: https://sas-testnet.79-76-99-174.sslip.io/healthz
- Testnet agent: 163; payout `GBQXS5ZRH5AXDFEMKUNHPJ3VBEOYNKZEYF3TFIVFBULBLIBPSW5ACUZ3`.
- Release: `35f1280de789-a6b3db6f300c`, built from commit `35f1280de789` plus the documented working changes.
- Service: `stellar-sas-testnet`; data `/var/lib/stellar-sas-testnet/jobs.sqlite`.
- Public settings: `/etc/stellar-sas-testnet/public.env`; no signing keys on the server.
- Validation signer: local Stellar CLI secure storage, separate from the provider owner and disposable test payer.
- [Receipt, registry and transfer evidence](../../../evidence/validation/README.md).

Inspect `systemctl status stellar-sas-testnet` and `journalctl -u stellar-sas-testnet` over the pinned SSH
connection. Back up SQLite with its online backup facility before updates; do not copy only the live database
while its WAL may contain data. Keep the origin, public payout, agent id and job database unchanged when
replacing code, so paid jobs remain recoverable. The provider starts automatically after reboot.
