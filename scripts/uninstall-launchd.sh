#!/usr/bin/env bash
# Uninstalls the digest's launchd agent. Idempotent.
set -euo pipefail

LABEL="com.bookmark-reminder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "Agent $LABEL uninstalled (plist removed, task unloaded)."
