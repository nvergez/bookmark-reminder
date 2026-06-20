#!/usr/bin/env bash
# Wrapper launched by launchd: resolves node AT RUN TIME.
# Why: a node path hardcoded in the plist (typically
# ~/.nvm/versions/node/vX.Y.Z/bin/node) disappears on the first
# nvm install/uninstall; launchd can then no longer spawn the process, so
# the Telegram alert (which lives INSIDE the process) never goes out. This wrapper,
# on the other hand, is a stable repo path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# launchd starts with a minimal PATH (/usr/bin:/bin): load nvm if
# present (follows the current default alias), then complete with the
# usual locations (homebrew Apple Silicon / Intel).
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found at run time (PATH: $PATH)." >&2
  echo "Install Node >= 22.18 (nvm or homebrew) then re-run ./scripts/install-launchd.sh." >&2
  exit 1
fi

# Node >= 22.18 required (native type stripping, package.json engines):
# an older node would make the strip-types of src/digest.ts fail.
if ! node -e 'const [a = 0, b = 0] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "Error: node $(node -v) too old — Node >= 22.18 required (package.json engines)." >&2
  exit 1
fi

cd "$REPO_DIR"
exec node src/digest.ts
