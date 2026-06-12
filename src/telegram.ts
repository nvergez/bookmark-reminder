// Sender Telegram (PLAN.md E4) : récap notifiant + items silencieux avec
// aperçu riche, « rien de nouveau » et premier run silencieux, alerte d'erreur.

import type { Config, DigestDiff, Tweet } from './types.ts';

/** Dépendances injectables pour les tests (aucun réseau, aucun timer réel). */
export interface TelegramDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** ~1 msg/s autorisé par Telegram → marge à 1,1 s entre deux envois */
const THROTTLE_MS = 1100;
const MESSAGE_MAX = 4096;
const TWEET_EXCERPT_MAX = 280;
const ERROR_EXCERPT_MAX = 1000;

interface LinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_large_media?: boolean;
}

interface OutgoingMessage {
  text: string;
  silent: boolean;
  linkPreview: LinkPreviewOptions;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** L'API HTML de Telegram n'exige que ces trois caractères. */
export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Découpe un message en morceaux ≤ max, de préférence sur un saut de ligne,
 * sans couper une entité HTML (&amp; …) ni une paire de substitution Unicode.
 * Ne produit jamais de chunk vide.
 */
export function chunkMessage(s: string, max = MESSAGE_MAX): string[] {
  if (s.length === 0) return [];
  if (s.length <= max) return [s];

  const chunks: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const newline = rest.lastIndexOf('\n', max);
    let cut: number;
    let skip: number;
    if (newline >= 0) {
      cut = newline;
      skip = 1; // le \n de coupe n'est reporté dans aucun chunk
    } else {
      cut = hardCut(rest, max);
      skip = 0;
    }
    const chunk = rest.slice(0, cut);
    if (chunk.trim().length > 0) chunks.push(chunk); // jamais de chunk vide/blanc
    rest = rest.slice(cut + skip);
  }
  if (rest.trim().length > 0) chunks.push(rest);
  return chunks;
}

/** Coupe dure à max, reculée si elle tomberait au milieu d'une entité HTML
 * simple ou d'une paire de substitution. */
function hardCut(s: string, max: number): number {
  let cut = max;
  const amp = s.lastIndexOf('&', cut - 1);
  if (amp > 0 && cut - amp < 10) {
    const semi = s.indexOf(';', amp);
    if (semi >= cut) cut = amp; // l'entité chevauche la coupe → couper avant le &
  }
  const code = s.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) cut = max; // garantir la progression
  return cut;
}

/** Tronque sur une limite propre (espace) et ajoute une ellipse. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.lastIndexOf(' ', max);
  if (cut < max / 2) cut = max; // pas d'espace raisonnable : coupe dure
  const code = s.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut).trimEnd() + '…';
}

async function postSendMessage(
  config: Config,
  text: string,
  message: OutgoingMessage,
  fetchFn: typeof fetch,
): Promise<Response> {
  const url = `${TELEGRAM_API_BASE}/bot${config.telegramBotToken}/sendMessage`;
  return fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_notification: message.silent,
      link_preview_options: message.linkPreview,
    }),
  });
}

async function readRetryAfterSeconds(res: Response): Promise<number> {
  try {
    const body = (await res.json()) as { parameters?: { retry_after?: number } };
    const retryAfter = body.parameters?.retry_after;
    return typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter : 5;
  } catch {
    return 5;
  }
}

async function ensureOk(res: Response): Promise<void> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // corps illisible : l'erreur portera au moins le statut HTTP
  }
  if (!res.ok) {
    throw new Error(`Telegram sendMessage : HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
  }
  let parsed: { ok?: boolean; description?: string } = {};
  try {
    parsed = JSON.parse(bodyText) as { ok?: boolean; description?: string };
  } catch {
    return; // 2xx non-JSON : on considère l'envoi réussi
  }
  if (parsed.ok !== true) {
    throw new Error(`Telegram sendMessage : ok=false — ${parsed.description ?? bodyText.slice(0, 300)}`);
  }
}

/** Envoi bas niveau d'un chunk, avec un seul réessai sur HTTP 429. */
async function sendChunk(
  config: Config,
  text: string,
  message: OutgoingMessage,
  fetchFn: typeof fetch,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  let res = await postSendMessage(config, text, message, fetchFn);
  if (res.status === 429) {
    const retryAfter = await readRetryAfterSeconds(res);
    await sleepFn(retryAfter * 1000);
    res = await postSendMessage(config, text, message, fetchFn);
  }
  await ensureOk(res);
}

