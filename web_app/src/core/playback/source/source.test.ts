import { describe, expect, test } from 'vitest';

import {
  buildStreamingUrl,
  playbackSourceFromLibraryItem,
  remoteSourceFromLibraryItem,
  type PlayableLibraryItem,
} from './source';

const sampleItem: PlayableLibraryItem = {
  id: 'abcd1234',
  type: 'video',
  rootName: 'movies',
  relativePath: 'Inception/Inception.mkv',
  name: 'Inception.mkv',
  sizeBytes: 0,
  modifiedAt: '2025-01-01T00:00:00Z',
  metadata: {
    title: 'Inception',
    durationSec: 888,
  },
};

describe('buildStreamingUrl', () => {
  test('produces a same-origin /api/media URL', () => {
    expect(buildStreamingUrl('abc')).toBe('/api/media/abc?v=2');
  });

  test('rejects an empty mediaId', () => {
    expect(() => buildStreamingUrl('')).toThrow();
  });

  test('rejects a whitespace-only mediaId', () => {
    expect(() => buildStreamingUrl('   ')).toThrow();
  });

  test('trims leading and trailing whitespace before encoding', () => {
    expect(buildStreamingUrl('  abc  ')).toBe('/api/media/abc?v=2');
  });

  test('URL-encodes path-unsafe characters', () => {
    // Today the backend hands out hex IDs, but the contract treats the ID as
    // opaque, so a future ID scheme could contain '/', ' ', '?', '#', etc.
    expect(buildStreamingUrl('a b/c?d#e')).toBe(
      `/api/media/${encodeURIComponent('a b/c?d#e')}?v=2`,
    );
  });

  test('appends a media fragment when startSec is positive', () => {
    expect(buildStreamingUrl('abc', { startSec: 120.45 })).toBe(
      '/api/media/abc?v=2#t=120.5',
    );
  });

  test('omits the fragment for zero, negative, or non-finite startSec', () => {
    expect(buildStreamingUrl('abc', { startSec: 0 })).toBe('/api/media/abc?v=2');
    expect(buildStreamingUrl('abc', { startSec: -1 })).toBe('/api/media/abc?v=2');
    expect(buildStreamingUrl('abc', { startSec: Number.NaN })).toBe(
      '/api/media/abc?v=2',
    );
  });

  test('keeps local media URLs unversioned and preserves resume fragments', () => {
    expect(buildStreamingUrl('local:a/b')).toBe('/__muzio_local/media/local%3Aa%2Fb');
    expect(buildStreamingUrl('local:a/b', { startSec: 120.45 })).toBe(
      '/__muzio_local/media/local%3Aa%2Fb#t=120.5',
    );
  });
});

describe('remoteSourceFromLibraryItem', () => {
  test('mirrors the library record into a remote source', () => {
    const source = remoteSourceFromLibraryItem(sampleItem, 'video/x-matroska');
    expect(source).toEqual({
      kind: 'remote',
      mediaId: 'abcd1234',
      mediaType: 'video',
      url: '/api/media/abcd1234?v=2',
      mimeType: 'video/x-matroska',
      name: 'Inception.mkv',
      title: 'Inception',
      durationSec: 888,
      rootName: 'movies',
      relativePath: 'Inception/Inception.mkv',
    });
  });

  test('omits mimeType when not provided', () => {
    const source = remoteSourceFromLibraryItem(sampleItem);
    expect(source.mimeType).toBeUndefined();
  });

  test('uses the library item mimeType when no override is supplied', () => {
    const source = remoteSourceFromLibraryItem({
      ...sampleItem,
      mimeType: 'video/x-matroska',
    });
    expect(source.mimeType).toBe('video/x-matroska');
  });
});

describe('playbackSourceFromLibraryItem', () => {
  test.each(['ready', 'pending', 'unavailable'])('handles %s video thumbnails', (status) => {
    const source = playbackSourceFromLibraryItem({
      ...sampleItem,
      type: 'video',
      thumbnail: {
        url: `/api/thumbnails/v1?v=frame&state=${status}`,
        kind: 'generated-frame',
        status,
        cacheKey: 'frame',
      },
    });
    expect(source.artworkUrl).toBe(
      status === 'ready' ? '/api/thumbnails/v1?v=frame&state=ready' : undefined,
    );
  });

  test('creates a remote source synchronously', () => {
    const source = playbackSourceFromLibraryItem(sampleItem);
    expect(source).not.toBeInstanceOf(Promise);
    expect(source).toEqual(remoteSourceFromLibraryItem(sampleItem));
  });

  test('forwards only ready embedded audio artwork', () => {
    const source = playbackSourceFromLibraryItem({
      ...sampleItem,
      type: 'audio',
      thumbnail: {
        url: '/api/thumbnails/a1?v=cover&state=ready',
        kind: 'embedded-artwork',
        status: 'ready',
        cacheKey: 'cover',
      },
    });
    expect(source.artworkUrl).toBe('/api/thumbnails/a1?v=cover&state=ready');

    const pending = playbackSourceFromLibraryItem({
      ...sampleItem,
      type: 'audio',
      thumbnail: {
        url: '/api/thumbnails/a1?v=cover&state=pending',
        kind: 'embedded-artwork',
        status: 'pending',
        cacheKey: 'cover',
      },
    });
    expect(pending.artworkUrl).toBeUndefined();
  });
});
