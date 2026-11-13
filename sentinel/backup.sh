#!/bin/sh
# Copies Sentinel's data off the server it runs on, to the machine this is run on.
#
#   sentinel/backup.sh [ssh-host]        (default host: can)
#
# The snapshots the service keeps are on the same disk as the data. This is the copy for a lost server:
#
#   - the data file as it is now, gzipped, one file a run, in a folder only this user can read
#     (~/Library/Application Support/Lamport Sentinel/backups unless SENTINEL_BACKUP_DIR says otherwise);
#   - copies older than seven days are removed: the privacy policy says how long a removed profile lingers
#     in backups, and this keeps to it;
#   - on a Mac, the two things a restored file is no use without go into the login keychain, never into a
#     file: the key the stored alert channels are sealed with, and the address of the operator's channel.
#
# Stripe's keys are not copied. They can be made again at Stripe.
#
# To restore: put the newest copy back as the service's data file (gunzip it to
# /var/lib/private/lamport-sentinel/sentinel.json, owned by the service's user), and set SENTINEL_DATA_KEY in
# /etc/lamport-sentinel.env to what `security find-generic-password -s lamport-sentinel-data-key -a <host> -w`
# prints.
set -eu
HOST="${1:-can}"
DEST="${SENTINEL_BACKUP_DIR:-$HOME/Library/Application Support/Lamport Sentinel/backups}"
DATA="${SENTINEL_REMOTE_DATA:-/var/lib/private/lamport-sentinel/sentinel.json}"
ENV_FILE="${SENTINEL_REMOTE_ENV:-/etc/lamport-sentinel.env}"
DAYS="${SENTINEL_BACKUP_DAYS:-7}"

umask 077
mkdir -p "$DEST"
chmod 700 "$DEST"
incoming="$DEST/.incoming-$$"
trap 'rm -f "$incoming"' EXIT

# the file is read whole on the server and squeezed there; nothing is written on the server
ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "gzip -c '$DATA'" > "$incoming"

# what came back has to be the data file: it unpacks, and it is the service's own shape
if ! gzip -t "$incoming" 2>/dev/null || ! gzip -dc "$incoming" | grep -q '"wallets"'; then
  echo "backup: what came back from $HOST is not Sentinel's data file; nothing was kept" >&2
  exit 1
fi
name="sentinel-$(date -u +%Y%m%dT%H%M%SZ).json.gz"
mv "$incoming" "$DEST/$name"

# older than the policy allows: gone
find "$DEST" -name 'sentinel-*.json.gz' -type f -mtime "+$((DAYS - 1))" -exec rm -f {} +

# the key and the operator's channel, into the keychain (a Mac's; elsewhere, say so and go on)
if command -v security >/dev/null 2>&1; then
  keep() { # service-name, value: written only when it is not already what the keychain holds
    [ -n "$2" ] || return 0
    have=$(security find-generic-password -s "$1" -a "$HOST" -w 2>/dev/null || true)
    [ "$have" = "$2" ] || security add-generic-password -U -s "$1" -a "$HOST" -l "Lamport Sentinel ($1, $HOST)" -w "$2"
  }
  setting() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "grep '^$1=' '$ENV_FILE' | head -1 | cut -d= -f2-"; }
  keep lamport-sentinel-data-key "$(setting SENTINEL_DATA_KEY)"
  keep lamport-sentinel-ops-channel "$(setting SENTINEL_OPS_CHANNEL)"
else
  echo "backup: no keychain here, so the data key was not copied; the stored alert channels cannot be read without it" >&2
fi

echo "backup: kept $name ($(wc -c < "$DEST/$name" | tr -d ' ') bytes); $(find "$DEST" -name 'sentinel-*.json.gz' -type f | wc -l | tr -d ' ') copies in $DEST"
