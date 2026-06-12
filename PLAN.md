# PLAN — Bot de rappel quotidien des bookmarks & likes X

> Décisions prises à l'issue du spike initial (2026-06). Ce document est la
> référence pour l'implémentation.
>
> **État : E1-E6 implémentés et validés en réel.** Bot local d'abord (auth,
> refresh 2×, détection, digest Telegram, launchd), puis E6 (tranché après
> spike, [SPIKE-HOSTING.md](./SPIKE-HOSTING.md)) : Worker Cloudflare +
> Durable Object SQLite (`worker/`), cœur du run partagé local/cloud
> (`src/run.ts` + interface `Storage`), bascule exclusive faite (tokens +
> state seedés dans le DO, routes admin refermées). **CPU mesuré : 4 ms**
> par run (free tier 10 ms → marge ×2,5 ; point ouvert §5 réglé).

## 1. Décisions actées

| Sujet | Choix | Pourquoi | Alternatives écartées |
|---|---|---|---|
| **Source des données** | **API X officielle, pay-per-use** | Légal et contractuel, « Owned Reads » à 0,001 $/post → **~1,50 $/mois** (max ~6 $), rate limits sans objet, hébergeable n'importe où | rettiwt-api (0 € mais contraire aux ToS + fenêtres de casse → reste le **plan B** documenté) · twikit (cassé depuis 03/2026) · twitterapi.io+GetXAPI (credentials confiés à des tiers, pas de lecture likes chez l'un) · Dewey/Tweetsmash (10-14 $/mois, dépendance SaaS) |
| **Canal de livraison** | **Telegram** | Gratuit, notifications natives mobile **et** desktop, aperçus riches des tweets dans le chat (le digest se lit sans ouvrir X), bot = 1 POST HTTPS | WhatsApp (friction Meta Business ou ban du numéro perso) · ntfy.sh (très bon mais rendu brut) · Discord (embeds X capricieux) · Pushover (payant, rendu pauvre) · email (notifications non fiables) |
| **Langage / stack** | **TypeScript (Node 22)** | Choix d'équipe ; fetch natif suffit ; ouvre naturellement le portage cloud (val.town / CF Workers = JS) | Python (les spikes l'étaient ; l'ébauche Python du bot a été supprimée) |
| **Détection « nouveau »** | **Diff d'IDs persisté** (state.json) | Contrainte structurelle vérifiée : X n'expose **jamais** la date d'ajout d'un bookmark/like, seulement la date du tweet | Filtrage par `created_at` (faux : on bookmarke des vieux tweets) |
| **Hébergement v1** | **launchd sur le Mac, 8h30** | Le 1er run OAuth exige un navigateur de toute façon ; zéro infra | Cloud d'emblée (prévu en option v2 : l'API officielle tolère les IPs datacenter, contrairement au scraping) |
| **Hébergement v2 (E6)** | **Cloudflare Workers free + Durable Object SQLite** (spike : [SPIKE-HOSTING.md](./SPIKE-HOSTING.md)) | 0 $/mois ; output gates des DO = seule garantie *documentée* compatible avec la rotation du refresh token à usage unique ; routes `/auth`+`/callback` hébergées → **re-auth depuis le téléphone** | Workers KV (eventually-consistent, read-your-own-writes non garanti) · Deno Deploy (KV excellent mais plateforme en churn) · val.town (code forcé public en free, pérennité) · GH Actions (cron droppable) · Raspberry Pi Zero 2 W (= **plan B** : zéro portage, mais re-auth par SSH) |
| **UX du digest** | 1 notification récap + 1 message **silencieux** par tweet (aperçu riche) ; « rien de nouveau ✨ » silencieux ; **alerte ⚠️ Telegram en cas d'échec** | Une seule sonnerie le matin, previews complets, et le silence du bot n'est jamais ambigu | Tout-en-un-message (un seul aperçu) · ne rien envoyer les jours vides (indistinguable d'une panne) |

## 2. Architecture cible

```
launchd (tous les jours, 8h30)
   └─▶ bot TypeScript (run unique, ~10 s)
        1. refresh OAuth 2.0          → rotation du token persistée ATOMIQUEMENT
        2. GET /2/users/:id/bookmarks  ┐ max_results=25, tweet.fields, expansions
           GET /2/users/:id/liked_tweets ┘ (≈ 0,05 $/jour max)
        3. diff d'IDs vs state.json   → nouveautés depuis le dernier run
        4. Telegram sendMessage (HTML) : récap notifiant + items silencieux avec preview
        └─ catch global → message « ⚠️ le bot a échoué : … » sur Telegram

Fichiers locaux (gitignorés) : tokens.json (secret), state.json
Config (.env) : X_CLIENT_ID[, X_CLIENT_SECRET], TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
                [MAX_RESULTS=25, TWEET_LINK_DOMAIN=x.com]
```

## 3. Prérequis humains (une fois, ~20 min — bloquants pour E2+)

- [ ] Compte développeur sur https://developer.x.com → projet + app, **charger des crédits** (CB requise ; le montant minimum de top-up n'est pas documenté publiquement → à constater à l'inscription)
- [ ] Dans l'app X : OAuth 2.0 activé, type *Web App/Public client*, callback `http://127.0.0.1:8765/callback` (bien `127.0.0.1`, pas `localhost` — recommandation doc X) → noter `X_CLIENT_ID` (+ secret si client confidentiel)
- [ ] Telegram : @BotFather → `/newbot` → `TELEGRAM_BOT_TOKEN` ; envoyer un message au bot ; lire son `chat.id` via `https://api.telegram.org/bot<TOKEN>/getUpdates`
- [ ] Créer `.env` à la racine et remplir (variables listées au §2 ; gitignoré)

## 4. Étapes d'implémentation (TypeScript)

| # | Étape | Contenu | Critère de done |
|---|---|---|---|
| E1 | Squelette | `npm init` propre + `src/`, exécution TS (tsx **ou** `node --experimental-strip-types` — à trancher), chargeur .env minimal, `.env.example` recréé, zéro framework, fetch natif | `npm run digest` s'exécute à blanc |
| E2 | Auth X | `npm run auth` : flow OAuth 2.0 + PKCE (serveur local éphémère sur 127.0.0.1, scopes `tweet.read users.read bookmark.read like.read offline.access`) → `tokens.json` ; refresh avec **écriture atomique** (token à usage unique). Flow et pièges (scopes, endpoints OAuth, rotation à usage unique) : doc officielle docs.x.com | tokens obtenus, refresh enchaîné 2× sans casse |
| E3 | Fetch + diff | Client X minimal (2 endpoints), state.json, merge plafonné (~2000 IDs) | nouveautés détectées après un bookmark de test |
| E4 | Telegram | Sender : récap + messages silencieux avec `link_preview_options`, échappement HTML, découpe à 4096 chars, throttle ~1 msg/s ; alerte d'erreur globale | digest e2e reçu sur mobile **et** desktop |
| E5 | Prod locale | Script d'installation launchd (8h30, logs, `kickstart` pour tester) ; **1 semaine d'observation** : coûts réels dans le Developer Console, fiabilité des previews x.com | 7 digests consécutifs sans intervention |
| E6 | Cloud | Portage **Cloudflare Workers free** (décidé, détail : [SPIKE-HOSTING.md](./SPIKE-HOSTING.md)) : tokens + state dans un **Durable Object SQLite** derrière une abstraction `Storage`, routes `/auth` + `/callback` sur l'URL workers.dev (URL secrète + state CSRF), **double cron UTC** pour tenir 8h30 Europe/Paris été/hiver, **bascule exclusive** local→cloud (bootout launchd → seed tokens+state → suppression locale ; jamais les deux en parallèle) | digest reçu Mac éteint ; re-auth testée depuis le téléphone |

Estimation : **2-4 h de dev cumulées** (E1-E5). Coût récurrent : ~1,50 $/mois.

## 5. Points ouverts (à vérifier au moment de l'implémentation)

Tranchés à l'implémentation E1-E5 (2026-06-12) :
- ~~SDK ou fetch direct ?~~ → **fetch direct**, zéro dépendance runtime (`twitter-api-v2` aurait été une dépendance à surveiller pour rien).
- ~~tsx ou `node --experimental-strip-types` ?~~ → **type stripping natif** (activé par défaut depuis Node 22.18 ; Node 22.22 installé).

Restent ouverts :
- Montant minimum de rechargement des crédits X (constaté à l'inscription).
- Qualité réelle des aperçus Telegram sur les liens `x.com` (fallback prévu : `TWEET_LINK_DOMAIN=fixupx.com`).
- Heure exacte du digest (8h30 par défaut, paramètre du script d'install).
- Pour E6 (détail : SPIKE-HOSTING.md §5) : les **10 ms de CPU actif** du free tier Workers à mesurer sur un run réel (les await réseau ne comptent pas) ; la redirect URI est alignée sur `http://127.0.0.1:8765/callback` depuis le 2026-06-12 (recommandation doc X — `src/auth.ts` et §3 ci-dessus) — il ne reste que l'ajout de la deuxième URI cloud à E6.

## 6. Risques résiduels (connus et acceptés)

- **Rotation du refresh token** X à usage unique : une écriture ratée = re-auth manuelle (mitigé : écriture atomique + alerte Telegram).
- Tarifs API « subject to change » (la grille fait foi dans le Developer Console).
- Un item bookmarké **puis retiré** entre deux runs passe sous le radar ; le 1er run établit la référence sans digest. Acceptable pour l'usage.
- Mac éteint à 8h30 = run manqué (simple veille = rattrapé au réveil) → c'est la motivation de E6.
- Pagination bookmarks plafonnée ~800 items côté X (sans objet en rythme quotidien ; backfill historique possible une fois via twitter-web-exporter).

## 7. Contenu actuel du repo

| Fichier | Rôle |
|---|---|
| `PLAN.md` | Ce document — la référence pour l'implémentation |
| `SPIKE-HOSTING.md` | Spike E6 : hébergement + stratégie d'auth hébergée — justifie la décision Cloudflare Workers + Durable Object |
| `README.md` | Mode d'emploi : prérequis §3 pas à pas, installation, dépannage |
| `src/`, `tests/`, `scripts/` | Implémentation E1-E5 (TypeScript, zéro dépendance runtime) + tests + scripts launchd |

Les artefacts temporaires du spike initial (scripts, rapports d'état de
l'art, dépendances Python/Node) ont été supprimés après les arbitrages :
les conclusions utiles sont consolidées dans le §1 ci-dessus.
