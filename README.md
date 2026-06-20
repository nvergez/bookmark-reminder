# bookmark-reminder

A TypeScript bot that sends your new X bookmarks and likes from the previous
day to Telegram every morning, via the official X API on a pay-per-use basis
(~$1.50/month). Decisions and architecture: [PLAN.md](./PLAN.md).

## Prerequisites (one-time, ~20 min)

1. **X developer account** at https://developer.x.com: create a project and
   an app, then **load credits** (a credit card is required — the model is
   pay-per-use "Owned Reads" at $0.001/post; the Developer Console pricing
   grid is authoritative, and you'll see the minimum top-up amount when you
   sign up).
2. **OAuth in the X app**: enable OAuth 2.0, type *Web App / Public client*,
   callback `http://127.0.0.1:8765/callback` (make sure it's `127.0.0.1`, not
   `localhost` — per X's docs recommendation). Note your `X_CLIENT_ID` (and
   the secret only if your app is a confidential client).
3. **Telegram bot**: talk to [@BotFather](https://t.me/BotFather) →
   `/newbot` → note your `TELEGRAM_BOT_TOKEN`. Send any message to the bot,
   then read its `chat.id` from the response of
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_CHAT_ID`.
4. **Configuration**: `cp .env.example .env` and fill in the variables
   (`.env` is gitignored).

## Installation

```sh
npm install                      # devDependencies only (typescript, wrangler…)
npm run auth                     # OAuth 2.0 + PKCE → opens the browser, writes tokens.json
npm run digest                   # manual test: first run = establishes the baseline
./scripts/install-launchd.sh    # schedules the daily digest (default 08:30)
./scripts/install-launchd.sh 07:45   # or at the time of your choosing
```

Requires Node ≥ 22.18 (native TypeScript execution, zero runtime dependencies).

## How it works

- At the scheduled time, launchd runs `src/digest.ts` (~10 s): refreshes the
  OAuth token (rotation persisted atomically), reads the bookmarks and likes,
  then **diffs IDs** against `state.json` (X doesn't expose the date a
  bookmark was added, so only the diff works).
- **First run**: it establishes the baseline; no digest is sent.
- Days with new items: **1 notifying summary message** + 1 **silent** message
  per tweet (rich preview in the chat).
- Days with nothing new: a silent "nothing new ✨" — so the bot's total
  silence is never ambiguous.
- Any error triggers a **⚠️ alert on Telegram**.

Gitignored local files: `tokens.json` (secret), `state.json`, `logs/`.

## Troubleshooting

- **"⚠️ the bot failed"** mentioning the token or a 401: the X refresh token
  is single-use; if it's lost (a failed write, a revocation), re-run
  `npm run auth`.
- **Logs**: `logs/digest.log` and `logs/digest.err.log` at the repo root.
- **Force a run** without waiting for tomorrow:
  `launchctl kickstart -k gui/$UID/com.bookmark-reminder`
- **Poor tweet previews** in Telegram: set
  `TWEET_LINK_DOMAIN=fixupx.com` in `.env`.
- **Uninstall the schedule**: `./scripts/uninstall-launchd.sh`.

## Costs and monitoring

2 calls/day × `MAX_RESULTS=25` → ≤ 50 posts/day billed at $0.001 each, i.e.
**~$1.50/month** (absolute worst case with `MAX_RESULTS=100`: ~$6/month).
Pricing is "subject to change": the Developer Console pricing grid is
authoritative.

Keep an eye on the actual costs in the Developer Console during the first
few days (expected: ~$0.05/day max).

## Cloud (E6) — Cloudflare Workers

To avoid keeping the Mac powered on, the bot can be deployed to **Cloudflare
Workers free + Durable Object SQLite** (decided after a spike, see
[SPIKE-HOSTING.md](./SPIKE-HOSTING.md)). The core of the run (`src/run.ts` and
the shared modules, with no `node:*` imports at all) is common to both
environments; only the adapters differ (`src/digest.ts` locally,
`worker/index.ts` on Cloudflare).

Deployment:

1. Account at https://dash.cloudflare.com (free), then `npx wrangler login`.
2. `npm run worker:deploy` → note the URL `https://bookmark-reminder.<subdomain>.workers.dev`.
3. Set `BASE_URL` in `wrangler.jsonc` to this URL, and set the secrets:
   `npx wrangler secret put X_CLIENT_ID` (likewise `X_CLIENT_SECRET`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `AUTH_URL_KEY` = 32+ random
   bytes, e.g. `openssl rand -base64 32`). Redeploy.
4. In the X app (developer.x.com): add the callback
   `https://<worker>.workers.dev/callback` (the local `127.0.0.1` can stay; an
   app accepts up to 10 URIs).
5. **Exclusive switchover** local → cloud (the refresh token is single-use,
   never run both in parallel): open the admin routes — `"ADMIN_API": "on"`
   in `wrangler.jsonc` then `npm run worker:deploy` —, then
   `./scripts/uninstall-launchd.sh`, then
   `AUTH_URL_KEY=… ./scripts/migrate-to-cloud.sh https://<worker>.workers.dev`
   — the script seeds the Durable Object (tokens **and** state), triggers a
   verification run, and deletes the stale local files.
6. Close the admin routes back up: `"ADMIN_API": "off"` in `wrangler.jsonc`
   then `npm run worker:deploy`.
7. Measure the actual CPU of the first run (`npm run worker:tail`) — the free
   tier grants 10 ms of active CPU per invocation (network waits don't count);
   open question §5 of the spike.

Cron: two UTC triggers (`30 6` and `30 7`) straddle the daylight-saving time
change; the `src/schedule.ts` guard only lets through the one that falls at
`DIGEST_PARIS_TIME` (08:30 Europe/Paris by default).

**Pre-existing subrequest limit**: the free plan allows 50 external
subrequests per invocation. In the worst case `MAX_RESULTS=25` (50 items), the
per-tweet Telegram sends already exceed this cap (~54 calls) — the lever if it
ever happens: lower `MAX_RESULTS`. The Claude call for the AI summary (next
section) adds only **one**.

**Re-auth from any browser** (phone included): open
`https://<worker>.workers.dev/auth?k=<AUTH_URL_KEY>` — the failure alerts on
Telegram embed this link directly. Cloud→local rollback: see the output of
`migrate-to-cloud.sh` (symmetric export of tokens + state).

## AI recap summary (optional)

With an Anthropic API key, the morning recap message — the only notifying one —
gains a thematic summary (2-4 lines) and a "⭐ Read first" block of 1 to 3
picks, produced by **a single Claude call per day**. Design and trade-offs:
[PLAN-IA-DIGEST.md](./PLAN-IA-DIGEST.md). Without a key, the bot is strictly
unchanged.

The key is set **in every environment where the bot runs**:

- **Local**: `ANTHROPIC_API_KEY=sk-ant-…` in `.env`.
- **Worker**: `npx wrangler secret put ANTHROPIC_API_KEY`.

⚠️ **Duplicate-secret trap**: if only one of the two environments has the key,
the two runtimes diverge **silently** — the one without a key simply skips the
summary (status "skipped", not "failed"), and the unavailability line only
shows up on a call failure. During a local ↔ cloud switchover, set the key on
both sides (or neither).

### Model choice

`ANTHROPIC_MODEL` (`.env` locally, `vars` in `wrangler.jsonc` on the Worker)
selects the model — default `claude-opus-4-8`, never silently substituted:

| Model | Input/Output ($/MTok) | Estimated typical month |
|---|---|---|
| `claude-opus-4-8` (default) | 5 / 25 | ~$0.40–0.55 |
| `claude-sonnet-4-6` | 3 / 15 | ~$0.30 |
| `claude-haiku-4-5` | 1 / 5 | ~$0.10 |

### Strict fail-open

- **Claude failure** (outage, revoked key, timeout…): the digest goes out
  normally, with the line "*🤖 AI summary unavailable this morning*" — never a
  dropped digest, never a retry. The exact cause is in the local console (or
  `npm run worker:tail` on the Worker side).
- **Days with fewer than 3 unique tweets** (and the first run): call skipped
  without network — $0, the raw recap is enough, and no unavailability line (a
  skipped day is not a failure).

## License

[MIT](./LICENSE).
