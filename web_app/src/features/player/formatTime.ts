/**
 * Pure formatter for player time displays. Outputs `mm:ss` for sub-hour
 * durations and `h:mm:ss` for longer ones, matching what most desktop and
 * mobile players already show.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);

  const ss = String(s).padStart(2, '0');
  if (h === 0) {
    return `${m}:${ss}`;
  }
  const mm = String(m).padStart(2, '0');
  return `${h}:${mm}:${ss}`;
}
