#!/usr/bin/env bash
# Wrapper lancé par launchd : résout node AU MOMENT DU RUN.
# Pourquoi : un chemin node figé dans le plist (typiquement
# ~/.nvm/versions/node/vX.Y.Z/bin/node) disparaît au premier
# nvm install/uninstall ; launchd ne peut alors plus spawner le process, donc
# l'alerte Telegram (qui vit DANS le process) ne part jamais. Ce wrapper, lui,
# est un chemin stable du repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# launchd démarre avec un PATH minimal (/usr/bin:/bin) : charger nvm si
# présent (suit l'alias default courant), puis compléter avec les
# emplacements usuels (homebrew Apple Silicon / Intel).
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Erreur : node introuvable au moment du run (PATH : $PATH)." >&2
  echo "Installer Node >= 22.18 (nvm ou homebrew) puis relancer ./scripts/install-launchd.sh." >&2
  exit 1
fi

# Node >= 22.18 requis (type stripping natif, engines de package.json) :
# un node plus ancien ferait échouer le strip-types de src/digest.ts.
if ! node -e 'const [a = 0, b = 0] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "Erreur : node $(node -v) trop ancien — Node >= 22.18 requis (package.json engines)." >&2
  exit 1
fi

cd "$REPO_DIR"
exec node src/digest.ts
