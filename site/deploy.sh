#!/usr/bin/env bash
# Puts site/index.html up as https://warden.lamportrobotics.com on the server lamportrobotics.com runs on.
#
#   site/deploy.sh [ssh-host]        default host: can
#
# Safe to run again: the page is replaced, the Caddy block is added only once. The Caddyfile is backed up, the
# new one is validated, and if it does not validate the backup is put back and Caddy is left alone.
# The certificate arrives on its own once DNS points warden.lamportrobotics.com at the server.
set -euo pipefail
HOST="${1:-can}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ssh -o BatchMode=yes "$HOST" 'install -d -o lamport -g lamport -m 755 /opt/lamportrobotics/warden'
scp -q -o BatchMode=yes "$HERE/index.html" "$HOST:/opt/lamportrobotics/warden/index.html"
ssh -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
chown lamport:lamport /opt/lamportrobotics/warden/index.html
chmod 644 /opt/lamportrobotics/warden/index.html
cd /etc/caddy
if grep -q '^warden.lamportrobotics.com' Caddyfile; then echo "page replaced; the Caddy block was already there"; exit 0; fi
backup="Caddyfile.bak-warden-$(date +%Y%m%d-%H%M%S)"
cp -p Caddyfile "$backup"
cat >> Caddyfile <<'BLOCK'

# Lamport Warden page (repo lamport-warden, site/): one static file, with the main site's fonts and logo
warden.lamportrobotics.com {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
  @shared path /site/fonts/* /site/mark.svg
  handle @shared {
    root * /opt/lamportrobotics/site
    header Cache-Control "public, max-age=86400"
    file_server
  }
  handle {
    root * /opt/lamportrobotics/warden
    header Cache-Control "no-cache"
    file_server
  }
}
BLOCK
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  tail -5 /tmp/caddy-validate.log
  cp -p "$backup" Caddyfile
  echo "the new Caddyfile did not validate: the old one is back and Caddy was not touched"
  exit 1
fi
systemctl reload caddy
echo "deployed; backup of the old Caddyfile: /etc/caddy/$backup"
REMOTE
