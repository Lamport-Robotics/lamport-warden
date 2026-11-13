#!/bin/sh
# Sets a Mac up to keep Sentinel's backups and to look at the service from outside.
#
#   sentinel/mac-agents.sh [ssh-host]      install (or install again): default host can
#   sentinel/mac-agents.sh --remove        take both jobs out again; the backups stay where they are
#
# It copies three scripts (backup.sh, watch-from-here.sh, check-live.mjs) into
# ~/Library/Application Support/Lamport Sentinel/bin, so the jobs do not depend on where this repository is or
# which branch it is on, and adds two jobs for this user (launchd agents, no root):
#
#   com.lamportrobotics.sentinel-backup   once a day, at 04:40, or when the Mac next wakes after that
#   com.lamportrobotics.sentinel-watch    every ten minutes while the Mac is awake
#
# What they write goes to ~/Library/Logs/lamport-sentinel-{backup,watch}.log.
set -eu
[ "$(uname)" = "Darwin" ] || { echo "this sets up launchd jobs, and this is not a Mac"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$HOME/Library/Application Support/Lamport Sentinel"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
JOBS="backup watch"

for job in $JOBS; do launchctl bootout "$DOMAIN/com.lamportrobotics.sentinel-$job" 2>/dev/null || true; done
if [ "${1:-}" = "--remove" ]; then
  for job in $JOBS; do rm -f "$AGENTS/com.lamportrobotics.sentinel-$job.plist"; done
  echo "both jobs removed; the backups are still in $BASE/backups"
  exit 0
fi
HOST="${1:-can}"
NODE_DIR="$(dirname "$(command -v node)")"

umask 077
mkdir -p "$BASE/bin" "$BASE/backups" "$AGENTS" "$HOME/Library/Logs"
cp "$ROOT/sentinel/backup.sh" "$ROOT/sentinel/watch-from-here.sh" "$ROOT/scripts/check-live.mjs" "$BASE/bin/"

plist() { # job, script, schedule (the XML of one key and its value)
  cat > "$AGENTS/com.lamportrobotics.sentinel-$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lamportrobotics.sentinel-$1</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$BASE/bin/$2</string><string>$HOST</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  $3
  <key>StandardOutPath</key><string>$HOME/Library/Logs/lamport-sentinel-$1.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/lamport-sentinel-$1.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
}
plist backup backup.sh '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>40</integer></dict>'
plist watch watch-from-here.sh '<key>StartInterval</key><integer>600</integer>'
for job in $JOBS; do launchctl bootstrap "$DOMAIN" "$AGENTS/com.lamportrobotics.sentinel-$job.plist"; done
echo "installed: a backup from $HOST every day at 04:40, and a look at the service every ten minutes"
echo "run one now:  launchctl kickstart $DOMAIN/com.lamportrobotics.sentinel-backup"
