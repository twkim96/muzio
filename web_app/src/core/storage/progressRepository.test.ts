import { beforeEach, describe, expect, test } from 'vitest';

import {
  createLocalStorageProgressRepository,
  type ProgressRecord,
} from './progressRepository';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  getCount = 0;
  setCount = 0;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    this.getCount += 1;
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.setCount += 1;
    this.map.set(key, value);
  }
}

class ThrowingReadStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new Error('storage disabled');
  }
}

const sample = (positionSec = 100, durationSec = 600): ProgressRecord => ({
  positionSec,
  durationSec,
  lastPlayedAt: '2025-01-01T00:00:00Z',
});

describe('createLocalStorageProgressRepository', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  test('round-trips a record', () => {
    const repo = createLocalStorageProgressRepository(storage);
    expect(repo.read('a')).toBeNull();
    repo.write('a', sample());
    expect(repo.read('a')).toEqual(sample());
  });

  test('write under one id does not affect another', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('a', sample(60, 200));
    repo.write('b', sample(120, 400));
    expect(repo.read('a')?.positionSec).toBe(60);
    expect(repo.read('b')?.positionSec).toBe(120);
  });

  test('clear removes a single record without touching others', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('a', sample());
    repo.write('b', sample());
    repo.clear('a');
    expect(repo.read('a')).toBeNull();
    expect(repo.read('b')).not.toBeNull();
  });

  test('rejects non-finite or negative numbers', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('a', { positionSec: Number.NaN, durationSec: 1, lastPlayedAt: '' });
    repo.write('b', { positionSec: -1, durationSec: 1, lastPlayedAt: '' });
    repo.write('c', { positionSec: 1, durationSec: -1, lastPlayedAt: '' });
    expect(repo.entries()).toHaveLength(0);
  });

  test('treats a corrupted blob as empty rather than throwing', () => {
    storage.setItem('playback.progress.v1', 'not json');
    const repo = createLocalStorageProgressRepository(storage);
    expect(repo.entries()).toHaveLength(0);
    repo.write('a', sample());
    expect(repo.read('a')).not.toBeNull();
  });

  test('treats storage read failures as empty rather than throwing', () => {
    const repo = createLocalStorageProgressRepository(new ThrowingReadStorage());
    expect(repo.read('a')).toBeNull();
    expect(repo.entries()).toEqual([]);
    expect(repo.mostRecent()).toBeNull();
    expect(() => repo.write('a', sample())).not.toThrow();
    expect(() => repo.clear('a')).not.toThrow();
  });

  test('drops malformed entries on read', () => {
    storage.setItem(
      'playback.progress.v1',
      JSON.stringify({ a: { foo: 'bar' }, b: sample() }),
    );
    const repo = createLocalStorageProgressRepository(storage);
    expect(repo.read('a')).toBeNull();
    expect(repo.read('b')).not.toBeNull();
  });

  test('ignores empty media ids', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('', sample());
    expect(repo.read('')).toBeNull();
    expect(repo.entries()).toHaveLength(0);
  });

  test('entries returns id+record pairs', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('a', sample(10));
    repo.write('b', sample(20));
    const ids = repo.entries().map(([id]) => id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  test('mostRecent returns the entry with the latest lastPlayedAt', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('older', {
      positionSec: 10,
      durationSec: 100,
      lastPlayedAt: '2024-01-01T00:00:00Z',
    });
    repo.write('newer', {
      positionSec: 20,
      durationSec: 100,
      lastPlayedAt: '2025-06-01T00:00:00Z',
    });
    repo.write('middle', {
      positionSec: 30,
      durationSec: 100,
      lastPlayedAt: '2024-12-31T00:00:00Z',
    });
    expect(repo.mostRecent()?.mediaId).toBe('newer');
  });

  test('mostRecent returns null on empty storage', () => {
    const repo = createLocalStorageProgressRepository(storage);
    expect(repo.mostRecent()).toBeNull();
  });

  test('mostRecent ignores records with unparseable timestamps', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('a', { positionSec: 1, durationSec: 1, lastPlayedAt: 'not a date' });
    expect(repo.mostRecent()).toBeNull();
  });

  test('round-trips the optional source metadata', () => {
    const repo = createLocalStorageProgressRepository(storage);
    repo.write('abc', {
      positionSec: 50,
      durationSec: 200,
      lastPlayedAt: '2025-01-01T00:00:00Z',
      source: {
        mediaType: 'video',
        name: 'clip.mp4',
        rootName: 'video',
        relativePath: 'clip.mp4',
      },
    });
    const got = repo.read('abc');
    expect(got?.source?.mediaType).toBe('video');
    expect(got?.source?.name).toBe('clip.mp4');
  });

  test('drops a record when the embedded source has the wrong shape', () => {
    storage.setItem(
      'playback.progress.v1',
      JSON.stringify({
        bad: {
          positionSec: 10,
          durationSec: 20,
          lastPlayedAt: '2025-01-01T00:00:00Z',
          source: { mediaType: 'image', name: 'x.jpg' },
        },
      }),
    );
    const repo = createLocalStorageProgressRepository(storage);
    expect(repo.read('bad')).toBeNull();
  });

  test('loads storage once and serves a large number of reads from memory', () => {
    const records = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `media-${index}`,
        sample(index, 10_000),
      ]),
    );
    storage.setItem('playback.progress.v1', JSON.stringify(records));
    storage.getCount = 0;
    storage.setCount = 0;

    const repo = createLocalStorageProgressRepository(storage);
    for (let index = 0; index < 32; index += 1) {
      expect(repo.read(`media-${index}`)?.positionSec).toBe(index);
    }
    repo.entries();
    repo.mostRecent();

    expect(storage.getCount).toBe(1);
    expect(storage.setCount).toBe(0);
  });

  test('merges many records with one persistence write', () => {
    const repo = createLocalStorageProgressRepository(storage);
    storage.setCount = 0;

    repo.mergeMany?.(
      Array.from({ length: 1_000 }, (_, index) => [
        `media-${index}`,
        sample(index, 10_000),
      ] as const),
    );

    expect(storage.setCount).toBe(1);
    expect(repo.entries()).toHaveLength(1_000);
  });

  test('notifies only subscribers for changed media ids', () => {
    const repo = createLocalStorageProgressRepository(storage);
    let firstCalls = 0;
    let secondCalls = 0;
    const unsubscribeFirst = repo.subscribe?.('first', () => {
      firstCalls += 1;
    });
    repo.subscribe?.('second', () => {
      secondCalls += 1;
    });

    repo.write('first', sample());
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);

    unsubscribeFirst?.();
    repo.clear('first');
    expect(firstCalls).toBe(1);
  });
});
