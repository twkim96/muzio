import { describe, expect, test } from 'vitest';

import {
  createLocalStoragePlaybackActivityRepository,
  MAX_ACTIVITY_DOCUMENT_CHARS,
  type PlaybackActivitySource,
} from './playbackActivityRepository';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  getCount = 0;
  setCount = 0;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    this.getCount += 1;
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.setCount += 1;
    this.data.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('disabled');
  }
  override setItem() {
    throw new Error('disabled');
  }
}

const source: PlaybackActivitySource = {
  contentKey: 'audio:artist:lamp:title:rainy-night',
  mediaId: 'opaque-id',
  mediaType: 'audio',
  name: 'Lamp - Rainy Night.mp3',
  artist: 'Lamp',
};

describe('createLocalStoragePlaybackActivityRepository', () => {
  test('records play counts and local weekday/hour events', () => {
    const repo = createLocalStoragePlaybackActivityRepository(new MemoryStorage());

    repo.recordPlay(source, new Date(2026, 5, 1, 20, 15).getTime());
    repo.recordPlay(source, new Date(2026, 5, 1, 21, 0).getTime());

    expect(repo.list()[0]).toMatchObject({
      contentKey: source.contentKey,
      playCount: 2,
      lastPlayedAt: expect.any(String),
      events: [
        expect.objectContaining({ weekday: 1, hour: 21 }),
        expect.objectContaining({ weekday: 1, hour: 20 }),
      ],
    });
  });

  test('updates progress and marks nearly finished tracks complete', () => {
    const repo = createLocalStoragePlaybackActivityRepository(new MemoryStorage());

    const collectionChanged = repo.updateProgress(source, {
      positionSec: 292,
      durationSec: 300,
      completed: false,
    });

    expect(collectionChanged).toBe(true);
    expect(repo.list()[0]).toMatchObject({
      lastPositionSec: 292,
      durationSec: 300,
      completed: true,
    });
  });

  test('imports only valid unique records', () => {
    const repo = createLocalStoragePlaybackActivityRepository(new MemoryStorage());

    repo.importData({
      version: 1,
      records: [
        {
          ...source,
          playCount: 3,
          lastPlayedAt: null,
          lastPositionSec: 10,
          durationSec: 100,
          completed: false,
          events: [],
        },
        {
          ...source,
          playCount: 9,
          lastPlayedAt: null,
          lastPositionSec: 0,
          durationSec: 0,
          completed: false,
          events: [],
        },
        { bad: true },
      ],
    });

    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0].playCount).toBe(3);
  });

  test('disabled storage falls back to an empty best-effort repository', () => {
    const repo = createLocalStoragePlaybackActivityRepository(new ThrowingStorage());

    expect(repo.list()).toEqual([]);
    expect(() => repo.recordPlay(source)).not.toThrow();
  });

  test('reads storage once and serves later operations from memory', () => {
    const storage = new MemoryStorage();
    const repo = createLocalStoragePlaybackActivityRepository(storage);

    repo.list();
    repo.recordPlay(source);
    repo.updateProgress(source, {
      positionSec: 10,
      durationSec: 100,
      completed: false,
    });
    repo.exportData();

    expect(storage.getCount).toBe(1);
    expect(storage.setCount).toBe(2);
  });

  test('position-only updates return a change flag instead of all records', () => {
    const repo = createLocalStoragePlaybackActivityRepository(new MemoryStorage());
    repo.recordPlay(source);

    const result = repo.updateProgress(source, {
      positionSec: 10,
      durationSec: 100,
      completed: false,
    });

    expect(result).toBe(false);
    expect(Array.isArray(result)).toBe(false);
  });

  test('bounds imported activity data below the storage character limit', () => {
    const storage = new MemoryStorage();
    const repo = createLocalStoragePlaybackActivityRepository(storage);
    const records = Array.from({ length: 8_000 }, (_, index) => ({
      ...source,
      contentKey: `audio:test:${index}`,
      mediaId: `media-${index}`,
      name: `track-${index}-${'x'.repeat(250)}`,
      playCount: 1,
      lastPlayedAt: new Date(2020, 0, 1, 0, 0, index % 60).toISOString(),
      lastPositionSec: 100,
      durationSec: 100,
      completed: true,
      events: [],
    }));

    repo.importData({ version: 1, records });

    const persisted = storage.getItem('music.activity.v1');
    expect(persisted).not.toBeNull();
    expect(persisted!.length).toBeLessThanOrEqual(
      MAX_ACTIVITY_DOCUMENT_CHARS,
    );
    expect(repo.list().length).toBeLessThan(records.length);
  });
});
