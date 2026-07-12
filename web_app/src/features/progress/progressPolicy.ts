import type { ProgressRecord } from '../../core/storage/progressRepository';

/**
 * Pure helpers shared by the resume and the library-row progress bar so
 * both surfaces agree on what counts as "watched" and on the saved
 * position to honour.
 */

/** Treat a record within this fraction of the end as fully watched. */
export const WATCHED_THRESHOLD = 0.95;

/** Skip resume for very short clips where seeking past the start is not useful. */
const MIN_DURATION_FOR_RESUME_SEC = 30;

/** Re-seeking inside the last few seconds is annoying; drop those resumes. */
const MIN_REMAINING_FOR_RESUME_SEC = 10;

/**
 * Returns the position to resume from, or null when the record should be
 * ignored (no record, finished item, ill-formed values, or too close to
 * the end to be useful).
 */
export function resumePositionFor(
  record: ProgressRecord | null,
): number | null {
  if (record === null) return null;
  const { positionSec, durationSec } = record;
  if (!Number.isFinite(positionSec) || positionSec <= 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (durationSec < MIN_DURATION_FOR_RESUME_SEC) return null;

  const ratio = positionSec / durationSec;
  if (ratio >= WATCHED_THRESHOLD) return null;

  const remaining = durationSec - positionSec;
  if (remaining < MIN_REMAINING_FOR_RESUME_SEC) return null;

  return positionSec;
}

export interface ResumableProgressEntry {
  mediaId: string;
  record: ProgressRecord;
  resumePositionSec: number;
}

/**
 * Picks the newest entry that can actually resume. Completed, too-short, and
 * malformed records are ignored so the boot-time mini-player does not show a
 * stale "continue" item that starts from the beginning.
 */
export function mostRecentResumableEntry(
  entries: ReadonlyArray<readonly [string, ProgressRecord]>,
): ResumableProgressEntry | null {
  let best: ResumableProgressEntry | null = null;
  let bestStamp = Number.NEGATIVE_INFINITY;
  for (const [mediaId, record] of entries) {
    if (record.source === undefined) continue;
    const resumePositionSec = resumePositionFor(record);
    if (resumePositionSec === null) continue;
    const stamp = Date.parse(record.lastPlayedAt);
    if (!Number.isFinite(stamp)) continue;
    if (stamp > bestStamp) {
      bestStamp = stamp;
      best = { mediaId, record, resumePositionSec };
    }
  }
  return best;
}

/**
 * Returns 0..1 progress fraction for the library-row indicator. Items whose
 * record crosses the watched threshold count as 1 so the row renders a
 * complete bar instead of a 99% slice.
 */
export function progressFractionFor(
  record: ProgressRecord | null,
): number | null {
  if (record === null) return null;
  const { positionSec, durationSec } = record;
  if (!Number.isFinite(positionSec) || positionSec < 0) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (positionSec <= 0) return null;

  const ratio = positionSec / durationSec;
  if (ratio >= WATCHED_THRESHOLD) return 1;
  return Math.min(Math.max(ratio, 0), 1);
}
