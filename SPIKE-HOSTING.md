# Spike E6 — Hébergement du bot & stratégie d'auth X

> Spike réalisé le 2026-06-12 : 5 pistes instruites (Cloudflare Workers,
> val.town, serverless classique, auth X hébergée, self-host), faits
> prix/limites contre-vérifiés à la date du jour sur les docs officielles
> (sources en annexe). Objet : **où héberger le run quotidien pour
> s'affranchir du Mac allumé, et comment gérer l'auth X dans ce contexte**
> (PLAN.md E6).
>
> Rappel des deux contraintes qui dominent tout : (1) le **refresh token X
> est à usage unique** — chaque run le consomme et doit persister son
> remplaçant de façon durable et cohérente AVANT de continuer, sinon
> re-auth manuelle ; (2) toute (ré)autorisation OAuth exige un
> **navigateur + une redirect URI enregistrée** dans l'app X (X ne
> supporte pas le device flow).

## TL;DR

| | Option | €/mois | Verdict |
|---|---|---|---|
| ⭐ | **Cloudflare Workers + Durable Object SQLite** | **0 $** | **LA reco.** Seul stockage du panel dont la durabilité-avant-poursuite est *documentée* (output gates), routes `/auth`+`/callback` publiques → re-auth depuis le téléphone, plateforme pérenne. Prix : double cron UTC pour le DST + 10 ms CPU free à mesurer. |
| 🥈 | **Raspberry Pi Zero 2 W** (plan B) | ~1,3 (amorti 3 ans) | **Zéro portage** : le code E1-E5 tourne tel quel, fichier local = contrainte 1 résolue par construction, systemd gère le DST nativement. Mais re-auth = tunnel SSH depuis le laptop, pas depuis le téléphone. |
| | Deno Deploy (Deno KV) | 0 $ | Techniquement excellent (KV fortement cohérent, transactions ACID), mais plateforme en pleine refonte : Classic fermé le 20/07/2026, queues KV abandonnées en route. Trop de churn pour un service qu'on veut oublier. |
| | val.town | 0 $ | Tient le cahier des charges (sqlite/Turso transactionnel), mais code **forcément public** en free depuis mai 2026, boîte de 6 personnes qui rate ses objectifs et vient de rabotter son free tier. |
| | Mac + `pmset` | 0 $ | Ne résout pas le problème : si le Mac voyage, le run saute. C'est « accepter des trous », pas héberger. FileVault tue le scénario power-on. |
| | GitHub Actions | 0 $ | **Écarté d'office** : cron explicitement droppable en charge (« some queued jobs may be dropped »). |
| | AWS Lambda + EventBridge | 0 $ réel | Le seul cron `Europe/Paris` natif avec DST automatique du panel — mais compte neuf fermé après 6 mois sauf passage en plan payant, et IAM/packaging disproportionnés pour 10 s/jour. |
| | GCP Cloud Run jobs | 0 $ | Plan B « gros cloud » honorable (Scheduler avec timezone), mais friction conteneur + service accounts pour 150 lignes. |
| | VPS (Hetzner/OVH), Fly.io, Railway, Render, Oracle free | 1-5 € | Hors cible (hausses avril 2026 : Hetzner 4,80 € TTC, OVH 4,57 € TTC) ou pièges (Oracle réclame les instances idle ; Fly sans cron à heure fixe ; Railway plancher 5 $). |

**Reco assumée : porter le bot sur Cloudflare Workers free avec un Durable
Object SQLite comme stockage unique (tokens + state), routes `/auth` +
`/callback` hébergées sur l'URL `workers.dev`. Coût : 0 $/mois. Effort :
une demi-journée à une journée. Plan B si le portage coince (10 ms CPU
dépassées, allergie au double-cron) : Raspberry Pi Zero 2 W — ~40 € one-shot,
zéro ligne modifiée.**

---

## 1. La contrainte structurante : la rotation du refresh token

Chaque run commence obligatoirement par un refresh (l'access token X ne vit
que 2 h — doc officielle), et chaque refresh **consomme** le refresh token :
seul le dernier émis est valide. Le code actuel le gère par écriture atomique
locale (`fsUtil.ts` : tmp + fsync + rename, persistance immédiate dans
`getValidAccessToken` avant tout autre travail). En hébergé, il faut
l'équivalent : **une écriture dont la durabilité est confirmée avant que le
run continue, et une lecture jamais périmée au run suivant**.