async function sendAll(config: Config, messages: OutgoingMessage[], deps: TelegramDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? defaultSleep;
  let first = true;
  for (const message of messages) {
    for (const chunk of chunkMessage(message.text)) {
      if (!first) await sleepFn(THROTTLE_MS);
      first = false;
      await sendChunk(config, chunk, message, fetchFn, sleepFn);
    }
  }
}

function pluralS(n: number): string {
  return n > 1 ? 's' : '';
}

function pluralX(n: number): string {
  return n > 1 ? 'x' : '';
}

function tweetMessage(prefix: string, tweet: Tweet): OutgoingMessage {
  const header = `${prefix} <b>${escapeHtml(tweet.authorName)} @${escapeHtml(tweet.authorUsername)}</b>`;
  const excerpt = escapeHtml(truncate(tweet.text, TWEET_EXCERPT_MAX));
  return {
    // URL en clair sur sa propre ligne : c'est elle qui porte l'aperçu riche
    text: `${header}\n${excerpt}\n\n${tweet.url}`,
    silent: true,
    linkPreview: { url: tweet.url, prefer_large_media: true },
  };
}

function buildDigestMessages(diff: DigestDiff): OutgoingMessage[] {
  const noPreview: LinkPreviewOptions = { is_disabled: true };

  if (diff.isFirstRun) {
    // newBookmarks/newLikes sont toujours vides au premier run (computeDiff) :
    // les vrais totaux enregistrés sont dans trackedCounts.
    const b = diff.trackedCounts.bookmarks;
    const l = diff.trackedCounts.likes;
    return [
      {
        text:
          `🌱 Référence établie : ${b} bookmark${pluralS(b)} et ${l} like${pluralS(l)} suivis. ` +
          'Les nouveautés arriveront à partir de demain ☀️',
        silent: true,
        linkPreview: noPreview,
      },
    ];
  }

  const b = diff.newBookmarks.length;
  const l = diff.newLikes.length;
  if (b === 0 && l === 0) {
    return [{ text: 'Rien de nouveau ✨', silent: true, linkPreview: noPreview }];
  }

  const parts: string[] = [];
  if (b > 0) parts.push(`${b} nouveau${pluralX(b)} bookmark${pluralS(b)} 🔖`);
  if (l > 0) parts.push(`${l} nouveau${pluralX(l)} like${pluralS(l)} ❤️`);

  const messages: OutgoingMessage[] = [
    { text: `☀️ Ce matin : ${parts.join(', ')}`, silent: false, linkPreview: noPreview },
  ];
  for (const tweet of diff.newBookmarks) messages.push(tweetMessage('🔖', tweet));
  for (const tweet of diff.newLikes) messages.push(tweetMessage('❤️', tweet));
  return messages;
}

/**
 * Envoie le digest : récap notifiant puis un message silencieux par tweet
 * (bookmarks d'abord). Premier run et jours vides : un seul message silencieux.
 */
export async function sendDigest(config: Config, diff: DigestDiff, deps: TelegramDeps = {}): Promise<void> {
  await sendAll(config, buildDigestMessages(diff), deps);
}

/**
 * Alerte d'échec NOTIFIANTE. Ne throw jamais : c'est le dernier filet du
 * catch global — un échec d'envoi est seulement loggé en console.
 */
export async function sendErrorAlert(config: Config, error: unknown, deps: TelegramDeps = {}): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const text = `⚠️ Le bot bookmark-reminder a échoué : ${escapeHtml(truncate(detail, ERROR_EXCERPT_MAX))}`;
  try {
    await sendAll(config, [{ text, silent: false, linkPreview: { is_disabled: true } }], deps);
  } catch (sendError) {
    console.error("Échec de l'envoi de l'alerte Telegram (dernier filet) :", sendError);
  }
}
