import { describe, expect, test } from 'vitest';

import { createLocalStorageAudioLibrarySnapshotCache } from './librarySnapshotCache';
import type { LibraryItem } from '../../core/api/libraryClient';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const audioItem: LibraryItem = {
  id: 'a1',
  type: 'audio',
  rootName: 'music',
  relativePath: 'song.mp3',
  name: 'song.mp3',
  mimeType: 'audio/mpeg',
  sizeBytes: 123,
  modifiedAt: '2026-01-01T00:00:00Z',
  metadata: { title: 'Song', artist: 'Artist' },
  thumbnail: {
    url: '/api/thumbnails/a1',
    kind: 'generated',
    status: 'ready',
    cacheKey: 'thumb',
  },
};

describe('createLocalStorageAudioLibrarySnapshotCache', () => {
  test('round-trips audio snapshots without thumbnail data', () => {
    const storage = new MemoryStorage();
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    cache.write({
      revision: 7,
      etag: 'W/"library-7-audio"',
      complete: true,
      items: [audioItem],
    });

    expect(cache.read()).toEqual({
      revision: 7,
      etag: 'W/"library-7-audio"',
      complete: true,
      items: [
        {
          id: 'a1',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 123,
          modifiedAt: '2026-01-01T00:00:00Z',
          metadata: { title: 'Song', artist: 'Artist' },
        },
      ],
    });
  });

  test('ignores corrupt payloads', () => {
    const storage = new MemoryStorage();
    storage.setItem('library.snapshot.audio.v2', 'not json');
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    expect(cache.read()).toBeNull();
  });

  test('filters non-audio items when writing', () => {
    const storage = new MemoryStorage();
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    cache.write({
      revision: 1,
      complete: true,
      items: [
        audioItem,
        {
          ...audioItem,
          id: 'v1',
          type: 'video',
          relativePath: 'clip.mp4',
          name: 'clip.mp4',
        },
      ],
    });

    expect(cache.read()?.items.map((item) => item.id)).toEqual(['a1']);
  });

  test('marks a 20,001 item cache incomplete and drops its ETag', () => {
    const storage = new MemoryStorage();
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);
    const items = Array.from({ length: 20_001 }, (_, index) => ({
      ...audioItem,
      id: `a${index}`,
      relativePath: `song-${index}.mp3`,
    }));

    cache.write({
      revision: 11,
      etag: 'W/"library-11-audio"',
      complete: true,
      items,
    });

    expect(cache.read()).toMatchObject({
      revision: 11,
      etag: undefined,
      complete: false,
    });
    expect(cache.read()?.items).toHaveLength(20_000);
  });

  test('treats a cache with a rejected item as incomplete', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'library.snapshot.audio.v2',
      JSON.stringify({
        version: 2,
        revision: 12,
        etag: 'W/"library-12-audio"',
        complete: true,
        totalItems: 2,
        items: [audioItem, { ...audioItem, id: 42 }],
      }),
    );
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    expect(cache.read()).toMatchObject({
      revision: 12,
      etag: undefined,
      complete: false,
      items: [audioItem],
    });
  });

  test('removes the legacy version-1 cache', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'library.snapshot.audio.v1',
      JSON.stringify({ version: 1, revision: 1, items: [audioItem] }),
    );
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    expect(cache.read()).toBeNull();
    expect(storage.getItem('library.snapshot.audio.v1')).toBeNull();
  });
});
