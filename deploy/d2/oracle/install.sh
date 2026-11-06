#!/usr/bin/env bash
# Installs the testnet sample on an existing Oracle VM; allocates no cloud resources and preserves the mainnet route.
set -euo pipefail
release_id=${1:?release id}
archive_sha=${2:?archive sha256}
testnet_host=${3:?testnet hostname}
pay_to=${4:?public testnet payout}
agent_id=${5:-}
[[ "$release_id" =~ ^[a-f0-9]{12}-[a-f0-9]{12}$ ]]
[[ "$archive_sha" =~ ^[a-f0-9]{64}$ ]]
[[ "$testnet_host" =~ ^sas-testnet\.[0-9-]+\.sslip\.io$ ]]
[[ "$pay_to" =~ ^G[A-Z2-7]{55}$ ]]
[[ -z "$agent_id" || "$agent_id" =~ ^[0-9]+$ ]]
archive=/tmp/stellar-sas-testnet-release.tgz
[[ $(sha256sum "$archive" | cut -d' ' -f1) == "$archive_sha" ]]
app=/opt/stellar-sas-testnet
release="$app/releases/$release_id"
data=/var/lib/stellar-sas-testnet
config=/etc/stellar-sas-testnet
backup=/var/backups/stellar-sas-testnet
mkdir -p "$app/releases" "$config" "$backup"
if ! id sas-testnet >/dev/null 2>&1; then useradd --system --user-group --create-home --home-dir "$data" --shell /usr/sbin/nologin sas-testnet; fi
install -d -m 0750 -o sas-testnet -g sas-testnet "$data"
if [[ ! -f "$release/.installed" ]]; then
 mkdir -p "$release"
 tar -xzf "$archive" --no-same-owner -C "$release"
 chown -R sas-testnet:sas-testnet "$release"
 (cd "$release" && sudo -u sas-testnet npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$data/npm-cache")
 touch "$release/.installed"
 chown -R root:root "$release"
fi
cat > "$config/public.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8789
STELLAR_NETWORK=stellar:testnet
PUBLIC_ORIGIN=https://$testnet_host
PAY_TO=$pay_to
AGENT_ID=$agent_id
FACILITATOR_URL=https://x402.org/facilitator
JOB_DB_PATH=$data/jobs.sqlite
EOF
chown root:sas-testnet "$config/public.env"
chmod 0640 "$config/public.env"
ln -sfn "$release" "$app/current"
install -m 0644 /tmp/stellar-sas-testnet.service /etc/systemd/system/stellar-sas-testnet.service
systemctl daemon-reload
systemctl enable stellar-sas-testnet
systemctl restart stellar-sas-testnet
for i in $(seq 1 20); do
 if curl -fsS http://127.0.0.1:8789/healthz >/dev/null 2>&1; then break; fi
 if [[ "$i" == 20 ]]; then journalctl -u stellar-sas-testnet -n 15 --no-pager; exit 1; fi
 sleep 2
done

# Import the original file through a wrapper. Future Logo Maker deploys can still replace their own Caddyfile.
# A graceful reload adopts both routes now; the drop-in preserves both on a reboot or a future reload.
install -d -m 0755 /etc/caddy/stellar-sas /etc/systemd/system/caddy.service.d
if [[ -e /etc/systemd/system/caddy.service.d/stellar-sas.conf ]] && ! grep -q 'Managed by stellar-agent-services' /etc/systemd/system/caddy.service.d/stellar-sas.conf; then
 echo 'Refusing to overwrite an unrelated Caddy override.' >&2; exit 1
fi
cat > /etc/caddy/stellar-sas/testnet.caddy <<EOF
# Managed by stellar-agent-services: separate testnet origin.
$testnet_host {
 encode gzip
 reverse_proxy 127.0.0.1:8789
}
EOF
cat > /etc/caddy/stellar-sas-root.Caddyfile <<'EOF'
# Managed by stellar-agent-services; preserves the existing mainnet configuration verbatim.
import /etc/caddy/Caddyfile
import /etc/caddy/stellar-sas/*.caddy
EOF
caddy validate --config /etc/caddy/stellar-sas-root.Caddyfile --adapter caddyfile
if [[ -e /etc/systemd/system/caddy.service.d/stellar-sas.conf ]]; then cp /etc/systemd/system/caddy.service.d/stellar-sas.conf "$backup/caddy-override.previous"; fi
cat > /etc/systemd/system/caddy.service.d/stellar-sas.conf <<'EOF'
# Managed by stellar-agent-services.
[Service]
ExecStart=
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/stellar-sas-root.Caddyfile
ExecReload=
ExecReload=/usr/bin/caddy reload --config /etc/caddy/stellar-sas-root.Caddyfile --force
EOF
systemctl daemon-reload
if ! systemctl reload caddy; then
 if [[ -f "$backup/caddy-override.previous" ]]; then cp "$backup/caddy-override.previous" /etc/systemd/system/caddy.service.d/stellar-sas.conf;
 else rm /etc/systemd/system/caddy.service.d/stellar-sas.conf; fi
 systemctl daemon-reload
 systemctl reload caddy || true
 echo 'Testnet routing was not adopted; restored the previous Caddy unit.' >&2
 exit 1
fi
curl -fsS http://127.0.0.1:8787/healthz >/dev/null
echo "Testnet service installed: https://$testnet_host"
systemctl is-active logo-agent caddy stellar-sas-testnet
