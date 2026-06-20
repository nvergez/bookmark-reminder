# PLAN — Daily reminder bot for X bookmarks & likes

> Decisions made at the end of the initial spike (2026-06). This document is the
> reference for the implementation.
>
> **Status: E1-E6 implemented and validated for real.** Local bot first (auth,
> refresh 2×, detection, Telegram digest, launchd), then E6 (settled after the
> spike, [SPIKE-HOSTING.md](./SPIKE-HOSTING.md)): Cloudflare Worker +
> Durable Object SQLite (`worker/`), shared local/cloud run core
> (`src/run.ts` + `Storage` interface), exclusive cutover done (tokens +
> state seeded in the DO, admin routes closed back up). **Measured CPU: 4 ms**
> per run (free tier 10 ms → ×2.5 headroom; open point §5 settled).

## 1. Decisions made

| Topic | Choice | Why | Alternatives rejected |
|---|---|---|---|
| **Data source** | **Official X API, pay-per-use** | Legal and contractual, "Owned Reads" at $0.001/post → **~$1.50/month** (max ~$6), rate limits a non-issue, hostable anywhere | rettiwt-api (free but against the ToS + breakage windows → remains the documented **plan B**) · twikit (broken since 03/2026) · twitterapi.io+GetXAPI (credentials handed to third parties, no likes reading on one of them) · Dewey/Tweetsmash ($10-14/month, SaaS dependency) |
| **Delivery channel** | **Telegram** | Free, native notifications on mobile **and** desktop, rich tweet previews in the chat (the digest reads without opening X), bot = 1 HTTPS POST | WhatsApp (Meta Business friction or ban of the personal number) · ntfy.sh (very good but raw rendering) · Discord (finicky X embeds) · Pushover (paid, poor rendering) · email (unreliable notifications) |
| **Language / stack** | **TypeScript (Node 22)** | Team choice; native fetch is enough; naturally opens the door to the cloud port (val.town / CF Workers = JS) | Python (the spikes were in it; the Python draft of the bot was removed) |
| **"New" detection** | **Persisted ID diff** (state.json) | Verified structural constraint: X **never** exposes the date a bookmark/like was added, only the tweet's date | Filtering by `created_at` (wrong: we bookmark old tweets) |
| **Hosting v1** | **launchd on the Mac, 8:30am** | The 1st OAuth run requires a browser anyway; zero infra | Cloud from the start (planned as a v2 option: the official API tolerates datacenter IPs, unlike scraping) |
| **Hosting v2 (E6)** | **Cloudflare Workers free + Durable Object SQLite** (spike: [SPIKE-HOSTING.md](./SPIKE-HOSTING.md)) | $0/month; DO output gates = the only *documented* guarantee compatible with the rotation of the single-use refresh token; `/auth`+`/callback` routes hosted → **re-auth from the phone** | Workers KV (eventually-consistent, read-your-own-writes not guaranteed) · Deno Deploy (excellent KV but a platform in churn) · val.town (code forced public on the free tier, longevity) · GH Actions (droppable cron) · Raspberry Pi Zero 2 W (= **plan B**: zero porting, but re-auth over SSH) |
| **Digest UX** | 1 summary notification + 1 **silent** message per tweet (rich preview); silent "nothing new ✨"; **⚠️ Telegram alert on failure** | A single ring in the morning, full previews, and the bot's silence is never ambiguous | All-in-one-message (a single preview) · sending nothing on empty days (indistinguishable from an outage) |

## 2. Target architecture

```
launchd (every day, 8:30am)
   └─▶ TypeScript bot (single run, ~10 s)
        1. refresh OAuth 2.0          → token rotation persisted ATOMICALLY
        2. GET /2/users/:id/bookmarks  ┐ max_results=25, tweet.fields, expansions
           GET /2/users/:id/liked_tweets ┘ (≈ $0.05/day max)
        3. ID diff vs state.json   → new items since the last run
        4. Telegram sendMessage (HTML): notifying summary + silent items with preview
        └─ global catch → "⚠️ the bot failed: …" message on Telegram

Local files (gitignored): tokens.json (secret), state.json
Config (.env): X_CLIENT_ID[, X_CLIENT_SECRET], TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
                [MAX_RESULTS=25, TWEET_LINK_DOMAIN=x.com]
```

## 3. Human prerequisites (one-time, ~20 min — blocking for E2+)

