#!/usr/bin/env bash
set -euo pipefail

# Bascule local → cloud (SPIKE-HOSTING.md §3.4) : seed du Durable Object avec
# tokens.json + state.json, puis neutralisation du local. Le refresh token X
# est à USAGE UNIQUE : un seul détenteur à tout instant, jamais local + cloud
# en parallèle.
#
# Usage : AUTH_URL_KEY=… ./scripts/migrate-to-cloud.sh https://bookmark-reminder.<sous-domaine>.workers.dev

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

if [[ $# -ne 1 ]]; then
  echo "Usage : AUTH_URL_KEY=… $0 https://<worker>.workers.dev" >&2
  exit 1
fi
WORKER_URL="${1%/}"

if [[ -z "${AUTH_URL_KEY:-}" ]]; then
  read -r -s -p "AUTH_URL_KEY (le secret des routes du Worker) : " AUTH_URL_KEY
  echo
fi
if [[ -z "$AUTH_URL_KEY" ]]; then
  echo "Erreur : AUTH_URL_KEY vide." >&2
  exit 1
fi

# Étape 1 du §3.4 : le cron local DOIT être décommissionné avant tout run cloud.
if launchctl print "gui/$UID/com.bookmark-reminder" >/dev/null 2>&1; then
  echo "Erreur : l'agent launchd com.bookmark-reminder est encore chargé." >&2
  echo "Lance d'abord ./scripts/uninstall-launchd.sh (un seul détenteur des tokens à la fois)." >&2
  exit 1
fi

for f in tokens.json state.json; do
  if [[ ! -f "$f" ]]; then
    echo "Erreur : $f introuvable — rien à migrer (ou déjà migré ?)." >&2
    exit 1
  fi
done

echo "Seed du Durable Object (tokens + state)…"
payload="$(node -e '
const fs = require("fs");
const tokens = JSON.parse(fs.readFileSync("tokens.json", "utf8"));
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
process.stdout.write(JSON.stringify({ tokens, state }));
')"
# Clé en header (pas en ?k=) : elle ne traîne ni dans `ps` ni dans les
# invocation logs du Worker.
curl -fsS -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AUTH_URL_KEY" \
  --data "$payload" "$WORKER_URL/admin/import"

echo "Run de vérification côté cloud…"
curl -fsS -H "Authorization: Bearer $AUTH_URL_KEY" "$WORKER_URL/run"

# Le premier run cloud a consommé le refresh token : les fichiers locaux sont
# désormais PÉRIMÉS et dangereux (un run local accidentel = famille de tokens
# perdue). On les supprime.
echo "Suppression des fichiers locaux périmés (tokens.json, state.json)…"
rm -f tokens.json state.json

cat <<EOF

Bascule terminée. Reste à faire :
  1. Dans wrangler.jsonc : "ADMIN_API": "off", puis npm run worker:deploy
     (ferme les routes d'import/export).
  2. Rollback éventuel plus tard : remettre ADMIN_API=on, redéployer, puis
     curl -H "Authorization: Bearer …" "$WORKER_URL/admin/export" > export.json,
     recréer tokens.json et state.json depuis export.json, et réinstaller
     launchd — APRÈS avoir supprimé les crons du Worker.
EOF
