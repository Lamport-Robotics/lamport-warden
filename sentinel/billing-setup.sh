#!/bin/sh
# Sets up the paid plan for the deployed Sentinel service, in the LIVE Stripe account whose key the server
# already holds. Run it yourself: it makes things in a real Stripe account.
#
#   sentinel/billing-setup.sh [ssh-host]        (default host: can)
#
# What it does, all of it on the server, each step safe to repeat:
#   1. makes (or finds) the Stripe product, the two monthly prices, the customer portal and the webhook
#      (scripts/stripe-sentinel-setup.mjs);
#   2. writes the Stripe settings into /etc/lamport-sentinel.env (root only). The key and the webhook's
#      signing secret never leave the server and are never printed;
#   3. restarts the service and checks that it now knows the plan and believes a webhook signed with that
#      secret.
#
# It does NOT open checkout. Nothing is sold until SENTINEL_CHECKOUT=open is added to that file and the
# service is restarted:
#
#   ssh can 'echo SENTINEL_CHECKOUT=open >> /etc/lamport-sentinel.env && systemctl restart lamport-sentinel'
set -eu
HOST="${1:-can}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

scp -q "$ROOT/scripts/stripe-sentinel-setup.mjs" "$HOST:/opt/lamport-sentinel/stripe-sentinel-setup.mjs"
ssh "$HOST" sh -s <<'REMOTE'
set -eu
umask 077
ENV=/etc/lamport-sentinel.env
HOOK=/etc/lamport-sentinel.webhook
IDS=/root/.sentinel-stripe-ids
LOG=/root/.sentinel-stripe-log
hide() { sed -E 's/(sk|rk|whsec)_[A-Za-z0-9_]+/[secret]/g'; }

[ -f "$ENV" ] || { echo "the service is not deployed yet: run sentinel/deploy.sh first" >&2; exit 1; }
KEY=$(grep '^STRIPE_SECRET_KEY=' /etc/lamportrobotics.env | head -1 | cut -d= -f2- | tr -d "\"' \r")
case "$KEY" in
  rk_live_*|sk_live_*) echo "using the live Stripe key the server already holds" ;;
  *) echo "no live Stripe key in /etc/lamportrobotics.env" >&2; exit 1 ;;
esac

if STRIPE_SECRET_KEY="$KEY" node /opt/lamport-sentinel/stripe-sentinel-setup.mjs --webhook https://warden.lamportrobotics.com/sentinel/api/v1/stripe/webhook --secret-out "$HOOK.new" > "$IDS" 2> "$LOG"; then
  hide < "$LOG"
else
  echo "Stripe refused something. Its message:" >&2
  hide < "$LOG" >&2
  echo "If it says the key lacks permission, the restricted key needs write access to Products, Prices, Checkout Sessions, Subscriptions, Customer portal and Webhook Endpoints." >&2
  exit 1
fi
# Stripe shows a webhook's secret once, when the webhook is made. On a second run the one from the first is kept.
if [ -s "$HOOK.new" ]; then mv "$HOOK.new" "$HOOK"; else rm -f "$HOOK.new"; fi
[ -s "$HOOK" ] || { echo "the webhook exists but its signing secret is not on this server. In the Stripe dashboard, open that webhook, reveal the signing secret, and put it in $HOOK (one line), then run this again." >&2; exit 1; }
chmod 600 "$HOOK"

# the service's settings: the old Stripe lines out, the new ones in, checkout left as it was
grep -v -E '^SENTINEL_STRIPE_(SECRET_KEY|WEBHOOK_SECRET|PRICE_FULL|PRICE_HOLDER|PORTAL_CONFIG)=' "$ENV" > "$ENV.new"
{
  echo "SENTINEL_STRIPE_SECRET_KEY=$KEY"
  echo "SENTINEL_STRIPE_WEBHOOK_SECRET=$(cat "$HOOK")"
  cat "$IDS"
} >> "$ENV.new"
chmod 600 "$ENV.new"
mv "$ENV.new" "$ENV"

systemctl restart lamport-sentinel.service
sleep 3
systemctl is-active lamport-sentinel.service
journalctl -u lamport-sentinel --no-pager -n 1 | sed -E 's/^.*sentinel: /sentinel: /'

# does the service believe a webhook signed with that secret? A harmless event it ignores, signed here.
node -e '
const { createHmac } = require("node:crypto");
const secret = require("node:fs").readFileSync(process.argv[1], "utf8").trim();
const body = JSON.stringify({ type: "billing.setup.check", data: { object: {} } });
const t = Math.floor(Date.now() / 1000);
const sign = (s) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${body}`).digest("hex")}`;
const post = (sig) => fetch("http://127.0.0.1:8791/v1/stripe/webhook", { method: "POST", headers: { "stripe-signature": sig }, body }).then((r) => r.status);
Promise.all([post(sign(secret)), post(sign("whsec_wrong"))]).then(([good, bad]) => {
  console.log(good === 200 && bad === 400 ? "webhook: a correctly signed event is accepted and a wrongly signed one is refused" : `webhook check FAILED (signed: ${good}, wrongly signed: ${bad})`);
  process.exit(good === 200 && bad === 400 ? 0 : 1);
});
' "$HOOK"
echo "the prices in Stripe:"; cat "$IDS"
if grep -q '^SENTINEL_CHECKOUT=open' "$ENV"; then echo "checkout is OPEN: the plan is on sale"; else echo "checkout is closed: nothing is sold until SENTINEL_CHECKOUT=open is set"; fi
REMOTE
