# Spike E6 — Bot hosting & X auth strategy

> Spike completed on 2026-06-12: 5 options investigated (Cloudflare Workers,
> val.town, classic serverless, hosted X auth, self-host), with price/limit
> facts cross-checked as of today against the official docs (sources in the
> appendix). Goal: **where to host the daily run so we no longer depend on
> the Mac being powered on, and how to handle X auth in that context**
> (PLAN.md E6).
>
> A reminder of the two constraints that dominate everything: (1) the **X
> refresh token is single-use** — each run consumes it and must persist its
> replacement durably and consistently BEFORE continuing, otherwise it's a
> manual re-auth; (2) any OAuth (re)authorization requires a **browser + a
> redirect URI registered** in the X app (X does not support the device
> flow).

## TL;DR

| | Option | €/month | Verdict |
|---|---|---|---|
| ⭐ | **Cloudflare Workers + Durable Object SQLite** | **$0** | **THE pick.** The only storage in the field whose durability-before-continuing is *documented* (output gates), public `/auth`+`/callback` routes → re-auth from the phone, durable platform. Price: dual UTC cron for DST + the free 10 ms CPU to be measured. |
| 🥈 | **Raspberry Pi Zero 2 W** (plan B) | ~1.3 (amortized over 3 years) | **Zero porting**: the E1-E5 code runs as-is, local file = constraint 1 solved by construction, systemd handles DST natively. But re-auth = SSH tunnel from the laptop, not from the phone. |
| | Deno Deploy (Deno KV) | $0 | Technically excellent (strongly consistent KV, ACID transactions), but a platform mid-overhaul: Classic shutting down on 2026-07-20, KV queues dropped along the way. Too much churn for a service we want to forget about. |
| | val.town | $0 | Meets the requirements (transactional sqlite/Turso), but code is **necessarily public** on the free plan since May 2026, a 6-person company missing its targets and having just trimmed its free tier. |
| | Mac + `pmset` | $0 | Doesn't solve the problem: if the Mac travels, the run is skipped. That's "accepting gaps," not hosting. FileVault kills the power-on scenario. |
| | GitHub Actions | $0 | **Ruled out upfront**: cron explicitly droppable under load ("some queued jobs may be dropped"). |
| | AWS Lambda + EventBridge | $0 real | The only native `Europe/Paris` cron with automatic DST in the field — but a new account is closed after 6 months unless you move to a paid plan, and IAM/packaging are disproportionate for 10 s/day. |
| | GCP Cloud Run jobs | $0 | A respectable "big cloud" plan B (Scheduler with timezone), but container friction + service accounts for 150 lines. |
| | VPS (Hetzner/OVH), Fly.io, Railway, Render, Oracle free | €1-5 | Off-target (April 2026 increases: Hetzner €4.80 incl. tax, OVH €4.57 incl. tax) or pitfalls (Oracle reclaims idle instances; Fly has no fixed-time cron; Railway has a $5 floor). |

**Assumed recommendation: port the bot to Cloudflare Workers free with a
Durable Object SQLite as the single storage (tokens + state), `/auth` +
`/callback` routes hosted on the `workers.dev` URL. Cost: $0/month. Effort:
half a day to a day. Plan B if the port gets stuck (10 ms CPU exceeded,
allergy to dual-cron): Raspberry Pi Zero 2 W — ~€40 one-shot, zero lines
changed.**

---

## 1. The structuring constraint: refresh token rotation

Every run necessarily starts with a refresh (the X access token only lives
2 h — official doc), and every refresh **consumes** the refresh token: only
the last one issued is valid. The current code handles this via a local
atomic write (`fsUtil.ts`: tmp + fsync + rename, immediate persistence in
`getValidAccessToken` before any other work). When hosted, we need the
equivalent: **a write whose durability is confirmed before the run continues,
and a read that is never stale on the next run**.

This criterion sorts the field on its own:

- **Eliminates GitHub Actions**: no mutable storage provides the guarantee
  cleanly (cache evicted at 7 days and best-effort; artifacts immutable per
  run; git commit = token in plaintext in history unless you roll your own
  encryption; secrets rewritable via the API but unreadable and with no
  documented consistency guarantee). Combined with the droppable cron, it's
  dead.
