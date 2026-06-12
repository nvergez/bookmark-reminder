#!/usr/bin/env bash
# Installe l'agent launchd qui lance le digest quotidien.
# Usage : ./scripts/install-launchd.sh [HH:MM]   (défaut : 08:30)
set -euo pipefail

TIME="${1:-08:30}"
if [[ ! "$TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "Erreur : heure invalide « $TIME » — format attendu HH:MM (ex. 08:30)." >&2
  exit 1
fi
# 10# : évite l'interprétation octale de 08/09
HOUR=$((10#${TIME%%:*}))
MINUTE=$((10#${TIME##*:}))

# Racine du repo résolue depuis l'emplacement du script, pas du cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# Le plist pointe vers le wrapper (chemin stable du repo) qui résout node au
# moment du run : figer ici le chemin node (souvent versionné sous ~/.nvm/)
# casserait launchd au premier nvm install/uninstall, sans alerte Telegram
# possible. Les checks ci-dessous ne servent qu'au retour immédiat à l'install.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Erreur : node introuvable dans le PATH." >&2
  echo "Installer Node 22.18+ (ou charger nvm/volta dans ce shell) puis relancer." >&2
  exit 1
fi
if ! node -e 'const [a = 0, b = 0] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "Erreur : node $(node -v) trop ancien — Node >= 22.18 requis (package.json engines)." >&2
  exit 1
fi

WRAPPER="$SCRIPT_DIR/run-digest.sh"
if [[ ! -f "$WRAPPER" ]]; then
  echo "Erreur : wrapper introuvable : $WRAPPER" >&2
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

# Décharge une éventuelle version précédente (silencieux si absente)
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo "Agent $LABEL installé : digest tous les jours à $TIME."
echo "  - wrapper : $WRAPPER (node résolu à chaque run ; actuellement : $NODE_BIN)"
echo "  - repo    : $REPO_DIR"
echo "  - plist   : $PLIST"
echo
echo "Tester immédiatement :"
echo "  launchctl kickstart -k gui/$UID/$LABEL"
echo "Suivre les logs :"
echo "  tail -f '$REPO_DIR/logs/digest.log' '$REPO_DIR/logs/digest.err.log'"

if [[ ! -f "$REPO_DIR/tokens.json" ]]; then
  echo
  echo "⚠️  tokens.json absent : lancer « npm run auth » avant le premier digest,"
  echo "   sinon le run de demain matin échouera (alerte Telegram si .env est rempli)."
fi
