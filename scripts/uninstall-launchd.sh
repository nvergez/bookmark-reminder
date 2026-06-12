#!/usr/bin/env bash
# Désinstalle l'agent launchd du digest. Idempotent.
set -euo pipefail

LABEL="com.bookmark-reminder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "Agent $LABEL désinstallé (plist supprimé, tâche déchargée)."
