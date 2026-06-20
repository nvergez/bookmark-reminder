#!/usr/bin/env bash
# Installs the launchd agent that launches the daily digest.
# Usage: ./scripts/install-launchd.sh [HH:MM]   (default: 08:30)
set -euo pipefail

TIME="${1:-08:30}"
if [[ ! "$TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "Error: invalid time \"$TIME\" — expected format HH:MM (e.g. 08:30)." >&2
  exit 1
fi
# 10#: avoids octal interpretation of 08/09
HOUR=$((10#${TIME%%:*}))
MINUTE=$((10#${TIME##*:}))

# Repo root resolved from the script's location, not the cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# The plist points to the wrapper (stable repo path) which resolves node at
# run time: hardcoding the node path here (often versioned under ~/.nvm/)
# would break launchd on the first nvm install/uninstall, with no possible
# Telegram alert. The checks below only serve to give immediate feedback at install time.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH." >&2
  echo "Install Node 22.18+ (or load nvm/volta in this shell) then re-run." >&2
  exit 1
fi
if ! node -e 'const [a = 0, b = 0] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "Error: node $(node -v) too old — Node >= 22.18 required (package.json engines)." >&2
  exit 1
fi

WRAPPER="$SCRIPT_DIR/run-digest.sh"
if [[ ! -f "$WRAPPER" ]]; then
  echo "Error: wrapper not found: $WRAPPER" >&2
  exit 1
fi

LABEL="com.bookmark-reminder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$REPO_DIR/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAPPER</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$REPO_DIR/logs/digest.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_DIR/logs/digest.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

# Unloads any previous version (silent if absent)
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo "Agent $LABEL installed: digest every day at $TIME."
echo "  - wrapper: $WRAPPER (node resolved at each run; currently: $NODE_BIN)"
echo "  - repo   : $REPO_DIR"
echo "  - plist  : $PLIST"
echo
echo "Test immediately:"
echo "  launchctl kickstart -k gui/$UID/$LABEL"
echo "Follow the logs:"
echo "  tail -f '$REPO_DIR/logs/digest.log' '$REPO_DIR/logs/digest.err.log'"

if [[ ! -f "$REPO_DIR/tokens.json" ]]; then
  echo
  echo "⚠️  tokens.json missing: run \"npm run auth\" before the first digest,"
  echo "   otherwise tomorrow morning's run will fail (Telegram alert if .env is filled in)."
fi