Ce critère trie le panel nominalement :

- **Élimine GitHub Actions** : aucun stockage mutable n'offre la garantie
  proprement (cache évincé à 7 j et best-effort ; artifacts immuables par
  run ; commit git = token en clair dans l'historique sauf chiffrement
  maison ; secrets réinscriptibles par l'API mais illisibles et sans
  garantie de cohérence documentée). Combiné au cron droppable, c'est mort.
- **Complique Cloudflare KV** : eventually-consistent, read-your-own-writes
  explicitement non garanti par la doc. Honnêteté oblige (fait CORRIGÉ du
  dossier) : à cadence quotidienne (24 h entre écriture et relecture, un
  seul writer), KV marcherait *en pratique* — la fenêtre de propagation est
  ~60 s. Mais un retry du cron ou un run manuel quelques secondes après le
  run normal retombe exactement dans le mode de panne interdit. Quand le
  Durable Object coûte 0 $ de plus et offre la garantie *documentée*, on ne
  construit pas le composant le plus critique sur un « ça devrait passer ».
- **Valide nommément** : Durable Objects (output gates : aucun message
  réseau sortant tant que l'écriture n'est pas flushée sur disque — la doc
  dit mot pour mot « impossible for any external party to observe the
  Object's actions unless the write actually succeeds »), Deno KV
  (external consistency, transactions atomiques, « immediately durable »),
  sqlite val.town (Turso/libSQL, commit transactionnel), D1 (primary
  unique), DynamoDB (écritures conditionnelles), Firestore — et,
  trivialement, **tout filesystem POSIX local** (Pi, VPS, Mac) : le code
  actuel le fait déjà.

Corollaire opérationnel, quel que soit l'hébergeur : **un seul détenteur du
jeu de tokens à tout instant** (cf. §3.4) — le launchd local et le cron cloud
ne doivent JAMAIS tourner en parallèle.

## 2. Analyse par option

### 2.1 ⭐ Cloudflare Workers + Durable Object SQLite — la reco

- **Stockage tokens** : DO SQLite-backed, **disponible sur le plan free**
  (100 000 req DO/jour, 100 000 écritures/jour, 5 GB — on consomme ~1 R/W
  par jour, 5 ordres de grandeur sous les quotas). Output gates = la
  garantie exacte de la contrainte 1, documentée. Un DO singleton
  (`idFromName("bot")`) détient `tokens` + `state` via `storage.get/put` ;
  on peut même y mettre toute la séquence refresh→fetch→diff→persist, la
  sortie Telegram étant alors gatée par la persistance du token. Bonus :
  l'écriture atomique maison (`fsUtil.ts`) devient inutile côté Worker,
  les output gates la remplacent (elle survit dans l'implémentation fs du
  fallback local, cf. §4). Pourquoi le DO plutôt que D1, pourtant validé
  au §1 (primary unique) : D1 n'a pas d'équivalent des output gates (rien
  ne retient les messages sortants tant que l'écriture n'est pas flushée),
  et sa read replication, si elle était activée, réintroduirait des
  lectures potentiellement périmées — à coût identique (0 $), le DO est
  strictement plus fort.
- **Cron 8h30 Paris** : le point faible. Cron Triggers en **UTC
  uniquement** → l'idiome standard est 2 triggers (`30 7 * * *` hiver CET,
  `30 6 * * *` été CEST) + garde-fou `Intl.DateTimeFormat(...,
  {timeZone:'Europe/Paris'})` dans `scheduled()` (ICU complet dans
  workerd). 1 invocation à blanc par jour, négligeable. Pas de SLA de
  précision (best-effort, dérive de secondes à minutes, un incident de
  crons muets recensé en mars 2026) → garder l'alerte « pas de digest =
  panne » et, si on veut du positif, un heartbeat healthchecks.io gratuit
  (pingé uniquement après un run effectif : l'invocation à blanc de la
  mauvaise branche DST ne doit PAS pinger, sinon elle masque un run
  manqué).
- **Auth** : un même Worker exporte `{ fetch, scheduled }` ; l'URL
  `https://<nom>.<compte>.workers.dev` gratuite et stable s'enregistre
  comme callback dans l'app X (10 slots disponibles) → **re-auth depuis le
  téléphone**, la meilleure réponse à la contrainte 2 (détail §3).
