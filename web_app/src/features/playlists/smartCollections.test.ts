import { describe, expect, test } from 'vitest';

import type { LibraryItem } from '../../core/api/libraryClient';
import type { PlaybackActivityRecord } from '../../core/storage/playbackActivityRepository';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';
import {
  buildSmartCollections,
  buildImageCollections,
  mapItemsByContentKey,
  resolvePlaylistItems,
  resolvePlaylistItemsFromIndex,
} from './smartCollections';

function item(id: string, name: string, type: LibraryItem['type'] = 'audio'): LibraryItem {
  return {
    id,
    type,
    rootName: type === 'video' ? 'video' : 'music',
    relativePath: name,
    name,
    sizeBytes: 1,
    modifiedAt: '2026-06-01T00:00:00.000Z',
  };
}

function record(
  contentKey: string,
  patch: Partial<PlaybackActivityRecord>,
): PlaybackActivityRecord {
  return {
    contentKey,
    mediaId: 'id',
    mediaType: 'audio',
    name: 'song.mp3',
    artist: null,
    playCount: 0,
    lastPlayedAt: null,
    lastPositionSec: 0,
    durationSec: 0,
    completed: false,
    events: [],
    ...patch,
  };
}

describe('resolvePlaylistItems', () => {
  test('resolves content keys against the current library', () => {
    const playlist: PlaylistRecord = {
      id: 'p1',
      name: 'Favorites',
      createdAt: '',
      updatedAt: '',
      items: [
        { contentKey: 'audio:title:b', addedAt: '' },
        { contentKey: 'missing', addedAt: '' },
        { contentKey: 'audio:title:other-device-only', addedAt: '' },
      ],
    };

    expect(
      resolvePlaylistItems(playlist, [item('a', 'a.mp3'), item('b', 'b.mp3')])
        .map((track) => track.id),
    ).toEqual(['b']);
    const index = mapItemsByContentKey([
      item('a', 'a.mp3'),
      item('b', 'b.mp3'),
    ]);
    expect(
      resolvePlaylistItemsFromIndex(playlist, index).map((track) => track.id),
    ).toEqual(['b']);
  });
});

describe('buildImageCollections', () => {
  test('classifies normalized image roots and bounds large drawers', () => {
    const images = Array.from({ length: 10_000 }, (_, index) => ({
      ...item(`image-${index}`, index === 0 ? '스크린샷 2026-08-11.png' : `photo-${index}.jpg`, 'image'),
      rootName: index % 2 === 0 ? 'Downloads-8b04eaaf' : 'Photos',
      relativePath: index === 1 ? 'Screenshots/capture.jpg' : `folder/photo-${index}.jpg`,
      modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    }));
    const collections = buildImageCollections({ items: images, likedKeys: ['image-0'] });

    expect(collections.map((collection) => collection.title)).toEqual([
      'Favorites', 'Recently Added', 'Screenshots', 'Downloads',
    ]);
    expect(collections.every((collection) => collection.items.length <= 100)).toBe(true);
    expect(collections.find((collection) => collection.id === 'image-screenshots')?.items.map((entry) => entry.id)).toContain('image-0');
    expect(collections.find((collection) => collection.id === 'image-screenshots')?.items.map((entry) => entry.id)).toContain('image-1');
    expect(collections.find((collection) => collection.id === 'image-downloads')?.items).toHaveLength(100);
  });
});

describe('buildSmartCollections', () => {
  test('keeps Most Played by count and Recently Watching by recency', () => {
    const tracks = [
      item('a', 'Lamp - Rainy Night.mp3'),
      item('b', 'b.mp3'),
      item('c', 'c.mp3'),
      item('v', 'clip.mp4', 'video'),
      item('v2', 'newer.mp4', 'video'),
      item('v3', 'same-time.mp4', 'video'),
    ];
    const collections = buildSmartCollections({
      items: tracks,
      likedKeys: ['audio:title:b'],
      activityRecords: [
        record('audio:artist:lamp:title:rainy-night', {
          playCount: 2,
          lastPlayedAt: '2026-06-01T11:00:00.000Z',
          events: [{ playedAt: '2026-06-01T11:00:00.000Z', weekday: 1, hour: 20 }],
        }),
        record('audio:title:c', {
          playCount: 5,
          lastPlayedAt: '2026-06-02T11:00:00.000Z',
          lastPositionSec: 20,
          durationSec: 100,
          completed: false,
        }),
        record('video:title:clip', {
          mediaId: 'v',
          mediaType: 'video',
          name: 'clip.mp4',
          playCount: 7,
          lastPlayedAt: '2026-06-01T10:00:00.000Z',
        }),
        record('video:title:newer', {
          mediaId: 'v2',
          mediaType: 'video',
          name: 'newer.mp4',
          playCount: 1,
          lastPlayedAt: '2026-06-03T10:00:00.000Z',
        }),
        record('video:title:same-time', {
          mediaId: 'v3',
          mediaType: 'video',
          name: 'same-time.mp4',
          playCount: 3,
          lastPlayedAt: '2026-06-03T10:00:00.000Z',
        }),
      ],
    });

    expect(collections.find((c) => c.id === 'liked-music')?.items.map((t) => t.id)).toEqual(['b']);
    expect(collections.find((c) => c.id === 'most-played')?.items.map((t) => t.id)).toEqual(['c', 'a']);
    expect(
      collections
        .find((c) => c.id === 'recently-watching')
        ?.items.map((t) => t.id),
    ).toEqual(['v3', 'v2', 'v']);
    expect(collections.map((c) => c.title)).toEqual([
      'Liked Music',
      'Most Played',
      'Recently Watching',
    ]);
  });
});
