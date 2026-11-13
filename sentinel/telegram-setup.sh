#!/bin/sh
# Gives the deployed Sentinel its Telegram bot, so owners can have alerts sent to a Telegram chat.
#
#   sentinel/telegram-setup.sh [ssh-host]        (default host: can)
#
# Before this, in Telegram: talk to @BotFather, send /newbot, give the bot a name and a username, and copy
# the token it answers with. Whoever has that token can send as the bot and read what people send it.
#
# This asks for the token (it is not shown as you type or paste it, and it is never an argument of any
# command), asks Telegram whose it is, writes it into the service's settings on the server (a file only root
# reads; a copy of the file as it was is kept beside it), restarts the service and says whether it came back.
# Running it again with another token replaces the first.
set -eu
HOST="${1:-can}"
ENV_FILE="${SENTINEL_REMOTE_ENV:-/etc/lamport-sentinel.env}"
UNIT="${SENTINEL_UNIT:-lamport-sentinel.service}"

printf 'The bot token from BotFather: ' >&2
[ -t 0 ] && stty -echo 2>/dev/null
IFS= read -r token || true
[ -t 0 ] && stty echo 2>/dev/null
echo >&2
# its shape first, before it goes anywhere: a number, a colon, a long secret
if ! printf '%s' "$token" | grep -Eq '^[0-9]{5,12}:[A-Za-z0-9_-]{30,60}$'; then
  echo "That is not a bot token as BotFather gives them (a number, a colon, and a long secret). Nothing was changed." >&2
  exit 1
fi

# Telegram says whose it is. The address carries the token, so curl reads it from its input, not its arguments.
answer=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token" | curl -sS -m 20 -K - 2>/dev/null || true)
name=$(printf '%s' "$answer" | sed -n 's/.*"username":"\([A-Za-z0-9_]*\)".*/\1/p')
if [ -z "$name" ]; then
  echo "Telegram does not know that token (or could not be reached). Nothing was changed." >&2
  exit 1
fi

# onto the server by ssh's input: the setting is replaced if it is there, added if it is not
printf 'SENTINEL_TELEGRAM_BOT_TOKEN=%s\n' "$token" | ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "set -e
f='$ENV_FILE'
cp -p \"\$f\" \"\$f.bak-telegram-\$(date +%s)\"
umask 077
{ grep -v '^SENTINEL_TELEGRAM_BOT_TOKEN=' \"\$f\" || true; cat; } > \"\$f.new\"
chmod 600 \"\$f.new\"
mv \"\$f.new\" \"\$f\"
systemctl restart '$UNIT'
for i in 1 2 3 4 5 6 7 8 9 10; do systemctl is-active -q '$UNIT' && break; sleep 1; done
systemctl is-active '$UNIT' >/dev/null"
echo "Telegram alerts are on. The bot is @$name: owners connect a chat from the Sentinel page (Connect Telegram)."