- **Coût réel** : **0 $/mois** (free tier : 100 000 req/jour, 5 crons, DO
  SQLite inclus ; usage ~0,002 % des quotas). Seule menace : la limite de
  **10 ms de CPU actif par invocation** en free (le wall-clock des `await
  fetch` ne compte pas). Le run — parse de quelques dizaines de KB de
  JSON, diff de ~2000 IDs, formatage HTML — devrait tenir en 2-5 ms, mais
  **c'est LE point à mesurer** (`wrangler tail`). Fallback : plan payé
  5 $/mois (30 s CPU) — au-dessus de la cible 0-3 $, à arbitrer seulement
  si la mesure l'impose.
- **Portage** : voir §4 — une demi-journée à une journée. `nodejs_compat`
  couvre `node:crypto`/`node:buffer`/`node:process` ; `node:fs` existe
  mais est un FS *en mémoire non persistant* → le stockage passe au DO ;
  `node:http` (callback local) est remplacé par le handler `fetch`.
- **Maintenance** : aucune politique de désactivation des Workers pour
  inactivité n'est documentée (affirmation par absence — invérifiable
  positivement, contrairement à la politique de reclamation explicite
  d'Oracle) ; free tier historiquement stable ; wrangler en devDependency
  à dépoussiérer de temps en temps. Le meilleur profil long terme du panel
  serverless.

### 2.2 🥈 Raspberry Pi Zero 2 W — le plan B (et le champion du zéro-portage)

- **Stockage** : `tokens.json`/`state.json` restent des fichiers locaux,
  l'écriture atomique existante suffit. **Contrainte 1 résolue par
  construction, zéro ligne modifiée.**
- **Cron** : systemd timer, `OnCalendar=*-*-* 08:30:00`, timezone système
  `Europe/Paris` → **DST natif**, `Persistent=true` rejoue un run manqué.
  Strictement supérieur à tous les crons serverless du panel.
- **Coût** : ~13 € HT le Zero 2 W (Farnell), ~35-45 € tout compris (alim,
  microSD) ; ~1,70 €/an d'électricité (≈1 W moyen au Tarif Bleu 2026,
  0,1940 €/kWh) → **~1,3 €/mois amorti sur 3 ans**, dans la cible.
- **Compatibilité** : Cortex-A53 64 bits, binaires Node 22 arm64 officiels,
  zéro dépendance runtime → le code tourne tel quel (Node ≥ 22.18 pour le
  type-stripping).
