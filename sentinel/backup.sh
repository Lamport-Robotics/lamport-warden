#!/bin/sh
# Copies Sentinel's data off the server it runs on, to the machine this is run on.
#
#   sentinel/backup.sh [ssh-host]        (default host: can)
#
# The snapshots the service keeps are on the same disk as the data. This is the copy for a lost server:
#
#   - the data file as it is now, gzipped, one file a run, in a folder only this user can read
#     (~/Library/Application Support/Lamport Sentinel/backups unless SENTINEL_BACKUP_DIR says otherwise);
#   - after a copy that worked, copies older than seven days are removed: the privacy policy says how long a
#     removed profile lingers in backups, and this keeps to it. Nothing is removed when the copy failed, or
#     when the server's file has no wallets in it and the last copy had several: that is what a server that
#     was lost and set up again looks like, and the old copies are then all there is;
#   - on a Mac, the two things a restored file is no use without go into the login keychain, never into a
#     file and never onto a command line: the key the stored alert channels are sealed with, and the address
#     of the operator's channel.
#
# Stripe's keys are not copied. They can be made again at Stripe.
#
# It ends with 0 when there is a new copy and the key for it is in the keychain; 1 when no copy was made; 2
# when the copy was made and the key is not in the keychain; 3 when the server's file looks emptied.
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
# how many wallets a copy has in it; -1 when that cannot be told here (no node)
wallets_in() { gzip -dc "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{console.log(JSON.parse(s).wallets.length)}catch{console.log(-1)}})' 2>/dev/null || echo -1; }
last=$(ls -1t "$DEST"/sentinel-*.json.gz 2>/dev/null | head -1)
had=-1; [ -n "$last" ] && had=$(wallets_in "$last")
has=$(wallets_in "$incoming")

name="sentinel-$(date -u +%Y%m%dT%H%M%SZ).json.gz"
# two runs in one second are two copies, not one written over the other
[ -e "$DEST/$name" ] && name="${name%.json.gz}-$$.json.gz"
mv "$incoming" "$DEST/$name"

# A file with nobody in it, after one with several: the server may have been lost and set up again. The copy
# is kept (it is what the server has), nothing older is removed, and whoever runs this hears of it.
emptied=0
if [ "$has" -eq 0 ] && [ "$had" -ge "${SENTINEL_BACKUP_EMPTIED_FROM:-5}" ]; then
  emptied=1
  echo "backup: the server's data has no wallets in it and the copy before had $had. If the server was lost and set up again, restore from an older copy (see the top of this script). No older copy is removed while this is so. If it is right that nobody is left, remove the older copies yourself." >&2
else
  # older than the policy allows: gone
  find "$DEST" -name 'sentinel-*.json.gz' -type f -mtime "+$((DAYS - 1))" -exec rm -f {} +
fi

# the key and the operator's channel, into the keychain (a Mac's; elsewhere, say so and go on)
keyed=0
if command -v security >/dev/null 2>&1; then
  keep() { # service-name, value: written only when it is not already what the keychain holds
    [ -n "$2" ] || return 0
    have=$(security find-generic-password -s "$1" -a "$HOST" -w 2>/dev/null || true)
    [ "$have" = "$2" ] && return 0
    # read by the keychain tool from its input, so the value is never an argument anyone can list
    case "$2" in *'"'*|*'\'*|*'
'*) echo "backup: what the server has for $1 is not something that can be stored; left alone" >&2; return 0 ;; esac
    printf 'add-generic-password -U -s %s -a %s -l "Lamport Sentinel (%s, %s)" -w "%s"\n' "$1" "$HOST" "$1" "$HOST" "$2" | security -i >/dev/null
  }
  # a setting that cannot be read is not the same as one that is not set: it is said, and nothing is overwritten
  setting() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "grep '^$1=' '$ENV_FILE' | head -1 | cut -d= -f2-" || { echo "backup: $1 could not be read from $HOST" >&2; return 0; }; }
  keep lamport-sentinel-data-key "$(setting SENTINEL_DATA_KEY)"
  keep lamport-sentinel-ops-channel "$(setting SENTINEL_OPS_CHANNEL)"
  security find-generic-password -s lamport-sentinel-data-key -a "$HOST" >/dev/null 2>&1 && keyed=1
else
  echo "backup: no keychain here, so the data key was not copied; the stored alert channels cannot be read without it" >&2
fi

echo "backup: kept $name ($(wc -c < "$DEST/$name" | tr -d ' ') bytes); $(find "$DEST" -name 'sentinel-*.json.gz' -type f | wc -l | tr -d ' ') copies in $DEST"
[ "$emptied" -eq 1 ] && exit 3
if [ "$keyed" -eq 0 ]; then
  echo "backup: the copy is kept, but the key its sealed parts are sealed with is not in the keychain: it could not be read from $HOST. A restore from this copy would lose every owner's alert channels." >&2
  exit 2
fi
exit 0