- **Complicates Cloudflare KV**: eventually-consistent, read-your-own-writes
  explicitly not guaranteed by the doc. To be honest (a CORRECTED fact from
  the dossier): at a daily cadence (24 h between write and re-read, a single
  writer), KV would work *in practice* — the propagation window is ~60 s. But
  a cron retry or a manual run a few seconds after the normal run lands
  exactly back in the forbidden failure mode. When the Durable Object costs
  $0 more and offers the *documented* guarantee, you don't build the most
  critical component on a "it should be fine."
- **Validates by name**: Durable Objects (output gates: no outbound network
  message until the write is flushed to disk — the doc says, word for word,
  "impossible for any external party to observe the Object's actions unless
  the write actually succeeds"), Deno KV (external consistency, atomic
  transactions, "immediately durable"), val.town sqlite (Turso/libSQL,
  transactional commit), D1 (single primary), DynamoDB (conditional writes),
  Firestore — and, trivially, **any local POSIX filesystem** (Pi, VPS, Mac):
  the current code already does this.

Operational corollary, whatever the host: **a single holder of the token set
at any instant** (cf. §3.4) — the local launchd and the cloud cron must NEVER
run in parallel.

## 2. Analysis by option

### 2.1 ⭐ Cloudflare Workers + Durable Object SQLite — the pick

- **Token storage**: SQLite-backed DO, **available on the free plan**
  (100,000 DO req/day, 100,000 writes/day, 5 GB — we consume ~1 R/W per day,
  5 orders of magnitude under the quotas). Output gates = the exact guarantee
  of constraint 1, documented. A singleton DO (`idFromName("bot")`) holds
  `tokens` + `state` via `storage.get/put`; we can even put the whole
  refresh→fetch→diff→persist sequence in it, with the Telegram output then
  gated by token persistence. Bonus: the homegrown atomic write
  (`fsUtil.ts`) becomes unnecessary on the Worker side, output gates replace
  it (it survives in the fs implementation of the local fallback, cf. §4).
  Why the DO rather than D1, which is also validated in §1 (single primary):
  D1 has no equivalent of output gates (nothing holds back outbound messages
  until the write is flushed), and its read replication, if enabled, would
  reintroduce potentially stale reads — at identical cost ($0), the DO is
  strictly stronger.
- **8:30 Paris cron**: the weak point. Cron Triggers are **UTC only** → the
  standard idiom is 2 triggers (`30 7 * * *` winter CET, `30 6 * * *` summer
  CEST) + a `Intl.DateTimeFormat(..., {timeZone:'Europe/Paris'})` guard in
  `scheduled()` (full ICU in workerd). 1 no-op invocation per day,
  negligible. No precision SLA (best-effort, drift of seconds to minutes, one
  incident of silent crons recorded in March 2026) → keep the "no digest =
  failure" alert and, if we want a positive signal, a free healthchecks.io
  heartbeat (pinged only after an actual run: the no-op invocation of the
  wrong DST branch must NOT ping, otherwise it masks a missed run).
- **Auth**: a single Worker exports `{ fetch, scheduled }`; the free, stable
  `https://<name>.<account>.workers.dev` URL registers as a callback in the X
  app (10 slots available) → **re-auth from the phone**, the best answer to
  constraint 2 (details in §3).
- **Real cost**: **$0/month** (free tier: 100,000 req/day, 5 crons, DO SQLite
  included; usage ~0.002% of the quotas). The only threat: the **10 ms active
  CPU per invocation** limit on free (the wall-clock of `await fetch` doesn't
  count). The run — parsing a few tens of KB of JSON, diffing ~2000 IDs, HTML
  formatting — should fit in 2-5 ms, but **THIS is the thing to measure**
  (`wrangler tail`). Fallback: the $5/month paid plan (30 s CPU) — above the
  0-3 $ target, to be decided only if the measurement forces it.
- **Porting**: see §4 — half a day to a day. `nodejs_compat` covers
  `node:crypto`/`node:buffer`/`node:process`; `node:fs` exists but is an
  *in-memory, non-persistent* FS → storage moves to the DO; `node:http`
  (local callback) is replaced by the `fetch` handler.
- **Maintenance**: no Worker-deactivation-for-inactivity policy is documented
  (claim by absence — not positively verifiable, unlike Oracle's explicit
  reclamation policy); the free tier has historically been stable; wrangler
  as a devDependency to dust off from time to time. The best long-term
  profile in the serverless field.

