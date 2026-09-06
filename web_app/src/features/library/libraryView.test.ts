import { describe, expect, test } from 'vitest';

import type { LibraryItem } from '../../core/api/libraryClient';
import { EMPTY_LIBRARY_FILTERS, libraryFacets, parseLibraryQuery, libraryQueryWithArtists, filterAndSortLibraryItems, type LibrarySortKey } from './libraryView';

function item(patch: Partial<LibraryItem>): LibraryItem {
  return {
    id: patch.id ?? 'id',
    type: patch.type ?? 'audio',
    rootName: patch.rootName ?? 'root',
    relativePath: patch.relativePath ?? patch.name ?? 'song.mp3',
    name: patch.name ?? 'song.mp3',
    sizeBytes: patch.sizeBytes ?? 1,
    modifiedAt: patch.modifiedAt ?? '2026-06-01T00:00:00Z',
    metadata: patch.metadata,
    thumbnail: patch.thumbnail,
    subtitles: patch.subtitles,
    location: patch.location,
    storageId: patch.storageId,
  };
}

describe('filterAndSortLibraryItems', () => {
  test('filters across title, artist, album, and path metadata', () => {
    const result = filterAndSortLibraryItems(
      [
        item({
          id: 'a',
          name: 'track.mp3',
          metadata: { title: 'Rainy Night', artist: 'Lamp', album: 'Tokyo' },
        }),
        item({ id: 'b', name: 'other.mp3' }),
      ],
      'audio',
      { query: 'lamp tokyo', sortKey: 'name' },
    );

    expect(result.map((track) => track.id)).toEqual(['a']);
  });

  test('sorts all libraries by newest first', () => {
    const latest = [
      item({ id: 'new', modifiedAt: '2026-06-01T00:00:00Z' }),
      item({ id: 'old', modifiedAt: '2026-05-01T00:00:00Z' }),
    ];
    const result = filterAndSortLibraryItems(
      latest,
      'image',
      { query: '', sortKey: 'latest' },
    );

    expect(result.map((entry) => entry.id)).toEqual(['new', 'old']);
    expect(result).toBe(latest);
  });

  test('sorts all libraries by natural title/name order', () => {
    const result = filterAndSortLibraryItems(
      [
        item({ id: 'z', name: 'Photo 10.jpg' }),
        item({ id: 'a', name: 'Photo 2.jpg' }),
        item({ id: 'm', name: 'alpha.jpg' }),
      ],
      'image',
      { query: '', sortKey: 'name' },
    );

    expect(result.map((entry) => entry.id)).toEqual(['m', 'a', 'z']);
  });
});


describe('column sorting', () => {
  const cases: [LibrarySortKey, Partial<LibraryItem>, Partial<LibraryItem>][] = [
    ['name', { metadata: { title: 'Track 2' } }, { metadata: { title: 'Track 10' } }],
    ['artist', { metadata: { title: 'Z', artist: 'Artist 2' } }, { metadata: { title: 'A', artist: 'Artist 10' } }],
    ['size', { sizeBytes: 2 }, { sizeBytes: 10 }],
    ['modified', { modifiedAt: '2026-06-01T10:00:00+09:00' }, { modifiedAt: '2026-06-01T02:00:00Z' }],
    ['library', { rootName: 'Root 2' }, { rootName: 'Root 10' }],
  ];

  test.each(cases)('sorts %s in both directions without mutating inputs', (sortKey, low, high) => {
    const entries = Object.freeze([Object.freeze(item({ id: 'high', ...high })), Object.freeze(item({ id: 'low', ...low }))]);
    for (const sortDirection of ['asc', 'desc'] as const) {
      const result = filterAndSortLibraryItems(entries, 'audio', { query: '', sortKey, sortDirection });
      expect(result.map((entry) => entry.id)).toEqual(sortDirection === 'asc' ? ['low', 'high'] : ['high', 'low']);
      expect(result).not.toBe(entries);
    }
    expect(entries.map((entry) => entry.id)).toEqual(['high', 'low']);
  });

  test.each<LibrarySortKey>(['name', 'artist', 'size', 'modified', 'library'])('keeps missing and invalid %s values last in either direction', (sortKey) => {
    const valid = item({ id: 'valid', metadata: { title: 'Valid', artist: 'Artist' } });
    const invalid = item({ id: 'invalid', name: 'A' });
    const missing = item({ id: 'missing', name: 'B' });
    switch (sortKey) {
      case 'name': invalid.name = ' '; missing.name = undefined as unknown as string; break;
      case 'artist': invalid.metadata = { title: 'A', artist: ' ' }; break;
      case 'size': invalid.sizeBytes = NaN; missing.sizeBytes = undefined as unknown as number; break;
      case 'modified': invalid.modifiedAt = 'invalid'; missing.modifiedAt = undefined as unknown as string; break;
      case 'library': invalid.rootName = ' '; missing.rootName = undefined as unknown as string; break;
    }
    for (const sortDirection of ['asc', 'desc'] as const) {
      const result = filterAndSortLibraryItems([missing, valid, invalid], 'audio', { query: '', sortKey, sortDirection });
      expect(result[0]).toBe(valid);
      expect(new Set(result.slice(1))).toEqual(new Set([invalid, missing]));
    }
  });

  test('uses ascending natural titles then IDs to break equal column values', () => {
    const entries = [item({ id: 'b', name: 'Track 2' }), item({ id: 'z', name: 'Track 10' }), item({ id: 'a', name: 'Track 2' })];
    for (const sortDirection of ['asc', 'desc'] as const) {
      expect(filterAndSortLibraryItems(entries, 'audio', { query: '', sortKey: 'size', sortDirection }).map((entry) => entry.id)).toEqual(['a', 'b', 'z']);
    }
  });

  test('latest preserves server order and reference even with descending direction', () => {
    const entries = [item({ id: 'old', modifiedAt: '2020-01-01' }), item({ id: 'new' })];
    expect(filterAndSortLibraryItems(entries, 'audio', { query: '', sortKey: 'latest', sortDirection: 'desc' })).toBe(entries);
  });

  test('rejects negative and infinite sizes while allowing zero', () => {
    const entries = [item({ id: 'negative', sizeBytes: -1 }), item({ id: 'infinite', sizeBytes: Infinity }), item({ id: 'zero', sizeBytes: 0 })];
    for (const sortDirection of ['asc', 'desc'] as const) {
      expect(filterAndSortLibraryItems(entries, 'audio', { query: '', sortKey: 'size', sortDirection })[0].id).toBe('zero');
    }
  });
});


