#!/bin/sh
# Looks at the Sentinel service from beside it. A systemd timer runs this every five minutes on the server.
#
# systemd starts the service again when it dies. What systemd cannot see is a service that is up and no
# longer watching: the API answers and the round of reading wallets has stalled. This asks the service's own
# health address the same question the check from outside asks (scripts/check-live.mjs), and when the answer
# is "not watching", twice, half a minute apart, it starts the service again and tells whoever runs it.
#
# It does nothing when the service answers and cannot read the chain: that is the RPC's trouble, the service
# says so itself, and starting it again would not help.
#
# It is on the same machine, so it cannot say that the machine is gone. That is what the check from outside
# is for.
set -u
URL="${SENTINEL_HEALTH_URL:-http://127.0.0.1:8791/v1/health}"
ENV_FILE="${SENTINEL_ENV_FILE:-/etc/lamport-sentinel.env}"
CHECK="${SENTINEL_CHECK:-/opt/lamport-sentinel/check-live.mjs}"
STAMP="${SENTINEL_WATCH_STAMP:-/run/lamport-sentinel-watch.told}"
UNIT="${SENTINEL_UNIT:-lamport-sentinel.service}"
AGAIN_AFTER="${SENTINEL_WATCH_AGAIN_AFTER:-30}"

look() { out=$(node "$CHECK" "$URL" ${SENTINEL_CHECK_ARGS:-} 2>&1); code=$?; }

look
[ "$code" -eq 0 ] && exit 0
# 3: it answers, and cannot read any wallet
[ "$code" -eq 3 ] && { echo "watchdog: $out (not restarted: the RPC is the trouble)"; exit 0; }
# once is a service that has only just started, or one slow answer: look again before doing anything
sleep "$AGAIN_AFTER"
look
[ "$code" -eq 0 ] && exit 0
[ "$code" -eq 3 ] && exit 0

echo "watchdog: $out"
systemctl restart "$UNIT"
echo "watchdog: started $UNIT again"

# Tell whoever runs it: once an hour at most, and only on an ntfy channel, which takes a plain line.
now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
[ $((now - last)) -lt 3600 ] && exit 0
channel=$(grep '^SENTINEL_OPS_CHANNEL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
case "$channel" in
  https://discord.com/*|https://discordapp.com/*|https://hooks.slack.com/*) ;;
  https://*/*)
    if curl -fsS -m 10 -H "Title: Warden Sentinel: operations" -d "The watchdog beside Sentinel found it not watching, twice, and started it again. What it found: $out" "$channel" >/dev/null 2>&1; then
      echo "$now" > "$STAMP"
    fi
    ;;
esac
exit 0
