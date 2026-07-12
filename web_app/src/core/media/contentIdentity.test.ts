import { describe, expect, test } from 'vitest';

import {
  contentIdentityForLibraryItem,
  contentIdentityForName,
  contentIdentityForPlaybackSource,
} from './contentIdentity';

describe('contentIdentityForName', () => {
  test('builds a location-independent title key', () => {
    expect(
      contentIdentityForName({
        name: 'Album/ignored path/Song Name.mp3',
        mediaType: 'audio',
      }).key,
    ).toBe('audio:title:song-name');
  });

  test('extracts artist when the filename uses artist-title convention', () => {
    const identity = contentIdentityForName({
      name: 'Lamp - Rainy Night.flac',
      mediaType: 'audio',
    });

    expect(identity).toEqual({
      key: 'audio:artist:lamp:title:rainy-night',
      title: 'Rainy Night',
      artist: 'Lamp',
    });
  });

  test('keeps non-ascii title tokens', () => {
    expect(
      contentIdentityForName({
        name: '가수 - 월요일 밤.aac',
        mediaType: 'audio',
      }).key,
    ).toBe('audio:artist:가수:title:월요일-밤');
  });
});

describe('metadata-backed content identity', () => {
  test('uses library metadata before filename parsing', () => {
    const identity = contentIdentityForLibraryItem({
      id: 'm1',
      type: 'audio',
      rootName: 'music',
      relativePath: 'misc/unknown-file.mp3',
      name: 'unknown-file.mp3',
      sizeBytes: 1,
      modifiedAt: '2026-06-01T00:00:00Z',
      metadata: {
        title: 'Rainy Night',
        artist: 'Lamp',
      },
    });

    expect(identity.key).toBe('audio:artist:lamp:title:rainy-night');
  });

  test('uses playback source metadata for activity keys', () => {
    const identity = contentIdentityForPlaybackSource({
      kind: 'remote',
      mediaId: 'm1',
      mediaType: 'audio',
      url: '/api/media/m1',
      name: 'unknown-file.mp3',
      title: 'Rainy Night',
      artist: 'Lamp',
    });

    expect(identity.key).toBe('audio:artist:lamp:title:rainy-night');
  });
});
