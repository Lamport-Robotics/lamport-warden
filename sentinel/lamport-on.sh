#!/usr/bin/env bash
# Switches paying for Pro in LAMPORT on: names Lamport's treasury wallet in the server's settings, then puts
# the service up, then the pages. In that order, so that no page says LAMPORT is taken before it is.
#
#   sentinel/lamport-on.sh <treasury wallet address> [ssh-host]        default host: can
#
# Run it from a checkout of main. It asks the chain first whether the wallet has an account for the token
# (nothing can be paid into a wallet that has none, and a mistyped address is still an address). On the
# server the settings file and the running service are copied aside before anything is changed.
#
# To switch it off again: take the SENTINEL_LAMPORT_PAY_TO line out of /etc/lamport-sentinel.env and
# `systemctl restart lamport-sentinel`. An amount already shown still counts for its ten minutes.
set -euo pipefail
TREASURY="${1:?usage: sentinel/lamport-on.sh <treasury wallet address> [ssh-host]}"
HOST="${2:-can}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MINT="D4CzGsZgusVj2K8R1its5H8WWdo9mazbDwBc6qvsmfun"   # LAMPORT_MINT in sentinel/service/src/main.ts

[[ "$TREASURY" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "that is not a wallet address: $TREASURY" >&2; exit 1; }

# the wallet's own account for the token, as the chain has it
answer="$(curl -fsS --max-time 20 https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTokenAccountsByOwner\",\"params\":[\"$TREASURY\",{\"mint\":\"$MINT\"},{\"encoding\":\"jsonParsed\"}]}")" \
  || { echo "the chain could not be asked about that wallet: nothing was changed" >&2; exit 1; }
account="$(printf '%s' "$answer" | sed -n 's/.*"pubkey":"\([1-9A-HJ-NP-Za-km-z]*\)".*/\1/p' | head -1)"
[ -n "$account" ] || { echo "that wallet has no account for LAMPORT on the chain: nothing was changed. (Is the address right?)" >&2; exit 1; }
echo "the treasury's LAMPORT account: $account"

ssh -o BatchMode=yes "$HOST" "TREASURY='$TREASURY' bash -s" <<'REMOTE'
set -euo pipefail
ENV=/etc/lamport-sentinel.env
STAMP="$(date +%Y%m%d-%H%M%S)"
grep -q '^SENTINEL_PAY_TO=' "$ENV" || { echo "SENTINEL_PAY_TO is not set there: paying in LAMPORT is one of the ways of paying ahead, and needs it. Nothing was changed." >&2; exit 1; }
cp -p "$ENV" "$ENV.bak-lamport-$STAMP"
cp -p /opt/lamport-sentinel/sentinel.mjs "/opt/lamport-sentinel/sentinel.mjs.bak-pre-lamport-$STAMP"
if grep -q '^SENTINEL_LAMPORT_PAY_TO=' "$ENV"; then
  sed -i "s|^SENTINEL_LAMPORT_PAY_TO=.*|SENTINEL_LAMPORT_PAY_TO=$TREASURY|" "$ENV"
else
  printf '%s\n' "SENTINEL_LAMPORT_PAY_TO=$TREASURY" >> "$ENV"
fi
chmod 600 "$ENV"
echo "settings: $(grep '^SENTINEL_LAMPORT_PAY_TO=' "$ENV")   (the file as it was: $ENV.bak-lamport-$STAMP)"
REMOTE

# the service first (it restarts with the new setting), then the pages that say LAMPORT is taken
"$HERE/deploy.sh" "$HOST"
"$HERE/../site/deploy.sh" "$HOST"

echo "--- is it on"
ssh -o BatchMode=yes "$HOST" 'systemctl is-active lamport-sentinel.service && journalctl -u lamport-sentinel.service -n 5 --no-pager -o cat | cut -c1-200'
echo "Open https://warden.lamportrobotics.com/sentinel/ signed in: LAMPORT is in the list beside USDC and SOL, and the first real payment is the test."
