#!/bin/sh
# Puts the Sentinel service and its page on the server that serves warden.lamportrobotics.com.
#
#   sentinel/deploy.sh [ssh-host]        (default host: can)
#
# What it does, each step safe to repeat:
#   - builds the service (one file) and the page here, starts the built service once to see that it stays
#     up, and copies them over;
#   - the first time, writes /etc/lamport-sentinel.env (root only) with a data key made on the server (the
#     only other copy is the one sentinel/backup.sh puts in a keychain), and installs a systemd unit that
#     runs the service as a user of its own with nothing to read but its own folder;
#   - the first time, adds one route to the web server (/sentinel/api/ -> the service), after a backup and a
#     check of the new configuration;
#   - installs a watchdog beside it: a timer that asks every five minutes whether it is still watching, and
#     starts it again when it is not;
#   - restarts the service and asks it how it is.
#
# It does not touch the paid plan: Stripe's settings go into the env file by hand (see the service's README).
set -eu
HOST="${1:-can}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/build-service.mjs
# the built file is started here first: one that does not stay up never reaches the server
node scripts/smoke-service.mjs
node scripts/build-web.mjs

ssh "$HOST" 'mkdir -p /opt/lamport-sentinel /opt/lamportrobotics/warden/sentinel'
scp -q sentinel/service/dist/sentinel.mjs "$HOST:/opt/lamport-sentinel/sentinel.mjs.new"
# the watchdog that runs beside the service, and the check it shares with the one that is run from outside
scp -q scripts/check-live.mjs sentinel/watchdog.sh "$HOST:/opt/lamport-sentinel/"
scp -q sentinel/web/dist/index.html sentinel/web/dist/sentinel.css sentinel/web/dist/app.js "$HOST:/opt/lamportrobotics/warden/sentinel/"

ssh "$HOST" sh -s <<'REMOTE'
set -eu
ENV=/etc/lamport-sentinel.env
UNIT=/etc/systemd/system/lamport-sentinel.service
CADDY=/etc/caddy/Caddyfile

chmod 644 /opt/lamportrobotics/warden/sentinel/*
mv /opt/lamport-sentinel/sentinel.mjs.new /opt/lamport-sentinel/sentinel.mjs
chmod 644 /opt/lamport-sentinel/sentinel.mjs

if [ ! -f "$ENV" ]; then
  umask 077
  {
    echo "SENTINEL_RPC_URL=https://api.mainnet-beta.solana.com"
    echo "SENTINEL_DATA_KEY=$(openssl rand -base64 32)"
    echo "SENTINEL_DATA_DIR=/var/lib/lamport-sentinel"
    echo "SENTINEL_ORIGIN=https://warden.lamportrobotics.com"
    echo "SENTINEL_PORT=8791"
    echo "SENTINEL_POLL_SECONDS=60"
    echo "SENTINEL_MAX_WALLETS=100"
    echo "SENTINEL_TRUST_PROXY=1"
  } > "$ENV"
  chmod 600 "$ENV"
  echo "wrote $ENV (new data key)"
fi

cat > "$UNIT" <<'UNITFILE'
[Unit]
Description=Warden Sentinel (watcher and API)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/lamport-sentinel/sentinel.mjs
EnvironmentFile=/etc/lamport-sentinel.env
# a user of its own, made by systemd, with one folder to write in
DynamicUser=yes
StateDirectory=lamport-sentinel
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=512M
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE

# The watchdog: every five minutes, is the service still watching? systemd starts a service that dies again;
# this starts one again that is up and has stopped reading (sentinel/watchdog.sh says the rest).
chmod 755 /opt/lamport-sentinel/watchdog.sh
chmod 644 /opt/lamport-sentinel/check-live.mjs
cat > /etc/systemd/system/lamport-sentinel-watch.service <<'WATCHUNIT'
[Unit]
Description=Warden Sentinel watchdog: is it still watching?

[Service]
Type=oneshot
ExecStart=/bin/sh /opt/lamport-sentinel/watchdog.sh
WATCHUNIT
cat > /etc/systemd/system/lamport-sentinel-watch.timer <<'WATCHTIMER'
[Unit]
Description=Looks at Warden Sentinel every five minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
WATCHTIMER
systemctl daemon-reload
systemctl enable -q lamport-sentinel.service
systemctl enable -q --now lamport-sentinel-watch.timer

if ! grep -q "handle_path /sentinel/api/\*" "$CADDY"; then
  cp -p "$CADDY" "$CADDY.bak-sentinel-$(date +%Y%m%d-%H%M%S)"
  # inside the warden site, before its catch-all: the API goes to the service, everything else stays files
  awk '
    /^warden\.lamportrobotics\.com[ ]*\{/ { inside = 1 }
    inside && /^  handle \{/ && !done { print "  handle_path /sentinel/api/* {"; print "    reverse_proxy 127.0.0.1:8791"; print "  }"; done = 1 }
    inside && /^\}/ { inside = 0 }
    { print }
  ' "$CADDY" > "$CADDY.new"
  if grep -q "handle_path /sentinel/api/\*" "$CADDY.new" && caddy validate --config "$CADDY.new" --adapter caddyfile >/dev/null 2>&1; then
    cat "$CADDY.new" > "$CADDY"; rm -f "$CADDY.new"
    systemctl reload caddy
    echo "web server: /sentinel/api/ now goes to the service"
  else
    rm -f "$CADDY.new"
    echo "the web server's configuration was NOT changed: the new one did not pass its check" >&2
    exit 1
  fi
fi

systemctl restart lamport-sentinel.service
sleep 3
systemctl is-active lamport-sentinel.service
curl -fsS http://127.0.0.1:8791/v1/health
echo
REMOTE

echo "--- from outside"
curl -fsS "https://warden.lamportrobotics.com/sentinel/api/v1/health"; echo
curl -s -o /dev/null -w "page: %{http_code}\n" "https://warden.lamportrobotics.com/sentinel/"
