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
    expect(buildStreamingUrl('abc')).toBe('/api/media/abc');
  });

  test('rejects an empty mediaId', () => {
    expect(() => buildStreamingUrl('')).toThrow();
  });

  test('rejects a whitespace-only mediaId', () => {
    expect(() => buildStreamingUrl('   ')).toThrow();
  });

  test('trims leading and trailing whitespace before encoding', () => {
    expect(buildStreamingUrl('  abc  ')).toBe('/api/media/abc');
  });

  test('URL-encodes path-unsafe characters', () => {
    // Today the backend hands out hex IDs, but the contract treats the ID as
    // opaque, so a future ID scheme could contain '/', ' ', '?', '#', etc.
    expect(buildStreamingUrl('a b/c?d#e')).toBe(
      `/api/media/${encodeURIComponent('a b/c?d#e')}`,
    );
  });

  test('appends a media fragment when startSec is positive', () => {
    expect(buildStreamingUrl('abc', { startSec: 120.45 })).toBe(
      '/api/media/abc#t=120.5',
    );
  });

  test('omits the fragment for zero, negative, or non-finite startSec', () => {
    expect(buildStreamingUrl('abc', { startSec: 0 })).toBe('/api/media/abc');
    expect(buildStreamingUrl('abc', { startSec: -1 })).toBe('/api/media/abc');
    expect(buildStreamingUrl('abc', { startSec: Number.NaN })).toBe(
      '/api/media/abc',
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
      url: '/api/media/abcd1234',
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
  test('creates a remote source synchronously', () => {
    const source = playbackSourceFromLibraryItem(sampleItem);
    expect(source).not.toBeInstanceOf(Promise);
    expect(source).toEqual(remoteSourceFromLibraryItem(sampleItem));
  });
});
