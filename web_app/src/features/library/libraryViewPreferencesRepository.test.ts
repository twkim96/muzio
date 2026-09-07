import { describe, expect, test } from 'vitest';

import { createLocalStorageLibraryViewPreferencesRepository } from './libraryViewPreferencesRepository';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null { throw new Error('blocked'); }
  override setItem(): void { throw new Error('blocked'); }
}

describe('libraryViewPreferencesRepository', () => {
  test('persists independent view state for each media type', () => {
    const storage = new MemoryStorage();
    const repository = createLocalStorageLibraryViewPreferencesRepository(storage);

    repository.write('audio', {
      query: 'rain #"The Beatles"',
      filters: { storageIds: ['local:phone'], locations: ['local'], artists: ['the beatles'] },
      sortKey: 'artist',
      sortDirection: 'asc',
    });
    repository.write('video', {
      query: 'concert',
      filters: { storageIds: [], locations: ['network'], artists: [] },
      sortKey: 'modified',
      sortDirection: 'desc',
    });

    expect(repository.read('audio')).toEqual({
      query: 'rain #"The Beatles"',
      filters: { storageIds: ['local:phone'], locations: ['local'], artists: ['the beatles'] },
      sortKey: 'artist',
      sortDirection: 'asc',
    });
    expect(repository.read('video')).toEqual({
      query: 'concert',
      filters: { storageIds: [], locations: ['network'], artists: [] },
      sortKey: 'modified',
      sortDirection: 'desc',
    });
    expect(repository.read('image')).toEqual({
      query: '',
      filters: { storageIds: [], locations: [], artists: [] },
      sortKey: 'latest',
      sortDirection: 'desc',
    });
  });

  test('normalizes corrupt fields and ignores an invalid document', () => {
    const storage = new MemoryStorage();
    storage.setItem('music.library-view-preferences.v1', JSON.stringify({
      audio: {
        query: 42,
        filters: {
          storageIds: [' local:phone ', '', 5, 'local:phone'],
          locations: ['local', 'unknown', 'local'],
          artists: [' Artist ', null],
        },
        sortKey: 'unknown',
        sortDirection: 'sideways',
      },
    }));
    const repository = createLocalStorageLibraryViewPreferencesRepository(storage);

    expect(repository.read('audio')).toEqual({
      query: '',
      filters: { storageIds: ['local:phone'], locations: ['local'], artists: ['Artist'] },
      sortKey: 'latest',
      sortDirection: 'desc',
    });

    storage.setItem('music.library-view-preferences.v1', '{not json');
    expect(repository.read('audio')).toEqual({
      query: '',
      filters: { storageIds: [], locations: [], artists: [] },
      sortKey: 'latest',
      sortDirection: 'desc',
    });
  });

  test('treats unavailable storage as best effort', () => {
    const repository = createLocalStorageLibraryViewPreferencesRepository(new ThrowingStorage());

    expect(() => repository.read('audio')).not.toThrow();
    expect(() => repository.write('audio', {
      query: '', filters: { storageIds: [], locations: [], artists: [] }, sortKey: 'latest', sortDirection: 'desc',
    })).not.toThrow();
  });
});