- **Auth — la vraie limite** : la redirect URI locale (écrite `localhost`
  à l'époque ; alignée sur `127.0.0.1` le 2026-06-12, cf. §3.5) reste
  valable via tunnel SSH (`ssh -L 8765:127.0.0.1:8765 pi@…` puis
  `npm run auth`),
  mais **pas de re-auth réaliste depuis le téléphone seul**. Le cas réel
  (« token mort, je le referai ce soir au laptop ») est couvert ; le cas
  « en déplacement une semaine » ne l'est pas.
- **Maintenance** : usure microSD (minime ici : quelques Ko/jour),
  corruption sur coupure secteur possible, `unattended-upgrades`. L'alerte
  Telegram d'échec + le silence du digest détectent la panne.

### 2.3 Deno Deploy — le challenger écarté pour churn

Deno KV est, sur le papier, le stockage idéal : cohérence forte (external
consistency), `kv.atomic()`, écritures « immediately durable », free tier
surdimensionné (1M req/mois, 450k lectures + 300k écritures KV). Cron
`Deno.cron()` « at least once » avec retries (UTC seul, même gymnastique
DST), URL publique pour `/auth`. **Mais** : Deploy Classic ferme le
20/07/2026 avec migration manuelle, la CLI historique est abandonnée, les
queues KV ne sont pas reprises sur la nouvelle plateforme, et le nouveau
Deploy n'a « pas encore » de backups KV. Une plateforme qui abandonne des
features de son KV en route, pour héberger précisément le composant qui ne
tolère aucune perte, c'est non — pas tant que la poussière n'est pas
retombée. Resterait un plan C correct si CF déçoit.

### 2.4 val.town — viable mais fragile

Techniquement, ça passe : sqlite privé par val (Turso, transactionnel) pour
les tokens, blob ou sqlite pour le state, HTTP val à URL stable
(`handle-valname.web.val.run`) pour l'auth, cron free (1 min wall-clock par
run — attention au throttle Telegram 1 msg/s : plafonner à ~50 messages),
UTC seul là aussi. Ce qui le disqualifie face à CF : depuis **mai 2026, les
nouveaux vals free sont obligatoirement publics** (le code du bot serait
lisible par tous — gérable, secrets et tokens vivent hors code, mais
inutilement exposé), le Pro est passé de 10 à 25 $/mois (hors budget, donc
free-ou-rien), et la boîte (6 personnes, ~7 M$ levés) a admis dans son
update investisseurs de mai 2026 avoir raté son objectif de croissance.
Free tier déjà raboté une fois = il peut l'être encore. À garanties
inférieures (pas d'équivalent documenté des output gates) et pérennité
moindre, aucune raison de le préférer.

### 2.5 Le reste — écarté avec raisons

- **Mac + `pmset`** : ne traite pas la cause de E6. FileVault impose un
  login à chaque démarrage → seul le scénario « jamais éteint, en veille,
  session ouverte, branché » marche ; un MacBook qui voyage = trous.
  launchd rattrape au réveil (digest en retard plutôt que jamais) — c'est
  le statu quo E5, pas une option d'hébergement.
- **GitHub Actions** : cron « may be dropped » + aucun stockage cohérent
  natif (cf. §1). Le bricolage commit-chiffré-dans-le-repo existe mais
  cumule cron non fiable et crypto maison : rédhibitoire.
- **AWS Lambda + EventBridge Scheduler** : le seul cron du panel avec
  `Europe/Paris` natif et DST automatique, DynamoDB impeccable, 0 $ réel —
  mais un compte AWS créé après le 15/07/2025 est **fermé après 6 mois**
  sauf upgrade en plan payant (CB + surveillance de facturation), et le
  setup IAM/packaging est disproportionné. À ne considérer que si un
  compte AWS pré-2025 traîne déjà.
- **GCP Cloud Run jobs + Scheduler** : timezone OK (8h30 hors de la
  fenêtre DST à risque), free tier permanent, et Firestore (validé au §1)
  répondrait à la contrainte 1 pour les tokens — mais Dockerfile +
  Artifact Registry + service accounts + OIDC + Firestore pour 150
  lignes : friction sans gain.
- **Vercel / Netlify / Azure Functions** : non retenus. Vercel Hobby :
  cron limité à 1/jour avec précision **« Hourly (±59 min) »** documentée
  (« a cron job configured as 0 1 * * * will trigger anywhere between
  1:00 am and 1:59 am ») — inacceptable pour un digest à heure fixe.
  Netlify : scheduled functions en cron UTC, Netlify Blobs est
  *eventually consistent* par défaut (option strong consistency à la
  demande, mais pas d'équivalent des output gates) — rien de mieux que CF
  sur aucun axe. Azure Functions : non instruit dans ce spike ; friction
  attendue de la même famille que AWS/GCP, à n'instruire que si CF et le
  Pi tombaient tous deux. Aucun des trois ne changerait la reco.
- **VPS** : Hetzner CX23 3,99 € HT (hausse du 01/04/2026), OVH VPS-1
  4,57 € TTC avec engagement annuel → hors cible, et 3× le coût de l'API X
  pour 10 s de calcul/jour. **Oracle Always Free ARM** : désormais limité
  à 2 OCPU/12 Go, et surtout Oracle **réclame les instances idle**
  (< 20 % CPU/réseau/mémoire sur 7 j) — un bot de 10 s/jour est
  l'archétype de la cible. Piège de maintenance, non.
- **Railway / Render / Fly.io** : planchers 5 $/1 $/~2 $ par mois pour des
  crons UTC sans stockage d'état intégré, ou sans heure fixe (Fly). Payer
  pour moins bien : non.

## 3. Stratégie d'auth recommandée

Contexte vérifié : X ne supporte **que** authorization code + PKCE et
refresh token (pas de device flow) ; une app accepte **jusqu'à 10 callback
URLs** (https obligatoire hors local) ; le refresh courant, lui, est
headless — le navigateur n'est requis qu'à la (ré)autorisation.

**Architecture retenue : routes `/auth` + `/callback` hébergées sur le
Worker (famille b), avec seed local optionnel pour la bascule initiale.**

1. **Premier auth** : au choix — (i) directement via
   `https://<worker>.workers.dev/auth` (le Worker génère verifier PKCE +
   `state`, les stocke dans le DO, redirige vers X ; `/callback` vérifie le
   `state`, échange le code, persiste dans le DO) ; ou (ii) garder le
   `npm run auth` local existant puis pousser `tokens.json` dans le DO via
   un endpoint d'import one-shot. (i) est recommandé : c'est le même code
   qui servira aux re-auth.
2. **Re-auth** (le mode de panne attendu : token perdu/expiré/invalidé) :
   ouvrir `/auth` depuis **n'importe quel navigateur, téléphone compris**.
   L'alerte Telegram d'échec embarque directement le lien :
   « ⚠️ token invalide → https://…/auth?k=… ». Re-auth indolore = la
   contrainte 2 au mieux.
3. **Garde-fous des routes publiques** (le risque n'est pas le vol — un
   attaquant n'obtiendrait que SES tokens — mais l'écrasement de nos tokens
   par les siens, et le CSRF) :
   - paramètre secret sur `/auth` (`?k=<32 octets aléatoires>`, en secret
     wrangler), reporté/vérifié via le `state` stocké dans le DO ;
   - le `state` CSRF du flow protège `/callback` ;
   - **après l'échange de code, vérifier via `GET /2/users/me` que l'`id`
     == notre `userId` avant de persister** — sinon jeter (le champ
     `userId` existe déjà dans `Tokens`). **Limite à dire franchement** :
     ce garde-fou est inapplicable au tout premier auth via le Worker
     (option i) — le DO est vide, pas de `userId` de référence ; la
     protection retombe alors sur `?k` seul. Soit on l'accepte (fenêtre
     courte, URL non publiée), soit on seed l'identité (le `userId`) dans
     le DO avant d'ouvrir `/auth` ;
   - **mêmes garde-fous sur l'endpoint d'import/export** (§3.4) : un
     export non authentifié sur une URL `workers.dev` publique =
     fuite des access+refresh tokens vivants ; un import non protégé =
     écrasement des tokens (DoS). A minima le même secret (`AUTH_URL_KEY`)
     en paramètre ; idéalement endpoint éphémère, **supprimé du code et
     redéployé une fois la bascule faite** ;
   - ne jamais logger les tokens, réponse HTML neutre.
4. **Bascule local → cloud sans double consommation** (ordre impératif) :
   1. `launchctl bootout gui/$UID/<label>` — **décommissionner launchd
      AVANT tout run cloud** ; vérifier qu'aucun run n'est en cours.
   2. Ajouter la callback cloud dans l'app X (n'invalide rien, 10 slots).
   3. Seeder le DO avec le `tokens.json` courant (ou refaire `/auth`,
      au choix — le seed évite une ré-autorisation) **ET avec le
      `state.json` courant**. Le state n'est pas optionnel : sans seed,
      le premier run cloud passe par `loadState → null → isFirstRun`
      (src/state.ts, src/digest.ts) et ré-établit la baseline
      **silencieusement** — pas de digest ce jour-là, et tout bookmark
      ajouté entre la bascule et ce run n'est jamais signalé. L'endpoint
      d'import doit donc couvrir tokens **et** state (protégé, cf. §3.3).
   4. Activer le cron cloud ; au premier run il consomme le refresh token
      et persiste le remplaçant **dans le DO**. Le `tokens.json` local est
      alors périmé : **le supprimer** pour s'interdire tout run local
      accidentel.
   5. Rollback symétrique : couper le cron cloud, exporter **les tokens
      et le state** du DO (même endpoint protégé), recréer `tokens.json`
      et `state.json`, relancer launchd — oublier le state au rollback
      produit le même trou silencieux qu'au point 3.
   - Règle d'or : **un seul détenteur des tokens à tout instant**, jamais
     de « local + cloud en parallèle, juste pour tester » — des
     développeurs rapportent qu'une seconde auth du même compte sur la même
     app coupe les tokens de l'autre environnement (non documenté
     officiellement, mais la rotation usage-unique suffit de toute façon à
     l'interdire).