### 2.2 🥈 Raspberry Pi Zero 2 W — the plan B (and the zero-porting champion)

- **Storage**: `tokens.json`/`state.json` stay local files, the existing
  atomic write is enough. **Constraint 1 solved by construction, zero lines
  changed.**
- **Cron**: systemd timer, `OnCalendar=*-*-* 08:30:00`, system timezone
  `Europe/Paris` → **native DST**, `Persistent=true` replays a missed run.
  Strictly superior to every serverless cron in the field.
- **Cost**: ~€13 excl. tax for the Zero 2 W (Farnell), ~€35-45 all-in (power
  supply, microSD); ~€1.70/year of electricity (≈1 W average at the 2026
  Tarif Bleu rate, €0.1940/kWh) → **~€1.3/month amortized over 3 years**,
  within target.
- **Compatibility**: 64-bit Cortex-A53, official Node 22 arm64 binaries, zero
  runtime dependency → the code runs as-is (Node ≥ 22.18 for type-stripping).
- **Auth — the real limitation**: the local redirect URI (written `localhost`
  at the time; aligned to `127.0.0.1` on 2026-06-12, cf. §3.5) stays usable
  via SSH tunnel (`ssh -L 8765:127.0.0.1:8765 pi@…` then `npm run auth`),
  but **no realistic re-auth from the phone alone**. The real case ("token
  dead, I'll redo it tonight on the laptop") is covered; the "away for a
  week" case is not.
- **Maintenance**: microSD wear (minimal here: a few KB/day), possible
  corruption on power loss, `unattended-upgrades`. The Telegram failure alert
  + the digest's silence detect the failure.

### 2.3 Deno Deploy — the challenger ruled out for churn

Deno KV is, on paper, the ideal storage: strong consistency (external
consistency), `kv.atomic()`, "immediately durable" writes, an oversized free
tier (1M req/month, 450k reads + 300k KV writes). `Deno.cron()` "at least
once" with retries (UTC only, same DST gymnastics), public URL for `/auth`.
**But**: Deploy Classic shuts down on 2026-07-20 with manual migration, the
legacy CLI is abandoned, KV queues are not carried over to the new platform,
and the new Deploy has "not yet" got KV backups. A platform that drops
features of its own KV along the way, to host precisely the component that
tolerates no loss — that's a no, not until the dust has settled. It would
remain a decent plan C if CF disappoints.

### 2.4 val.town — viable but fragile

Technically, it works: private sqlite per val (Turso, transactional) for the
tokens, blob or sqlite for the state, an HTTP val on a stable URL
(`handle-valname.web.val.run`) for auth, free cron (1 min wall-clock per run
— watch the 1 msg/s Telegram throttle: cap at ~50 messages), UTC only here
too. What disqualifies it against CF: since **May 2026, new free vals are
necessarily public** (the bot's code would be readable by anyone —
manageable, secrets and tokens live outside the code, but needlessly
exposed), Pro went from $10 to $25/month (out of budget, so free-or-nothing),
and the company (6 people, ~$7M raised) admitted in its May 2026 investor
update that it missed its growth target. A free tier already trimmed once =
it can be trimmed again. With weaker guarantees (no documented equivalent of
output gates) and less durability, there's no reason to prefer it.

### 2.5 The rest — ruled out with reasons

- **Mac + `pmset`**: doesn't address the root cause of E6. FileVault forces a
  login on every boot → only the "never off, sleeping, session open,
  plugged in" scenario works; a MacBook that travels = gaps. launchd catches
  up on wake (digest late rather than never) — that's the E5 status quo, not
  a hosting option.
- **GitHub Actions**: cron "may be dropped" + no native consistent storage
  (cf. §1). The commit-encrypted-in-the-repo hack exists but stacks an
  unreliable cron and homegrown crypto: a dealbreaker.
- **AWS Lambda + EventBridge Scheduler**: the only cron in the field with
  native `Europe/Paris` and automatic DST, impeccable DynamoDB, $0 real — but
  an AWS account created after 2025-07-15 is **closed after 6 months** unless
  upgraded to a paid plan (credit card + billing monitoring), and the
  IAM/packaging setup is disproportionate. Only worth considering if a
  pre-2025 AWS account is already lying around.
- **GCP Cloud Run jobs + Scheduler**: timezone OK (8:30 outside the risky DST
  window), permanent free tier, and Firestore (validated in §1) would meet
  constraint 1 for the tokens — but Dockerfile + Artifact Registry + service
  accounts + OIDC + Firestore for 150 lines: friction with no gain.
- **Vercel / Netlify / Azure Functions**: not retained. Vercel Hobby: cron
  limited to 1/day with documented **"Hourly (±59 min)"** precision ("a cron
  job configured as 0 1 * * * will trigger anywhere between 1:00 am and
  1:59 am") — unacceptable for a fixed-time digest. Netlify: scheduled
  functions on UTC cron, Netlify Blobs is *eventually consistent* by default
  (strong consistency option on demand, but no equivalent of output gates) —
  nothing better than CF on any axis. Azure Functions: not investigated in
  this spike; friction expected in the same family as AWS/GCP, to be looked
  at only if CF and the Pi both fell through. None of the three would change
  the recommendation.
- **VPS**: Hetzner CX23 €3.99 excl. tax (increase of 2026-04-01), OVH VPS-1
  €4.57 incl. tax with an annual commitment → off-target, and 3× the cost of
  the X API for 10 s of compute/day. **Oracle Always Free ARM**: now limited
  to 2 OCPU/12 GB, and above all Oracle **reclaims idle instances** (< 20%
  CPU/network/memory over 7 days) — a 10 s/day bot is the archetype of the
  target. A maintenance trap, no.
- **Railway / Render / Fly.io**: floors of $5/$1/~$2 per month for UTC crons
  with no built-in state storage, or no fixed time (Fly). Paying for worse:
  no.

## 3. Recommended auth strategy

Verified context: X supports **only** authorization code + PKCE and refresh
token (no device flow); an app accepts **up to 10 callback URLs** (https
mandatory outside local); the routine refresh itself is headless — the
browser is only required at (re)authorization.

**Chosen architecture: `/auth` + `/callback` routes hosted on the Worker
(family b), with an optional local seed for the initial cutover.**

1. **First auth**: your choice — (i) directly via
   `https://<worker>.workers.dev/auth` (the Worker generates a PKCE verifier
   + `state`, stores them in the DO, redirects to X; `/callback` checks the
   `state`, exchanges the code, persists into the DO); or (ii) keep the
   existing local `npm run auth` then push `tokens.json` into the DO via a
   one-shot import endpoint. (i) is recommended: it's the same code that will
   serve re-auths.
2. **Re-auth** (the expected failure mode: token lost/expired/invalidated):
   open `/auth` from **any browser, phone included**. The Telegram failure
   alert embeds the link directly: "⚠️ invalid token →
   https://…/auth?k=…". Painless re-auth = constraint 2 at its best.
3. **Public-route safeguards** (the risk is not theft — an attacker would
   only get THEIR tokens — but overwriting our tokens with theirs, and CSRF):
   - secret parameter on `/auth` (`?k=<32 random bytes>`, as a wrangler
     secret), carried over/verified via the `state` stored in the DO;
   - the flow's CSRF `state` protects `/callback`;
   - **after the code exchange, verify via `GET /2/users/me` that the `id`
     == our `userId` before persisting** — otherwise discard (the `userId`
     field already exists in `Tokens`). **A limitation to state plainly**:
     this safeguard is inapplicable to the very first auth via the Worker
     (option i) — the DO is empty, there is no reference `userId`; protection
     then falls back to `?k` alone. Either accept that (short window,
     unpublished URL), or seed the identity (the `userId`) into the DO before
     opening `/auth`;
   - **same safeguards on the import/export endpoint** (§3.4): an
     unauthenticated export on a public `workers.dev` URL = leak of the live
     access+refresh tokens; an unprotected import = token overwrite (DoS). At
     a minimum the same secret (`AUTH_URL_KEY`) as a parameter; ideally an
     ephemeral endpoint, **removed from the code and redeployed once the
     cutover is done**;
   - never log the tokens, neutral HTML response.
4. **Local → cloud cutover without double consumption** (mandatory order):
   1. `launchctl bootout gui/$UID/<label>` — **decommission launchd BEFORE
      any cloud run**; verify no run is in progress.
   2. Add the cloud callback to the X app (invalidates nothing, 10 slots).
   3. Seed the DO with the current `tokens.json` (or redo `/auth`, your
      choice — the seed avoids a re-authorization) **AND with the current
      `state.json`**. The state is not optional: without seeding, the first
      cloud run goes through `loadState → null → isFirstRun` (src/state.ts,
      src/digest.ts) and re-establishes the baseline **silently** — no digest
      that day, and any bookmark added between the cutover and that run is
      never reported. The import endpoint must therefore cover tokens **and**
      state (protected, cf. §3.3).
   4. Enable the cloud cron; on the first run it consumes the refresh token
      and persists the replacement **in the DO**. The local `tokens.json` is
      then stale: **delete it** to prevent any accidental local run.
   5. Symmetric rollback: stop the cloud cron, export **the tokens and the
      state** from the DO (same protected endpoint), recreate `tokens.json`
      and `state.json`, restart launchd — forgetting the state on rollback
      produces the same silent gap as in step 3.
   - Golden rule: **a single holder of the tokens at any instant**, never
     "local + cloud in parallel, just to test" — developers report that a
     second auth of the same account on the same app cuts off the tokens of
     the other environment (not officially documented, but the single-use
     rotation is enough to forbid it anyway).
5. **Correction to carry over into PLAN.md §3 — and into the code**: the X
   doc prescribes `http://127.0.0.1` ("not localhost") for local dev. Yet
   `src/auth.ts:23` hardcodes `REDIRECT_URI =
   'http://localhost:8765/callback'`, PLAN.md §3 prescribes `localhost`, and
   **E2-E5 worked that way** (7 digests OK in E5): the project's experience
   contradicts the cited doc — the rule is evidently not strictly enforced
   today. Align on `127.0.0.1` anyway (doc and code), out of caution: nothing
   guarantees X won't start enforcing it. *(aligned on 2026-06-12 in the wake
   of the spike)*

## 4. E6 implementation sketch (Cloudflare)

Code status: 1179 lines, zero runtime dependency, native `fetch` everywhere.
Whatever touches `node:*` is concentrated in 4 files — the existing layout
makes the port surgical.

| File (lines) | Fate in E6 | Effort |
|---|---|---|
| `x.ts` (160), `telegram.ts` (252), `types.ts` | **Unchanged** — native fetch, pure logic | 0 |
| `state.ts` (133) | `computeDiff` unchanged (pure); `loadState`/`saveState` → DO `storage.get/put` | ~20 l. |
| `tokens.ts` (183) | `parseTokenResponse`/`buildTokenRequest`/`isExpired` unchanged; `loadTokens`/`saveTokens` → DO (the Basic-auth `Buffer` works with `nodejs_compat`) | ~30 l. |
| `fsUtil.ts` (30) | **Out of the Worker build** — output gates replace tmp+fsync+rename on the DO side; the file **survives** in the fs implementation of the `Storage` interface (local fallback, cf. end of §4 and §5.7) | 0 |
| `digest.ts` (56) | `main()`/`process.exit` → `scheduled()` handler + Europe/Paris guard; sequence unchanged (refresh persisted first, state persisted after the Telegram send) | ~30 l. |
| `auth.ts` (250) | The ephemeral `node:http` server → 2 routes in `fetch`; PKCE unchanged if already on WebCrypto/supported `node:crypto`; + §3.3 safeguards | ~80-100 l. rewritten |
| `config.ts` (52) | `.env` → `env.*` bindings (wrangler secrets: `X_CLIENT_ID`, `X_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AUTH_URL_KEY`) | ~20 l. |
| *(new)* `wrangler.toml` + `BotDO` class | `nodejs_compat`, 2 crons (`30 6 * * *`, `30 7 * * *`), DO binding, `new_sqlite_classes`; DO ~60 l. (get/put + one-shot import/export endpoint, protected and ephemeral, cf. §3.3-§3.4) | ~80 l. |

Estimation note: the error messages that prescribe "rerun `npm run auth`"
(`tokens.ts:146,162` and `:50,55`, `state.ts`, and the hint in `x.ts:136` —
the latter makes "unchanged" a lie by one string) must be rewritten to embed
the `/auth?k=…` link promised in §3.2; count ~10-15 l. on top of the
estimates above.

Steps: (1) wrangler.toml + DO skeleton; (2) storage abstraction (replace the
4 load/save functions); (3) `export default { scheduled, fetch }` + DST
guard; (4) auth routes; (5) tests `wrangler dev --test-scheduled` + `curl
/__scheduled`; (6) **measure the real CPU via `wrangler tail`** (free-tier
go/no-go criterion); (7) cutover §3.4.

Two structural choices:

- **Put the whole run inside the DO** (RPC from `scheduled()`) rather than
  DO-as-simple-KV: the outbound Telegram messages are then held back until
  the token rotation is flushed — the strongest guarantee, for free.
- **Run order kept but hardened**: refresh → `await put(tokens)` as the very
  first action (CPU < 1 ms at that stage) — if the run dies afterwards (CPU
  limit, incident), we lose a digest, not the auth.

Important: these ~250 touched lines stay compatible with a return to local
(the E5 launchd plan remains the fallback) as long as we isolate the
load/save behind a mini `Storage` interface with two implementations (fs /
DO).

## 5. Residual risks and points to verify at implementation

1. **10 ms free CPU**: estimated 2-5 ms, **not measured**. To check first
   (`wrangler tail`). If exceeded: optimize, otherwise the $5/month paid plan
   (above target — the trade-off may then tip toward the Pi).
2. **Best-effort cron with no SLA** + an incident precedent (March 2026): a
   silently missed run remains possible. Mitigation: the absence of a digest
   is already the signal (UX chosen in PLAN §1); optional free
   healthchecks.io heartbeat — implementation pitfall: only ping after an
   actual run, never from the no-op invocation of the dual-cron, otherwise
   the heartbeat masks exactly the missed run it was meant to detect.
3. **DST dual-cron**: 2 nights a year, a bug in the guard would produce a
   digest at 7:30 or 9:30 — benign, but test both branches with a forced
   date.
4. **Crash between the X refresh call and the `put()`**: output gates
   guarantee the write's durability, not joint atomicity with the X network
   call. A window of a few ms, not eliminable on any platform (the local code
   has the same one); the alert + mobile re-auth is the mitigation.
5. **Spontaneous invalidations on X's side**: valid refresh tokens that die
   without being reused are reported on the X forum (a bug acknowledged by
   staff in 2022, recurrences 2025-2026). Local/cloud exclusivity is
   necessary but not sufficient → the re-auth path must stay one click away
   (hence family b).
6. **Facts not officially confirmed** (forum sources only, X doc silent):
   refresh token lifetime (~6 months) and its single-use nature; the "one
   auth cuts off the other" behavior between environments. Changeable without
   notice by X — the design (rotation persisted first, easy re-auth) depends
   on none of these figures.
7. **Cloudflare free tier evolution**: historically stable, no deactivation
   for inactivity — risk judged low, but the two-implementation `Storage`
   interface (§4) keeps the exit door (return to launchd or Pi) at ~0
   migration cost.
8. **To carry over into PLAN.md (and src/auth.ts:23)**: local callback
   `http://127.0.0.1:8765/callback` (not `localhost` — a cautionary alignment
   with the X doc, knowing that `localhost` worked in E2-E5, cf. §3.5;
   aligned on 2026-06-12 in the wake of the spike); E6 = rewritable storage
   for the tokens (never an immutable wrangler secret — it changes on every
   run); the exclusive cutover procedure from §3.4.

---

### Appendix — sources

Verified on 2026-06-12. The corrections from the cross-verification of the
research dossier are integrated into the text (notably: KV viable in theory
at a daily cadence but not retained; Oracle ARM reduced to 2 OCPU/12 GB).

**Cloudflare**
- Cron Triggers (UTC only, 5 free/account, 15 min propagation): developers.cloudflare.com/workers/configuration/cron-triggers/
- Limits (10 ms CPU free, 30 s paid, 15 min wall-clock cron): developers.cloudflare.com/workers/platform/limits/
- Workers pricing (free tier, $5/month plan): developers.cloudflare.com/workers/platform/pricing/
- KV eventually consistent, RYOW not guaranteed, DO recommendation: developers.cloudflare.com/kv/concepts/how-kv-works/ · developers.cloudflare.com/kv/reference/faq/ · developers.cloudflare.com/kv/api/read-key-value-pairs/
- DO Storage API (strong consistency, output gates, implicit transactions): developers.cloudflare.com/durable-objects/api/storage-api/ · blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
- DO SQLite on free (quotas): developers.cloudflare.com/durable-objects/platform/pricing/ · developers.cloudflare.com/durable-objects/platform/limits/
- nodejs_compat & in-memory node:fs: developers.cloudflare.com/workers/runtime-apis/nodejs/ · developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
- Storage options (KV vs DO vs D1 vs R2): developers.cloudflare.com/workers/platform/storage-options/
- Secrets: developers.cloudflare.com/workers/configuration/secrets/
- D1 read replication: developers.cloudflare.com/d1/best-practices/read-replication/
- March 2026 cron incident: community.cloudflare.com/t/the-cron-triggers-i-configured-will-no-longer-trigger-after-utc-sun-01-mar-2026-22/899645

**val.town**
- Pricing & free limits: val.town/pricing · val.town/limits · docs.val.town/vals/limitations/
- UTC-only cron: docs.val.town/vals/cron/
- sqlite (Turso) & blob: docs.val.town/std/sqlite/ · docs.val.town/std/blob/ · docs.turso.tech/sdk/ts/reference
- HTTP vals & env vars: docs.val.town/vals/http/routing/ · docs.val.town/reference/environment-variables/ · docs.val.town/reference/runtime/
- May 2026 changes (public vals, Pro $25) & investor update: blog.val.town/changelog-05262026 · blog.val.town/2026-may · blog.val.town/blog/seed/

**Classic serverless**
- GH Actions (dropped cron, 60 d, 7 d cache, secrets API): docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows · …/dependency-caching · docs.github.com/en/rest/actions/secrets · github.com/orgs/community/discussions/156282
- Deno Deploy/KV (consistency, pricing, Classic shutdown 2026-07-20, dropped queues): docs.deno.com/deploy/kv/manual/operations · docs.deno.com/deploy/kv/manual/cron/ · deno.com/deploy/pricing · docs.deno.com/deploy/classic/ · docs.deno.com/deploy/migration_guide/
- AWS (EventBridge timezone/DST, 6-month free plan): docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html · repost.aws/knowledge-center/eventbridge-scheduler-adjust-dst · docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html · aws.amazon.com/free/free-tier-faqs/
- GCP: docs.cloud.google.com/scheduler/docs/configuring/cron-job-schedules · cloud.google.com/scheduler/pricing · cloud.google.com/run/pricing
- Railway / Render / Fly: docs.railway.com/cron-jobs · railway.com/pricing · render.com/docs/cronjobs · fly.io/docs/blueprints/task-scheduling/ · fly.io/docs/about/pricing/
- Vercel Hobby cron (1/day, "Hourly (±59 min)" precision): vercel.com/docs/cron-jobs/usage-and-pricing
- Netlify (scheduled functions UTC cron; Blobs eventually consistent by default, strong optional): docs.netlify.com/build/functions/scheduled-functions/ · docs.netlify.com/build/data-and-storage/netlify-blobs/

**X auth**
- Developer apps (10 callbacks, https, 127.0.0.1 not localhost): docs.x.com/fundamentals/developer-apps · devcommunity.x.com/t/callback-urls-limit-10-urls/107762
- OAuth 2.0 (PKCE only, 2 h access token, exact match): docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code · …/oauth-2-0/overview
- Single-use / ~6-month refresh token (forum, not officially documented): devcommunity.x.com/t/refresh-token-expiring-with-offline-access-scope/168899 · …/176627 · …/224953 · …/240282
- Cross-environment invalidation (dev reports, not documented): devcommunity.x.com/t/refresh-tokens-randomly-expiring…/248555 · thread 173613 (bug acknowledged by staff)

**Self-host**
- pmset & FileVault: support.apple.com/guide/mac-help/mchl40376151/mac · support.apple.com/en-us/102316
- Pi Zero 2 W (price, power): fr.farnell.com (ref. 3838499) · raspberrypi.com (official price $15) · CNX Software / Jeff Geerling measurements
- Tarif Bleu 02/2026 (€0.1940/kWh): fournisseurs-electricite.com/contrat-electricite/prix
- Hetzner increase 04/2026: docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ · OVH: ovhcloud.com/fr/vps/cheap-vps/
- Oracle Always Free (2 OCPU/12 GB, idle reclamation): docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