describe('library facets and artist search', () => {
  const entries = [
    item({ id: 'a', rootName: 'Shared', location: 'local', storageId: 'phone', metadata: { artist: 'The Beatles', title: 'Rain' } }),
    item({ id: 'b', rootName: 'Shared', metadata: { artist: 'The Beatles', title: 'Sun' } }),
    item({ id: 'c', rootName: 'Other', metadata: { artist: 'Lamp', title: 'Rain' } }),
    item({ id: 'd', rootName: 'Other', location: 'local', storageId: 'sd', metadata: { artist: 'Other', title: 'Rain' } }),
  ];
  test('uses stable storage identities and full input artist counts', () => {
    const facets = libraryFacets(entries);
    expect(facets.storage.map((entry) => entry.id).sort()).toEqual(['local:phone', 'local:sd', 'network:Other', 'network:Shared']);
    expect(facets.artists[0]).toEqual({ id: 'the beatles', label: 'The Beatles', count: 2 });
    expect(facets.locations).toEqual({ local: 2, network: 2 });
  });
  test('combines OR within facets and AND across facets with text and sorting', () => {
    const result = filterAndSortLibraryItems(entries, 'audio', { query: 'Rain', sortKey: 'artist', filters: {
      storageIds: ['local:phone', 'network:Other'], locations: ['local', 'network'], artists: ['the beatles', 'lamp'],
    } });
    expect(result.map((entry) => entry.id)).toEqual(['c', 'a']);
    expect(filterAndSortLibraryItems(entries, 'audio', { query: '', sortKey: 'latest', filters: { ...EMPTY_LIBRARY_FILTERS, locations: ['network'] } }).map((entry) => entry.id)).toEqual(['b', 'c']);
  });
  test('recognizes quoted and known multiword tags alongside ordinary search text', () => {
    const known = libraryFacets(entries).artists;
    expect(parseLibraryQuery('Rain #The Beatles #Lamp', known)).toEqual({ text: 'Rain', artists: ['the beatles', 'lamp'] });
    expect(parseLibraryQuery('#"The Beatles" rain #Lamp', known)).toEqual({ text: 'rain', artists: ['the beatles', 'lamp'] });
    expect(filterAndSortLibraryItems(entries, 'audio', { query: 'Rain #The Beatles #Lamp', sortKey: 'name' }).map((entry) => entry.id)).toEqual(['a', 'c']);
    const query = libraryQueryWithArtists('Sun', ['the beatles'], known);
    expect(parseLibraryQuery(query, known)).toEqual({ text: 'Sun', artists: ['the beatles'] });
    expect(parseLibraryQuery('#Unknown trailing words', known)).toEqual({ text: 'trailing words', artists: ['unknown'] });
  });
});