5. **Correction à reporter dans PLAN.md §3 — et dans le code** : la doc X
   prescrit `http://127.0.0.1` (« not localhost ») pour le dev local. Or
   `src/auth.ts:23` hardcode `REDIRECT_URI =
   'http://localhost:8765/callback'`, PLAN.md §3 prescrit `localhost`, et
   **E2-E5 ont fonctionné ainsi** (7 digests OK en E5) : l'expérience du
   projet contredit la doc citée — la règle n'est visiblement pas
   appliquée strictement aujourd'hui. Aligner quand même sur `127.0.0.1`
   (doc et code), par prudence : rien ne garantit que X ne se mette pas à
   l'appliquer. *(aligné le 2026-06-12 dans la foulée du spike)*

## 4. Esquisse d'implémentation E6 (Cloudflare)

État des lieux du code : 1179 lignes, zéro dépendance runtime, `fetch`
natif partout. Ce qui touche `node:*` est concentré dans 4 fichiers —
le découpage existant rend le portage chirurgical.

| Fichier (lignes) | Sort en E6 | Effort |
|---|---|---|
| `x.ts` (160), `telegram.ts` (252), `types.ts` | **Inchangés** — fetch natif, logique pure | 0 |
| `state.ts` (133) | `computeDiff` inchangé (pur) ; `loadState`/`saveState` → `storage.get/put` du DO | ~20 l. |
| `tokens.ts` (183) | `parseTokenResponse`/`buildTokenRequest`/`isExpired` inchangés ; `loadTokens`/`saveTokens` → DO (le `Buffer` de Basic auth passe avec `nodejs_compat`) | ~30 l. |
| `fsUtil.ts` (30) | **Hors build Worker** — les output gates remplacent tmp+fsync+rename côté DO ; le fichier **survit** dans l'implémentation fs de l'interface `Storage` (fallback local, cf. fin de §4 et §5.7) | 0 |
| `digest.ts` (56) | `main()`/`process.exit` → handler `scheduled()` + garde-fou Europe/Paris ; séquence inchangée (refresh persisté d'abord, state persisté après envoi Telegram) | ~30 l. |
| `auth.ts` (250) | Le serveur `node:http` éphémère → 2 routes dans `fetch` ; PKCE inchangé si déjà en WebCrypto/`node:crypto` supporté ; + garde-fous §3.3 | ~80-100 l. réécrites |
| `config.ts` (52) | `.env` → bindings `env.*` (secrets wrangler : `X_CLIENT_ID`, `X_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AUTH_URL_KEY`) | ~20 l. |
| *(nouveau)* `wrangler.toml` + classe `BotDO` | `nodejs_compat`, 2 crons (`30 6 * * *`, `30 7 * * *`), binding DO, `new_sqlite_classes` ; DO ~60 l. (get/put + endpoint d'import/export one-shot, protégé et éphémère, cf. §3.3-§3.4) | ~80 l. |

Note de chiffrage : les messages d'erreur qui prescrivent « relance
`npm run auth` » (`tokens.ts:146,162` et `:50,55`, `state.ts`, et le hint
de `x.ts:136` — ce dernier fait mentir le « inchangé » à une chaîne près)
doivent être réécrits pour embarquer le lien `/auth?k=…` promis au §3.2 ;
compter ~10-15 l. en plus des estimations ci-dessus.

Étapes : (1) wrangler.toml + DO squelette ; (2) abstraction stockage
(remplacer les 4 fonctions load/save) ; (3) `export default { scheduled,
fetch }` + garde DST ; (4) routes auth ; (5) tests `wrangler dev
--test-scheduled` + `curl /__scheduled` ; (6) **mesurer le CPU réel via
`wrangler tail`** (critère go/no-go du free tier) ; (7) bascule §3.4.

Deux choix structurels :

- **Mettre le run entier dans le DO** (RPC depuis `scheduled()`) plutôt
  que DO-comme-simple-KV : les messages Telegram sortants sont alors
  retenus tant que la rotation du token n'est pas flushée — la garantie la
  plus forte, gratuite.
- **Ordre du run conservé mais durci** : refresh → `await put(tokens)` en
  toute première action (CPU < 1 ms à ce stade) — si le run meurt ensuite
  (limite CPU, incident), on perd un digest, pas l'auth.

Important : ces ~250 lignes touchées restent compatibles avec un retour
local (le plan launchd E5 reste le fallback) si on isole les load/save
derrière une mini-interface `Storage` à deux implémentations (fs / DO).

## 5. Risques résiduels et points à vérifier à l'implémentation

1. **10 ms CPU free** : estimé 2-5 ms, **non mesuré**. À vérifier en
   premier (`wrangler tail`). Si dépassé : optimiser, sinon plan payé
   5 $/mois (au-dessus de la cible — l'arbitrage bascule alors peut-être
   vers le Pi).
2. **Cron best-effort sans SLA** + précédent d'incident (mars 2026) : le
   run silencieusement manqué reste possible. Mitigation : l'absence de
   digest est déjà le signal (UX choisie au PLAN §1) ; option heartbeat
   healthchecks.io gratuit — piège d'implémentation : ne pinger qu'après
   un run effectif, jamais depuis l'invocation à blanc du double-cron,
   sinon le heartbeat masque exactement le run manqué qu'il devait
   détecter.
3. **Double-cron DST** : 2 nuits par an, un bug du garde-fou donnerait un
   digest à 7h30 ou 9h30 — bénin, mais tester les deux branches avec une
   date forcée.
4. **Crash entre l'appel refresh X et le `put()`** : les output gates
   garantissent la durabilité de l'écriture, pas l'atomicité conjointe
   avec l'appel réseau X. Fenêtre de quelques ms, non éliminable sur
   aucune plateforme (le code local a la même) ; l'alerte + re-auth mobile
   en est la mitigation.
5. **Invalidations spontanées côté X** : des refresh tokens valides qui
   meurent sans réutilisation sont rapportés sur le forum X (bug reconnu
   par le staff en 2022, récurrences 2025-2026). L'exclusivité
   local/cloud est nécessaire mais pas suffisante → le chemin de re-auth
   doit rester à un clic (d'où la famille b).
6. **Faits non confirmés officiellement** (sources forum uniquement, doc X
   muette) : durée de vie du refresh token (~6 mois) et caractère usage
   unique ; comportement « une auth coupe l'autre » entre environnements.
   Modifiables sans préavis par X — le design (rotation persistée d'abord,
   re-auth facile) ne dépend d'aucun de ces chiffres.
7. **Évolution du free tier Cloudflare** : historiquement stable, pas de
   désactivation pour inactivité — risque jugé faible, mais l'interface
   `Storage` à deux implémentations (§4) garde la porte de sortie (retour
   launchd ou Pi) à ~0 coût de migration.
8. **À reporter dans PLAN.md (et src/auth.ts:23)** : callback locale
   `http://127.0.0.1:8765/callback` (pas `localhost` — alignement de
   prudence sur la doc X, sachant que `localhost` a fonctionné en E2-E5,
   cf. §3.5 ; aligné le 2026-06-12 dans la foulée du spike) ; E6 =
   stockage réinscriptible pour les tokens
   (jamais un secret wrangler immuable — il change à chaque run) ;
   procédure de bascule exclusive du §3.4.

---

### Annexe — sources

Vérifiées le 2026-06-12. Les corrections issues de la contre-vérification
du dossier de recherche sont intégrées au texte (notamment : KV viable en
théorie à cadence quotidienne mais non retenu ; Oracle ARM réduit à
2 OCPU/12 Go).

**Cloudflare**
- Cron Triggers (UTC only, 5 free/compte, propagation 15 min) : developers.cloudflare.com/workers/configuration/cron-triggers/
- Limites (10 ms CPU free, 30 s payé, 15 min wall-clock cron) : developers.cloudflare.com/workers/platform/limits/
- Pricing Workers (free tier, plan 5 $/mois) : developers.cloudflare.com/workers/platform/pricing/
- KV eventually consistent, RYOW non garanti, reco DO : developers.cloudflare.com/kv/concepts/how-kv-works/ · developers.cloudflare.com/kv/reference/faq/ · developers.cloudflare.com/kv/api/read-key-value-pairs/
- DO Storage API (cohérence forte, output gates, transactions implicites) : developers.cloudflare.com/durable-objects/api/storage-api/ · blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
- DO SQLite en free (quotas) : developers.cloudflare.com/durable-objects/platform/pricing/ · developers.cloudflare.com/durable-objects/platform/limits/
- nodejs_compat & node:fs en mémoire : developers.cloudflare.com/workers/runtime-apis/nodejs/ · developers.cloudflare.com/workers/runtime-apis/nodejs/fs/
- Options de stockage (KV vs DO vs D1 vs R2) : developers.cloudflare.com/workers/platform/storage-options/
- Secrets : developers.cloudflare.com/workers/configuration/secrets/
- D1 read replication : developers.cloudflare.com/d1/best-practices/read-replication/
- Incident crons mars 2026 : community.cloudflare.com/t/the-cron-triggers-i-configured-will-no-longer-trigger-after-utc-sun-01-mar-2026-22/899645

**val.town**
- Pricing & limites free : val.town/pricing · val.town/limits · docs.val.town/vals/limitations/
- Cron UTC only : docs.val.town/vals/cron/
- sqlite (Turso) & blob : docs.val.town/std/sqlite/ · docs.val.town/std/blob/ · docs.turso.tech/sdk/ts/reference
- HTTP vals & env vars : docs.val.town/vals/http/routing/ · docs.val.town/reference/environment-variables/ · docs.val.town/reference/runtime/
- Changements mai 2026 (vals publics, Pro 25 $) & update investisseurs : blog.val.town/changelog-05262026 · blog.val.town/2026-may · blog.val.town/blog/seed/

**Serverless classique**
- GH Actions (cron droppé, 60 j, cache 7 j, API secrets) : docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows · …/dependency-caching · docs.github.com/en/rest/actions/secrets · github.com/orgs/community/discussions/156282
- Deno Deploy/KV (cohérence, pricing, fermeture Classic 20/07/2026, queues abandonnées) : docs.deno.com/deploy/kv/manual/operations · docs.deno.com/deploy/kv/manual/cron/ · deno.com/deploy/pricing · docs.deno.com/deploy/classic/ · docs.deno.com/deploy/migration_guide/
- AWS (EventBridge timezone/DST, free plan 6 mois) : docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html · repost.aws/knowledge-center/eventbridge-scheduler-adjust-dst · docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html · aws.amazon.com/free/free-tier-faqs/
- GCP : docs.cloud.google.com/scheduler/docs/configuring/cron-job-schedules · cloud.google.com/scheduler/pricing · cloud.google.com/run/pricing
- Railway / Render / Fly : docs.railway.com/cron-jobs · railway.com/pricing · render.com/docs/cronjobs · fly.io/docs/blueprints/task-scheduling/ · fly.io/docs/about/pricing/
- Vercel cron Hobby (1/jour, précision « Hourly (±59 min) ») : vercel.com/docs/cron-jobs/usage-and-pricing
- Netlify (scheduled functions cron UTC ; Blobs eventually consistent par défaut, strong en option) : docs.netlify.com/build/functions/scheduled-functions/ · docs.netlify.com/build/data-and-storage/netlify-blobs/

**Auth X**
- Developer apps (10 callbacks, https, 127.0.0.1 not localhost) : docs.x.com/fundamentals/developer-apps · devcommunity.x.com/t/callback-urls-limit-10-urls/107762
- OAuth 2.0 (PKCE seul, access token 2 h, match exact) : docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code · …/oauth-2-0/overview
- Refresh token usage unique / ~6 mois (forum, non documenté officiellement) : devcommunity.x.com/t/refresh-token-expiring-with-offline-access-scope/168899 · …/176627 · …/224953 · …/240282
- Invalidation croisée entre environnements (rapports devs, non documenté) : devcommunity.x.com/t/refresh-tokens-randomly-expiring…/248555 · fil 173613 (bug reconnu staff)

**Self-host**
- pmset & FileVault : support.apple.com/guide/mac-help/mchl40376151/mac · support.apple.com/en-us/102316
- Pi Zero 2 W (prix, conso) : fr.farnell.com (réf. 3838499) · raspberrypi.com (prix officiel 15 $) · mesures CNX Software / Jeff Geerling
- Tarif Bleu 02/2026 (0,1940 €/kWh) : fournisseurs-electricite.com/contrat-electricite/prix
- Hetzner hausse 04/2026 : docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ · OVH : ovhcloud.com/fr/vps/cheap-vps/
- Oracle Always Free (2 OCPU/12 Go, reclamation idle) : docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
