import { describe, expect, test } from 'vitest';

import type { LibraryItem } from '../../core/api/libraryClient';
import { filterAndSortLibraryItems } from './libraryView';

function item(patch: Partial<LibraryItem>): LibraryItem {
  return {
    id: patch.id ?? 'id',
    type: patch.type ?? 'audio',
    rootName: 'root',
    relativePath: patch.relativePath ?? patch.name ?? 'song.mp3',
    name: patch.name ?? 'song.mp3',
    sizeBytes: patch.sizeBytes ?? 1,
    modifiedAt: patch.modifiedAt ?? '2026-06-01T00:00:00Z',
    metadata: patch.metadata,
    thumbnail: patch.thumbnail,
    subtitles: patch.subtitles,
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
