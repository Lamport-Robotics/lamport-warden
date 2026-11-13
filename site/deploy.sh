#!/usr/bin/env bash
# Puts site/index.html, site/privacy/ and the practice page (site/try/) up as https://warden.lamportrobotics.com on the server lamportrobotics.com runs on.
#
#   site/deploy.sh [ssh-host]        default host: can
#
# Safe to run again: the page is replaced, the Caddy block is added only once. The Caddyfile is backed up, the
# new one is validated, and if it does not validate the backup is put back and Caddy is left alone.
# The certificate arrives on its own once DNS points warden.lamportrobotics.com at the server.
set -euo pipefail
HOST="${1:-can}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# the practice page is built (its script bundles the wallet libraries); the other two pages are files as they are
(cd "$HERE/.." && node scripts/build-web.mjs >/dev/null)
for f in index.html try.css try.js; do [ -s "$HERE/try/dist/$f" ] || { echo "site/try/dist/$f was not built"; exit 1; }; done

ssh -o BatchMode=yes "$HOST" 'install -d -o lamport -g lamport -m 755 /opt/lamportrobotics/warden /opt/lamportrobotics/warden/privacy /opt/lamportrobotics/warden/try'
scp -q -o BatchMode=yes "$HERE/index.html" "$HOST:/opt/lamportrobotics/warden/index.html"
scp -q -o BatchMode=yes "$HERE/privacy/index.html" "$HOST:/opt/lamportrobotics/warden/privacy/index.html"
scp -q -o BatchMode=yes "$HERE/try/dist/index.html" "$HERE/try/dist/try.css" "$HERE/try/dist/try.js" "$HOST:/opt/lamportrobotics/warden/try/"
ssh -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
chown lamport:lamport /opt/lamportrobotics/warden/index.html /opt/lamportrobotics/warden/privacy/index.html /opt/lamportrobotics/warden/try/index.html /opt/lamportrobotics/warden/try/try.css /opt/lamportrobotics/warden/try/try.js
chmod 644 /opt/lamportrobotics/warden/index.html /opt/lamportrobotics/warden/privacy/index.html /opt/lamportrobotics/warden/try/index.html /opt/lamportrobotics/warden/try/try.css /opt/lamportrobotics/warden/try/try.js
cd /etc/caddy
if grep -q '^warden.lamportrobotics.com' Caddyfile; then echo "pages replaced; the Caddy block was already there"; exit 0; fi
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
