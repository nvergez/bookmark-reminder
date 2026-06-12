# bookmark-reminder

Bot TypeScript qui envoie chaque matin sur Telegram les bookmarks et likes X
ajoutés depuis la veille, via l'API X officielle en pay-per-use (~1,50 $/mois).
Décisions et architecture : [PLAN.md](./PLAN.md).

## Prérequis (une fois, ~20 min)

1. **Compte développeur X** sur https://developer.x.com : créer un projet et
   une app, puis **charger des crédits** (carte bancaire requise — le modèle
   est pay-per-use « Owned Reads » à 0,001 $/post, la grille du Developer
   Console fait foi ; le montant minimum de rechargement se constate à
   l'inscription).
2. **OAuth dans l'app X** : activer OAuth 2.0, type *Web App / Public client*,
   callback `http://127.0.0.1:8765/callback` (bien `127.0.0.1`, pas
   `localhost` — recommandation doc X). Noter le `X_CLIENT_ID` (et le
   secret uniquement si l'app est un client confidentiel).
3. **Bot Telegram** : parler à [@BotFather](https://t.me/BotFather) →
   `/newbot` → noter le `TELEGRAM_BOT_TOKEN`. Envoyer un message quelconque au
   bot, puis lire son `chat.id` dans la réponse de
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → `TELEGRAM_CHAT_ID`.
4. **Configuration** : `cp .env.example .env` et remplir les variables
   (`.env` est gitignoré).

## Installation

```sh
npm install                      # devDependencies uniquement (typescript, wrangler…)
npm run auth                     # OAuth 2.0 + PKCE → ouvre le navigateur, écrit tokens.json
npm run digest                   # test manuel : premier run = établit la référence
./scripts/install-launchd.sh    # planifie le digest quotidien (défaut 08:30)
./scripts/install-launchd.sh 07:45   # ou à l'heure de votre choix
```

Nécessite Node ≥ 22.18 (exécution TypeScript native, zéro dépendance runtime).

## Fonctionnement

- À l'heure planifiée, launchd lance `src/digest.ts` (~10 s) : refresh du
  token OAuth (rotation persistée atomiquement), lecture des bookmarks et
  likes, **diff d'IDs** contre `state.json` (X n'expose pas la date d'ajout
  d'un bookmark, seul le diff fonctionne).
- **Premier run** : il établit la référence, aucun digest n'est envoyé.
- Jours avec nouveautés : **1 message récap notifiant** + 1 message
  **silencieux** par tweet (aperçu riche dans le chat).
- Jours sans nouveauté : « rien de nouveau ✨ » silencieux — le silence total
  du bot n'est donc jamais ambigu.
- Toute erreur déclenche une **alerte ⚠️ sur Telegram**.

Fichiers locaux gitignorés : `tokens.json` (secret), `state.json`, `logs/`.

## Dépannage

- **« ⚠️ le bot a échoué »** mentionnant le token ou un 401 : le refresh token
  X est à usage unique ; s'il est perdu (écriture ratée, révocation), relancer
  `npm run auth`.
- **Logs** : `logs/digest.log` et `logs/digest.err.log` à la racine du repo.
- **Forcer un run** sans attendre demain :
  `launchctl kickstart -k gui/$UID/com.bookmark-reminder`
- **Aperçus de tweets médiocres** dans Telegram : mettre
  `TWEET_LINK_DOMAIN=fixupx.com` dans `.env`.
- **Désinstaller la planification** : `./scripts/uninstall-launchd.sh`.

## Coûts et observation

2 appels/jour × `MAX_RESULTS=25` → ≤ 50 posts/jour facturés à 0,001 $ pièce,
soit **~1,50 $/mois** (pire cas absolu avec `MAX_RESULTS=100` : ~6 $/mois).
Les tarifs sont « subject to change » : la grille du Developer Console fait
foi.

Garder un œil sur les coûts réels dans le Developer Console les premiers
jours (attendu : ~0,05 $/jour max).

## Cloud (E6) — Cloudflare Workers

Pour s'affranchir du Mac allumé, le bot se déploie sur **Cloudflare Workers
free + Durable Object SQLite** (décidé après spike, voir
[SPIKE-HOSTING.md](./SPIKE-HOSTING.md)). Le cœur du run (`src/run.ts` et les
modules partagés, sans aucun import `node:*`) est commun aux deux
environnements ; seuls les adaptateurs diffèrent (`src/digest.ts` en local,
`worker/index.ts` sur Cloudflare).

Déploiement :

1. Compte sur https://dash.cloudflare.com (free), puis `npx wrangler login`.
2. `npm run worker:deploy` → noter l'URL `https://bookmark-reminder.<sous-domaine>.workers.dev`.
3. Renseigner `BASE_URL` dans `wrangler.jsonc` avec cette URL, et poser les
   secrets : `npx wrangler secret put X_CLIENT_ID` (idem `X_CLIENT_SECRET`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, et `AUTH_URL_KEY` = 32+ octets
   aléatoires, ex. `openssl rand -base64 32`). Redéployer.
4. Dans l'app X (developer.x.com) : ajouter la callback
   `https://<worker>.workers.dev/callback` (la locale `127.0.0.1` peut rester,
   une app accepte jusqu'à 10 URIs).
5. **Bascule exclusive** local → cloud (le refresh token est à usage unique,
   jamais les deux en parallèle) : ouvrir les routes d'admin — `"ADMIN_API":
   "on"` dans `wrangler.jsonc` puis `npm run worker:deploy` —, puis
   `./scripts/uninstall-launchd.sh`, puis
   `AUTH_URL_KEY=… ./scripts/migrate-to-cloud.sh https://<worker>.workers.dev`
   — le script seed le Durable Object (tokens **et** state), déclenche un run
   de vérification et supprime les fichiers locaux périmés.
6. Refermer les routes d'admin : `"ADMIN_API": "off"` dans `wrangler.jsonc`
   puis `npm run worker:deploy`.
7. Mesurer le CPU réel du premier run (`npm run worker:tail`) — le free tier
   accorde 10 ms de CPU actif par invocation (les attentes réseau ne comptent
   pas) ; point ouvert §5 du spike.

Cron : deux triggers UTC (`30 6` et `30 7`) encadrent le changement d'heure ;
la garde `src/schedule.ts` ne laisse passer que celui qui tombe à
`DIGEST_PARIS_TIME` (08:30 Europe/Paris par défaut).

**Re-auth depuis n'importe quel navigateur** (téléphone compris) : ouvrir
`https://<worker>.workers.dev/auth?k=<AUTH_URL_KEY>` — les alertes Telegram
d'échec embarquent directement ce lien. Rollback cloud→local : voir la
sortie de `migrate-to-cloud.sh` (export symétrique tokens + state).

## Licence

[MIT](./LICENSE).
