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
      items: [audioItem],
    });

    expect(cache.read()).toEqual({
      revision: 7,
      etag: 'W/"library-7-audio"',
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
    storage.setItem('library.snapshot.audio.v1', 'not json');
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    expect(cache.read()).toBeNull();
  });

  test('filters non-audio items when writing', () => {
    const storage = new MemoryStorage();
    const cache = createLocalStorageAudioLibrarySnapshotCache(storage);

    cache.write({
      revision: 1,
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
});
