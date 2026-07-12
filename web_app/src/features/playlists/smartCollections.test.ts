import { describe, expect, test } from 'vitest';

import type { LibraryItem } from '../../core/api/libraryClient';
import type { PlaybackActivityRecord } from '../../core/storage/playbackActivityRepository';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';
import {
  buildSmartCollections,
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

describe('buildSmartCollections', () => {
  test('builds 1.2.5 automatic playlists by media type and play count', () => {
    const tracks = [
      item('a', 'Lamp - Rainy Night.mp3'),
      item('b', 'b.mp3'),
      item('c', 'c.mp3'),
      item('v', 'clip.mp4', 'video'),
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
        }),
      ],
    });

    expect(collections.find((c) => c.id === 'liked-music')?.items.map((t) => t.id)).toEqual(['b']);
    expect(collections.find((c) => c.id === 'most-played')?.items.map((t) => t.id)).toEqual(['c', 'a']);
    expect(collections.find((c) => c.id === 'recently-watching')?.items.map((t) => t.id)).toEqual(['v']);
    expect(collections.map((c) => c.title)).toEqual([
      'Liked Music',
      'Most Played',
      'Recently Watching',
    ]);
  });
});
