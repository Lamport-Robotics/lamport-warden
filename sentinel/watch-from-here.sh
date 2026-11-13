#!/bin/sh
# Looks at the deployed Sentinel from somewhere that is not its server, and at the backups kept here.
#
#   sentinel/watch-from-here.sh [ssh-host]        (default host: can; it names the keychain entry, nothing is opened over ssh)
#
# The watchdog on the server cannot say the server is gone, and GitHub's scheduled check runs when GitHub
# gets round to it. This is a third look, from the machine that also holds the backups, every ten minutes
# while it is awake. It says something when:
#
#   - the service does not answer from outside, or answers that it is not watching (twice, half a minute apart);
#   - the newest backup here is more than two days old, or there is none;
#   - the newest backup has no wallets in it and an older one has several (a server lost and set up again);
#   - the key the backups' sealed parts are sealed with is not in this Mac's keychain.
#
# It says it as a notification on this Mac and, when the operator's channel is in the keychain (backup.sh puts
# it there) and is an ntfy topic, on that channel: once an hour at most for each.
set -u
HOST="${1:-can}"
URL="${SENTINEL_HEALTH_URL:-https://warden.lamportrobotics.com/sentinel/api/v1/health}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="${SENTINEL_CHECK:-$HERE/check-live.mjs}"
[ -f "$CHECK" ] || CHECK="$HERE/../scripts/check-live.mjs"
DEST="${SENTINEL_BACKUP_DIR:-$HOME/Library/Application Support/Lamport Sentinel/backups}"
AGAIN_AFTER="${SENTINEL_WATCH_AGAIN_AFTER:-30}"
STALE_DAYS="${SENTINEL_BACKUP_STALE_DAYS:-2}"

say() { # key, sentence: once an hour for each key
  stamp="$DEST/.told-$1"
  now=$(date +%s)
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  [ $((now - last)) -lt 3600 ] && return 0
  mkdir -p "$DEST" && echo "$now" > "$stamp"
  echo "watch: $2"
  command -v osascript >/dev/null 2>&1 && osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Warden Sentinel"' -e 'end run' "$2" >/dev/null 2>&1
  channel=$(security find-generic-password -s lamport-sentinel-ops-channel -a "$HOST" -w 2>/dev/null || true)
  case "$channel" in
    https://discord.com/*|https://discordapp.com/*|https://hooks.slack.com/*) ;;
    https://*/*) curl -fsS -m 10 -H "Title: Warden Sentinel: operations" -d "$2" "$channel" >/dev/null 2>&1 || true ;;
  esac
}

look() { out=$(node "$CHECK" "$URL" ${SENTINEL_CHECK_ARGS:-} 2>&1); code=$?; }
look
if [ "$code" -ne 0 ]; then
  sleep "$AGAIN_AFTER"
  look
  [ "$code" -ne 0 ] && say service "Seen from outside its server: $out"
fi

newest=$(find "$DEST" -name 'sentinel-*.json.gz' -type f -mtime "-$STALE_DAYS" 2>/dev/null | head -1)
[ -n "$newest" ] || say backup "No copy of Sentinel's data has been made here for $STALE_DAYS days. The copies on the server are on the same disk as the data."

# the newest copy against the fullest of the others: emptied is what a lost server set up again looks like
wallets_in() { gzip -dc "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{console.log(JSON.parse(s).wallets.length)}catch{console.log(-1)}})' 2>/dev/null || echo -1; }
latest=$(ls -1t "$DEST"/sentinel-*.json.gz 2>/dev/null | head -1)
if [ -n "$latest" ] && [ "$(wallets_in "$latest")" -eq 0 ]; then
  most=0
  for f in "$DEST"/sentinel-*.json.gz; do [ "$f" = "$latest" ] && continue; n=$(wallets_in "$f"); [ "$n" -gt "$most" ] && most=$n; done
  [ "$most" -ge "${SENTINEL_BACKUP_EMPTIED_FROM:-5}" ] && say backup-empty "The newest copy of Sentinel's data has no wallets in it and an older copy has $most. If the server was lost and set up again, restore from the older copy. Nothing is removed here while this is so."
fi

# without the key a restored file has lost every owner's alert channels
if command -v security >/dev/null 2>&1 && [ -n "$latest" ]; then
  security find-generic-password -s lamport-sentinel-data-key -a "$HOST" >/dev/null 2>&1 || say backup-key "The key that Sentinel's stored alert channels are sealed with is not in this Mac's keychain, so the copies kept here cannot be restored in full. Run sentinel/backup.sh and read what it says."
fi
exit 0
