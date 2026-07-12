import { describe, expect, test } from 'vitest';

import type { ProgressRecord } from '../../core/storage/progressRepository';
import {
  WATCHED_THRESHOLD,
  mostRecentResumableEntry,
  progressFractionFor,
  resumePositionFor,
} from './progressPolicy';

const baseRecord: ProgressRecord = {
  positionSec: 60,
  durationSec: 600,
  lastPlayedAt: '2025-01-01T00:00:00Z',
};

describe('resumePositionFor', () => {
  test('returns null for null record', () => {
    expect(resumePositionFor(null)).toBeNull();
  });

  test('returns the saved position when meaningful', () => {
    expect(resumePositionFor(baseRecord)).toBe(60);
  });

  test('returns null when the saved position is at or near the end', () => {
    expect(
      resumePositionFor({ ...baseRecord, positionSec: 599 }),
    ).toBeNull();
    expect(
      resumePositionFor({
        ...baseRecord,
        positionSec: baseRecord.durationSec * WATCHED_THRESHOLD + 1,
      }),
    ).toBeNull();
  });

  test('returns null for very short clips so we do not seek past the start', () => {
    expect(
      resumePositionFor({ positionSec: 5, durationSec: 10, lastPlayedAt: '' }),
    ).toBeNull();
  });

  test('returns null when the saved position is non-positive or NaN', () => {
    expect(
      resumePositionFor({ ...baseRecord, positionSec: 0 }),
    ).toBeNull();
    expect(
      resumePositionFor({ ...baseRecord, positionSec: -1 }),
    ).toBeNull();
    expect(
      resumePositionFor({ ...baseRecord, positionSec: Number.NaN }),
    ).toBeNull();
  });

  test('returns null when remaining time is below the floor', () => {
    expect(
      resumePositionFor({
        positionSec: 595,
        durationSec: 600,
        lastPlayedAt: '',
      }),
    ).toBeNull();
  });
});

describe('progressFractionFor', () => {
  test('returns null for null record', () => {
    expect(progressFractionFor(null)).toBeNull();
  });

  test('returns the ratio for partial progress', () => {
    expect(
      progressFractionFor({ ...baseRecord, positionSec: 150, durationSec: 600 }),
    ).toBeCloseTo(0.25);
  });

  test('clamps to 1 once the watched threshold is crossed', () => {
    expect(
      progressFractionFor({
        ...baseRecord,
        positionSec: 600 * WATCHED_THRESHOLD,
        durationSec: 600,
      }),
    ).toBe(1);
    expect(
      progressFractionFor({ ...baseRecord, positionSec: 600, durationSec: 600 }),
    ).toBe(1);
  });

  test('returns null for ill-formed records', () => {
    expect(
      progressFractionFor({ ...baseRecord, durationSec: 0 }),
    ).toBeNull();
    expect(
      progressFractionFor({ ...baseRecord, positionSec: -1 }),
    ).toBeNull();
    expect(
      progressFractionFor({ ...baseRecord, positionSec: 0 }),
    ).toBeNull();
  });
});

describe('mostRecentResumableEntry', () => {
  test('picks the newest record that still has a valid resume point', () => {
    const finished: ProgressRecord = {
      ...baseRecord,
      positionSec: 590,
      lastPlayedAt: '2026-01-01T00:00:00Z',
      source: {
        mediaType: 'video',
        name: 'finished.mp4',
        rootName: 'videos',
        relativePath: 'finished.mp4',
      },
    };
    const olderResumable: ProgressRecord = {
      ...baseRecord,
      positionSec: 120,
      lastPlayedAt: '2025-01-01T00:00:00Z',
      source: {
        mediaType: 'video',
        name: 'older.mp4',
        rootName: 'videos',
        relativePath: 'older.mp4',
      },
    };
    const newerResumable: ProgressRecord = {
      ...baseRecord,
      positionSec: 180,
      lastPlayedAt: '2025-06-01T00:00:00Z',
      source: {
        mediaType: 'video',
        name: 'newer.mp4',
        rootName: 'videos',
        relativePath: 'newer.mp4',
      },
    };

    expect(
      mostRecentResumableEntry([
        ['finished', finished],
        ['older', olderResumable],
        ['newer', newerResumable],
      ]),
    ).toEqual({
      mediaId: 'newer',
      record: newerResumable,
      resumePositionSec: 180,
    });
  });

  test('ignores entries without cached source metadata', () => {
    expect(mostRecentResumableEntry([['id', baseRecord]])).toBeNull();
  });
});