- [ ] Developer account on https://developer.x.com → project + app, **load credits** (card required; the minimum top-up amount is not publicly documented → to be observed at signup)
- [ ] In the X app: OAuth 2.0 enabled, type *Web App/Public client*, callback `http://127.0.0.1:8765/callback` (use `127.0.0.1`, not `localhost` — X docs recommendation) → note `X_CLIENT_ID` (+ secret if confidential client)
- [ ] Telegram: @BotFather → `/newbot` → `TELEGRAM_BOT_TOKEN`; send a message to the bot; read its `chat.id` via `https://api.telegram.org/bot<TOKEN>/getUpdates`
- [ ] Create `.env` at the root and fill it in (variables listed in §2; gitignored)

## 4. Implementation steps (TypeScript)

| # | Step | Content | Definition of done |
|---|---|---|---|
| E1 | Skeleton | Clean `npm init` + `src/`, TS execution (tsx **or** `node --experimental-strip-types` — to be decided), minimal .env loader, `.env.example` recreated, zero framework, native fetch | `npm run digest` runs as a dry run |
| E2 | X Auth | `npm run auth`: OAuth 2.0 + PKCE flow (ephemeral local server on 127.0.0.1, scopes `tweet.read users.read bookmark.read like.read offline.access`) → `tokens.json`; refresh with **atomic write** (single-use token). Flow and pitfalls (scopes, OAuth endpoints, single-use rotation): official docs.x.com docs | tokens obtained, refresh chained 2× without breaking |
| E3 | Fetch + diff | Minimal X client (2 endpoints), state.json, capped merge (~2000 IDs) | new items detected after a test bookmark |
| E4 | Telegram | Sender: summary + silent messages with `link_preview_options`, HTML escaping, splitting at 4096 chars, throttle ~1 msg/s; global error alert | e2e digest received on mobile **and** desktop |
| E5 | Local prod | launchd install script (8:30am, logs, `kickstart` to test); **1 week of observation**: real costs in the Developer Console, reliability of x.com previews | 7 consecutive digests without intervention |
| E6 | Cloud | Port to **Cloudflare Workers free** (decided, details: [SPIKE-HOSTING.md](./SPIKE-HOSTING.md)): tokens + state in a **Durable Object SQLite** behind a `Storage` abstraction, `/auth` + `/callback` routes on the workers.dev URL (secret URL + CSRF state), **double UTC cron** to hold 8:30am Europe/Paris summer/winter, **exclusive cutover** local→cloud (launchd bootout → seed tokens+state → local removal; never both in parallel) | digest received with the Mac off; re-auth tested from the phone |

Estimate: **2-4 h of cumulative dev** (E1-E5). Recurring cost: ~$1.50/month.

## 5. Open points (to verify at implementation time)

Settled during the E1-E5 implementation (2026-06-12):
- ~~SDK or direct fetch?~~ → **direct fetch**, zero runtime dependency (`twitter-api-v2` would have been a dependency to monitor for nothing).
- ~~tsx or `node --experimental-strip-types`?~~ → **native type stripping** (enabled by default since Node 22.18; Node 22.22 installed).

Still open:
- Minimum top-up amount for X credits (observed at signup).
- Actual quality of Telegram previews on `x.com` links (planned fallback: `TWEET_LINK_DOMAIN=fixupx.com`).
- Exact digest time (8:30am by default, a parameter of the install script).
- For E6 (details: SPIKE-HOSTING.md §5): the **10 ms of active CPU** on the Workers free tier, to be measured on a real run (network awaits don't count); the redirect URI is aligned with `http://127.0.0.1:8765/callback` as of 2026-06-12 (X docs recommendation — `src/auth.ts` and §3 above) — all that remains is adding the second cloud URI at E6.

## 6. Residual risks (known and accepted)

- **Rotation of the single-use X refresh token**: a failed write = manual re-auth (mitigated: atomic write + Telegram alert).
- API pricing "subject to change" (the schedule in the Developer Console is authoritative).
- An item bookmarked **then removed** between two runs slips under the radar; the 1st run establishes the baseline without a digest. Acceptable for the use case.
- Mac off at 8:30am = missed run (plain sleep = caught up on wake) → this is the motivation for E6.
- Bookmarks pagination capped at ~800 items on X's side (a non-issue at a daily cadence; a one-time historical backfill is possible via twitter-web-exporter).

## 7. Current contents of the repo

| File | Role |
|---|---|
| `PLAN.md` | This document — the reference for the implementation |
| `SPIKE-HOSTING.md` | E6 spike: hosting + hosted-auth strategy — justifies the Cloudflare Workers + Durable Object decision |
| `README.md` | How-to: prerequisites §3 step by step, installation, troubleshooting |
| `src/`, `tests/`, `scripts/` | E1-E5 implementation (TypeScript, zero runtime dependency) + tests + launchd scripts |

The temporary artifacts of the initial spike (scripts, state-of-the-art
reports, Python/Node dependencies) were removed after the decisions:
the useful conclusions are consolidated in §1 above.
