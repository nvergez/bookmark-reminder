#!/usr/bin/env bash
set -euo pipefail

# Switch local → cloud (SPIKE-HOSTING.md §3.4): seed the Durable Object with
# tokens.json + state.json, then neutralize the local side. The X refresh token
# is SINGLE-USE: only one holder at any time, never local + cloud
# in parallel.
#
# Usage: AUTH_URL_KEY=… ./scripts/migrate-to-cloud.sh https://bookmark-reminder.<subdomain>.workers.dev

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

if [[ $# -ne 1 ]]; then
  echo "Usage: AUTH_URL_KEY=… $0 https://<worker>.workers.dev" >&2
  exit 1
fi
WORKER_URL="${1%/}"

if [[ -z "${AUTH_URL_KEY:-}" ]]; then
  read -r -s -p "AUTH_URL_KEY (the secret for the Worker routes): " AUTH_URL_KEY
  echo
fi
if [[ -z "$AUTH_URL_KEY" ]]; then
  echo "Error: AUTH_URL_KEY empty." >&2
  exit 1
fi

# Step 1 of §3.4: the local cron MUST be decommissioned before any cloud run.
if launchctl print "gui/$UID/com.bookmark-reminder" >/dev/null 2>&1; then
  echo "Error: the launchd agent com.bookmark-reminder is still loaded." >&2
  echo "Run ./scripts/uninstall-launchd.sh first (only one token holder at a time)." >&2
  exit 1
fi

for f in tokens.json state.json; do
  if [[ ! -f "$f" ]]; then
    echo "Error: $f not found — nothing to migrate (or already migrated?)." >&2
    exit 1
  fi
done

echo "Seeding the Durable Object (tokens + state)…"
payload="$(node -e '
const fs = require("fs");
const tokens = JSON.parse(fs.readFileSync("tokens.json", "utf8"));
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
process.stdout.write(JSON.stringify({ tokens, state }));
')"
# Key in the header (not in ?k=): it lingers neither in `ps` nor in the
# Worker's invocation logs.
curl -fsS -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AUTH_URL_KEY" \
  --data "$payload" "$WORKER_URL/admin/import"

echo "Verification run on the cloud side…"
curl -fsS -H "Authorization: Bearer $AUTH_URL_KEY" "$WORKER_URL/run"

# The first cloud run consumed the refresh token: the local files are
# now STALE and dangerous (an accidental local run = lost token
# family). We delete them.
echo "Deleting the stale local files (tokens.json, state.json)…"
rm -f tokens.json state.json

cat <<EOF

Switch complete. Remaining steps:
  1. In wrangler.jsonc: "ADMIN_API": "off", then npm run worker:deploy
     (closes the import/export routes).
  2. Possible rollback later: set ADMIN_API=on again, redeploy, then
     curl -H "Authorization: Bearer …" "$WORKER_URL/admin/export" > export.json,
     recreate tokens.json and state.json from export.json, and reinstall
     launchd — AFTER deleting the Worker's crons.
EOF
