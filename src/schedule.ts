/**
 * UTC double-cron guard (SPIKE-HOSTING.md §4): Cloudflare Cron Triggers
 * only understand UTC, so two triggers bracket the DST change
 * (30 6 * * * and 30 7 * * *) and only the one that lands at the target
 * local time should fire the digest.
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
