import { describe, expect, test } from 'vitest';

import { createLocalStoragePlaybackPreferencesRepository } from './playbackPreferencesRepository';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe('playbackPreferencesRepository', () => {
  test('persists the four reload-safe playback preferences', () => {
    const storage = new MemoryStorage();
    const repository = createLocalStoragePlaybackPreferencesRepository(storage);
    repository.write({ volume: 0.35, muted: true, shuffle: true, repeatMode: 'all' });
    expect(createLocalStoragePlaybackPreferencesRepository(storage).read()).toEqual({
      volume: 0.35, muted: true, shuffle: true, repeatMode: 'all',
    });
  });

  test('clamps invalid legacy values to safe defaults', () => {
    const storage = new MemoryStorage();
    storage.setItem('music.playback-preferences.v1', JSON.stringify({
      version: 0, volume: 8, muted: 'yes', shuffle: 1, repeatMode: 'forever',
    }));
    expect(createLocalStoragePlaybackPreferencesRepository(storage).read()).toEqual({
      volume: 1, muted: false, shuffle: false, repeatMode: 'none',
    });
  });
});
