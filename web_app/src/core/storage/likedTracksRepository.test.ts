import { describe, expect, test } from 'vitest';

import { createLocalStorageLikedTracksRepository } from './likedTracksRepository';

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
    throw new Error('blocked');
  }
  override setItem(): void {
    throw new Error('blocked');
  }
}

describe('createLocalStorageLikedTracksRepository', () => {
  test('persists unique non-empty media ids', () => {
    const storage = new MemoryStorage();
    const repo = createLocalStorageLikedTracksRepository(storage);

    repo.write(['a', 'b', 'a', '', ' c ']);

    expect(repo.list()).toEqual(['a', 'b', 'c']);
  });

  test('treats corrupt payloads as empty', () => {
    const storage = new MemoryStorage();
    storage.setItem('music.likes.v1', '{not json');

    const repo = createLocalStorageLikedTracksRepository(storage);

    expect(repo.list()).toEqual([]);
  });

  test('disabled storage is best effort', () => {
    const repo = createLocalStorageLikedTracksRepository(new ThrowingStorage());

    expect(repo.list()).toEqual([]);
    expect(() => repo.write(['a'])).not.toThrow();
  });
});
