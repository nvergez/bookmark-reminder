/**
 * Garde du double-cron UTC (SPIKE-HOSTING.md §4) : les Cron Triggers
 * Cloudflare ne connaissent que l'UTC, donc deux triggers encadrent le
 * changement d'heure (30 6 * * * et 30 7 * * *) et seul celui qui tombe à
 * l'heure locale cible doit déclencher le digest.
 */
export function isLocalTime(epochMs: number, hhmm: string, timeZone: string): boolean {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(epochMs));
  return formatted === hhmm;
}
