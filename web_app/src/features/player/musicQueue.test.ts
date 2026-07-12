import { describe, expect, test } from 'vitest';

import type { PlaybackSource } from '../../core/playback/source/source';
import {
  buildMusicQueue,
  clearQueueTracks,
  explicitNextQueueIndex,
  moveQueueTrackNext,
  moveQueueTrack,
  nextQueueIndex,
  nextRepeatMode,
  previousQueueIndex,
  removeQueueTrack,
  shuffleQueueKeepingCurrent,
} from './musicQueue';

function audio(id: string): PlaybackSource {
  return {
    kind: 'remote',
    mediaId: id,
    mediaType: 'audio',
    url: `/api/media/${id}`,
    name: `${id}.mp3`,
  };
}

describe('buildMusicQueue', () => {
  test('filters to audio and selects the requested start track', () => {
    const queue = buildMusicQueue(
      [
        audio('a'),
        {
          ...audio('v'),
          mediaType: 'video',
        },
        audio('b'),
      ],
      'b',
    );

    expect(queue.tracks.map((track) => track.mediaId)).toEqual(['a', 'b']);
    expect(queue.currentIndex).toBe(1);
  });
});

describe('nextRepeatMode', () => {
  test('cycles none -> all -> one -> none', () => {
    expect(nextRepeatMode('none')).toBe('all');
    expect(nextRepeatMode('all')).toBe('one');
    expect(nextRepeatMode('one')).toBe('none');
  });
});

describe('nextQueueIndex', () => {
  test('advances sequentially', () => {
    expect(
      nextQueueIndex({
        tracks: [audio('a'), audio('b')],
        currentIndex: 0,
        repeatMode: 'none',
        stopAfterCurrent: false,
      }),
    ).toBe(1);
  });

  test('repeat all wraps to the first track', () => {
    expect(
      nextQueueIndex({
        tracks: [audio('a'), audio('b')],
        currentIndex: 1,
        repeatMode: 'all',
        stopAfterCurrent: false,
      }),
    ).toBe(0);
  });

  test('repeat one stays on the current track', () => {
    expect(
      nextQueueIndex({
        tracks: [audio('a'), audio('b')],
        currentIndex: 1,
        repeatMode: 'one',
        stopAfterCurrent: false,
      }),
    ).toBe(1);
  });

  test('stop-after-current does not advance', () => {
    const base = {
      tracks: [audio('a'), audio('b')],
      currentIndex: 0,
      repeatMode: 'all' as const,
    };
    expect(
      nextQueueIndex({
        ...base,
        stopAfterCurrent: true,
      }),
    ).toBeNull();
  });

  test('shuffle playback follows the copied queue order', () => {
    expect(
      nextQueueIndex({
        tracks: [audio('b'), audio('c'), audio('a')],
        currentIndex: 0,
        repeatMode: 'none',
        stopAfterCurrent: false,
      }),
    ).toBe(1);
  });
});

describe('manual queue navigation', () => {
  const base = {
    tracks: [audio('a'), audio('b'), audio('c')],
    repeatMode: 'none' as const,
    stopAfterCurrent: false,
  };

  test('finds previous and next tracks in queue order', () => {
    expect(previousQueueIndex({ ...base, currentIndex: 1 })).toBe(0);
    expect(explicitNextQueueIndex({ ...base, currentIndex: 1 })).toBe(2);
  });

  test('repeat all wraps manual navigation at boundaries', () => {
    expect(
      previousQueueIndex({
        ...base,
        currentIndex: 0,
        repeatMode: 'all',
      }),
    ).toBe(2);
    expect(
      explicitNextQueueIndex({
        ...base,
        currentIndex: 2,
        repeatMode: 'all',
      }),
    ).toBe(0);
  });

  test('single item or invalid queue has no manual target', () => {
    expect(
      previousQueueIndex({
        ...base,
        tracks: [audio('a')],
        currentIndex: 0,
      }),
    ).toBeNull();
    expect(explicitNextQueueIndex({ ...base, currentIndex: -1 })).toBeNull();
  });

  test('repeat one does not block manual next', () => {
    expect(
      explicitNextQueueIndex({
        ...base,
        currentIndex: 1,
        repeatMode: 'one',
      }),
    ).toBe(2);
  });

  test('shuffleQueueKeepingCurrent returns a shuffled copy with current first', () => {
    const original = [audio('a'), audio('b'), audio('c'), audio('d')];
    const result = shuffleQueueKeepingCurrent(original, 1, () => 0);

    expect(result.currentIndex).toBe(0);
    expect(result.tracks.map((track) => track.mediaId)).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
    expect(original.map((track) => track.mediaId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('queue editing', () => {
  test('removeQueueTrack adjusts current index', () => {
    const result = removeQueueTrack([audio('a'), audio('b'), audio('c')], 2, 'b');
    expect(result.tracks.map((track) => track.mediaId)).toEqual(['a', 'c']);
    expect(result.currentIndex).toBe(1);
  });

  test('clearQueueTracks keeps only the current track', () => {
    const result = clearQueueTracks([audio('a'), audio('b'), audio('c')], 1);
    expect(result.tracks.map((track) => track.mediaId)).toEqual(['b']);
    expect(result.currentIndex).toBe(0);
  });

  test('moveQueueTrackNext moves a track after the current track', () => {
    const result = moveQueueTrackNext(
      [audio('a'), audio('b'), audio('c'), audio('d')],
      2,
      'a',
    );
    expect(result.tracks.map((track) => track.mediaId)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
    expect(result.currentIndex).toBe(1);
  });

  test('moveQueueTrack moves rows and follows the current track', () => {
    const result = moveQueueTrack(
      [audio('a'), audio('b'), audio('c')],
      1,
      'b',
      'down',
    );
    expect(result.tracks.map((track) => track.mediaId)).toEqual(['a', 'c', 'b']);
    expect(result.currentIndex).toBe(2);
  });
});
