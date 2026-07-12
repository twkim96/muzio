import { describe, expect, test, vi } from 'vitest';

import { fetchLibrary, fetchLibraryChanges } from './libraryClient';

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    impl(typeof url === 'string' ? url : url.toString(), init)) as typeof fetch;
}

const sampleResponse = {
  items: [
    {
      id: 'abcd1234',
      type: 'video',
      rootName: 'movies-25f1721e',
      relativePath: 'Inception/Inception.mkv',
      name: 'Inception.mkv',
      sizeBytes: 8589934592,
      modifiedAt: '2025-01-15T10:30:00Z',
    },
    {
      id: 'ijkl9012',
      type: 'image',
      rootName: 'images-3fd9b7d2',
      relativePath: 'photo.jpg',
      name: 'photo.jpg',
      sizeBytes: 1048576,
      modifiedAt: '2025-01-16T10:30:00Z',
    },
    {
      id: 'efgh5678',
      type: 'audio',
      rootName: 'music-f5e4b41e',
      relativePath: 'song.mp3',
      name: 'song.mp3',
      sizeBytes: 5242880,
      modifiedAt: '2025-01-15T10:30:00Z',
    },
  ],
};

describe('fetchLibrary', () => {
  test('issues a same-origin GET to /api/library when filter is "all"', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await fetchLibrary('all', { fetchImpl });

    expect(observedUrl).toBe('/api/library');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.items).toHaveLength(3);
      expect(result.items[0].id).toBe('abcd1234');
      expect(result.items[1].type).toBe('image');
    }
  });

  test('parses revision and ETag from a full list', async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(JSON.stringify({ revision: 12, items: [] }), {
        status: 200,
        headers: { ETag: 'W/"library-12-audio"' },
      }),
    );

    const result = await fetchLibrary('audio', { fetchImpl });

    expect(result).toEqual({
      kind: 'ok',
      items: [],
      revision: 12,
      etag: 'W/"library-12-audio"',
    });
  });

  test('uses If-None-Match and accepts 304', async () => {
    let observedHeaders: HeadersInit | undefined;
    const fetchImpl = fakeFetch(async (_url, init) => {
      observedHeaders = init?.headers;
      return new Response(null, { status: 304 });
    });

    const result = await fetchLibrary('audio', {
      fetchImpl,
      ifNoneMatch: 'W/"library-12-audio"',
    });

    expect(observedHeaders).toEqual({
      'If-None-Match': 'W/"library-12-audio"',
    });
    expect(result).toEqual({
      kind: 'notModified',
      etag: 'W/"library-12-audio"',
    });
  });

  test('appends type filter when video is requested', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    await fetchLibrary('video', { fetchImpl });

    expect(observedUrl).toBe('/api/library?type=video');
  });

  test('appends type filter when audio is requested', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    await fetchLibrary('audio', { fetchImpl });

    expect(observedUrl).toBe('/api/library?type=audio');
  });

  test('appends type filter when image is requested', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });

    await fetchLibrary('image', { fetchImpl });

    expect(observedUrl).toBe('/api/library?type=image');
  });

  test('returns badResponse for non-200', async () => {
    const fetchImpl = fakeFetch(
      async () => new Response('boom', { status: 500 }),
    );
    const result = await fetchLibrary('all', { fetchImpl });
    expect(result.kind).toBe('badResponse');
    if (result.kind === 'badResponse') {
      expect(result.statusCode).toBe(500);
    }
  });

  test('returns badResponse when body shape is unexpected', async () => {
    const fetchImpl = fakeFetch(
      async () => new Response(JSON.stringify({ unrelated: true }), {
        status: 200,
      }),
    );
    const result = await fetchLibrary('all', { fetchImpl });
    expect(result.kind).toBe('badResponse');
  });

  test('drops malformed items but keeps valid ones', async () => {
    const fetchImpl = fakeFetch(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'good',
                type: 'audio',
                rootName: 'r',
                relativePath: 'a.mp3',
                name: 'a.mp3',
                sizeBytes: 100,
                modifiedAt: '2025-01-01T00:00:00Z',
              },
              {
                id: 'image',
                type: 'image',
                rootName: 'r',
                relativePath: 'cover.jpg',
                name: 'cover.jpg',
                sizeBytes: 100,
                modifiedAt: '2025-01-01T00:00:00Z',
              },
              { id: 'bad-type', type: 'document' },
              { not: 'an item' },
            ],
          }),
          { status: 200 },
        ),
    );

    const result = await fetchLibrary('all', { fetchImpl });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.items.map((i) => i.id)).toEqual(['good', 'image']);
    }
  });

  test('parses metadata, thumbnail, and subtitle fields', async () => {
    const fetchImpl = fakeFetch(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'good',
                type: 'video',
                rootName: 'r',
                relativePath: 'Show.S01E02.mkv',
                name: 'Show.S01E02.mkv',
                mimeType: 'video/x-matroska',
                sizeBytes: 100,
                modifiedAt: '2025-01-01T00:00:00Z',
                metadata: {
                  title: 'Show',
                  season: 1,
                  episode: 2,
                  year: 2025,
                  durationSec: 2700,
                },
                thumbnail: {
                  url: '/api/thumbnails/good?v=abc',
                  kind: 'generated-fallback',
                  status: 'ready',
                  cacheKey: 'abc',
                },
                subtitles: [
                  {
                    relativePath: 'Show.S01E02.en.srt',
                    language: 'en',
                    label: 'EN',
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const result = await fetchLibrary('video', { fetchImpl });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.items[0].metadata).toMatchObject({
        title: 'Show',
        season: 1,
        episode: 2,
        durationSec: 2700,
      });
      expect(result.items[0].mimeType).toBe('video/x-matroska');
      expect(result.items[0].thumbnail?.url).toBe('/api/thumbnails/good?v=abc');
      expect(result.items[0].subtitles).toHaveLength(1);
    }
  });

  test('reports timeouts as unreachable', async () => {
    const fetchImpl = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const result = await fetchLibrary('all', {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result.kind).toBe('unreachable');
  });

  test('reports thrown errors as unreachable', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('net down');
    });
    const result = await fetchLibrary('all', { fetchImpl });
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.message).toBe('net down');
    }
  });

  test('forwards an external AbortSignal', async () => {
    const externalController = new AbortController();
    const fetchImpl = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const inflight = fetchLibrary('all', {
      fetchImpl,
      signal: externalController.signal,
    });
    externalController.abort();
    const result = await inflight;
    expect(result.kind).toBe('unreachable');
  });

  test('uses the global fetch when fetchImpl is not provided', async () => {
    const stub = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const result = await fetchLibrary('all');
      expect(result.kind).toBe('ok');
      expect(stub).toHaveBeenCalledWith(
        '/api/library',
        expect.objectContaining({ signal: expect.anything() }),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test('aborts during body read when the timeout fires after headers arrive', async () => {
    // Servers can return headers and then stall the body. We simulate this
    // by returning a Response whose json() never resolves until the request
    // signal aborts. The fetch contract used by the production code only
    // depends on .status and .json(), so we can hand-roll the response.
    const fetchImpl = fakeFetch(async (_url, init) => {
      const fakeResponse = {
        status: 200,
        json: () =>
          new Promise<unknown>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      } as unknown as Response;
      return fakeResponse;
    });

    const result = await fetchLibrary('all', { fetchImpl, timeoutMs: 20 });

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.message).toBe('request cancelled or timed out');
    }
  });
});

describe('fetchLibraryChanges', () => {
  test('parses a filtered delta', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(
        JSON.stringify({
          revision: 9,
          upserts: [sampleResponse.items[2]],
          deletedIds: ['old'],
          resetRequired: false,
        }),
        {
          status: 200,
          headers: { ETag: 'W/"library-9-audio"' },
        },
      );
    });

    const result = await fetchLibraryChanges('audio', 7, { fetchImpl });

    expect(observedUrl).toBe('/api/library/changes?since=7&type=audio');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.revision).toBe(9);
      expect(result.upserts.map((item) => item.id)).toEqual(['efgh5678']);
      expect(result.deletedIds).toEqual(['old']);
      expect(result.resetRequired).toBe(false);
      expect(result.etag).toBe('W/"library-9-audio"');
    }
  });
});
