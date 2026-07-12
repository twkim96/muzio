import { describe, expect, test } from 'vitest';

import { createLocalStoragePlaylistRepository } from './playlistRepository';

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
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
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

describe('createLocalStoragePlaylistRepository', () => {
  test('creates, renames, deletes, and orders playlists', () => {
    const repo = createLocalStoragePlaylistRepository(new MemoryStorage());

    repo.create('Favorites', 'p1');
    repo.rename('p1', 'Night songs');

    expect(repo.list()).toMatchObject([
      {
        id: 'p1',
        name: 'Night songs',
      },
    ]);

    repo.delete('p1');
    expect(repo.list()).toEqual([]);
  });

  test('adds unique item refs and reorders them', () => {
    const repo = createLocalStoragePlaylistRepository(new MemoryStorage());

    repo.create('Favorites', 'p1');
    repo.addItem('p1', 'audio:title:a');
    repo.addItem('p1', 'audio:title:b');
    repo.addItem('p1', 'audio:title:b');
    repo.moveItem('p1', 'audio:title:b', 'up');

    expect(repo.list()[0].items.map((item) => item.contentKey)).toEqual([
      'audio:title:b',
      'audio:title:a',
    ]);

    repo.removeItem('p1', 'audio:title:b');
    expect(repo.list()[0].items.map((item) => item.contentKey)).toEqual([
      'audio:title:a',
    ]);
  });

  test('blank rename keeps the current playlist name', () => {
    const repo = createLocalStoragePlaylistRepository(new MemoryStorage());

    repo.create('Favorites', 'p1');
    repo.rename('p1', '   ');

    expect(repo.list()[0].name).toBe('Favorites');
  });

  test('batch adds unique item refs in append order', () => {
    const repo = createLocalStoragePlaylistRepository(new MemoryStorage());

    repo.create('Batch', 'p1');
    repo.addItems('p1', [
      'audio:title:a',
      'audio:title:b',
      'audio:title:a',
      '',
    ]);

    expect(repo.list()[0].items.map((item) => item.contentKey)).toEqual([
      'audio:title:a',
      'audio:title:b',
    ]);
  });

  test('batch removes selected item refs and preserves the rest', async () => {
    const repo = createLocalStoragePlaylistRepository(new MemoryStorage());

    repo.create('Batch', 'p1');
    repo.addItems('p1', [
      'audio:title:a',
      'audio:title:b',
      'audio:title:c',
    ]);
    const before = repo.list()[0].updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 1));

    repo.removeItems('p1', ['audio:title:a', ' audio:title:c ', '']);

    expect(repo.list()[0].items.map((item) => item.contentKey)).toEqual([
      'audio:title:b',
    ]);
    expect(repo.list()[0].updatedAt).not.toBe(before);
  });

  test('imports only valid playlists and unique item refs', () => {
    const repo = createLocalStoragePlaylistRepository(new MemoryStorage());

    repo.importData({
      version: 1,
      playlists: [
        {
          id: 'p1',
          name: 'Imported',
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
          items: [
            {
              contentKey: 'audio:title:a',
              addedAt: '2026-06-01T00:00:00.000Z',
            },
            {
              contentKey: 'audio:title:a',
              addedAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        },
        { bad: true },
      ],
    });

    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0].items).toHaveLength(1);
  });

  test('disabled storage stays best-effort', () => {
    const repo = createLocalStoragePlaylistRepository(new ThrowingStorage());

    expect(repo.list()).toEqual([]);
    expect(() => repo.create('Offline', 'p1')).not.toThrow();
  });
});
