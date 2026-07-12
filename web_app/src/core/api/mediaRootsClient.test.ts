import { describe, expect, test, vi } from 'vitest';

import {
  fetchMediaRoots,
  refreshMediaRoots,
  updateMediaRoots,
} from './mediaRootsClient';

describe('mediaRootsClient', () => {
  test('fetches media root settings', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          audioRoots: ['/music'],
          videoRoots: ['/video'],
          imageRoots: ['/images'],
          persistent: true,
          index: {
            enabled: true,
            loadedItems: 42,
            lastVerifiedAt: '2026-06-11T00:00:00Z',
            lastError: 'disk busy',
          },
          watcher: {
            enabled: true,
            backend: 'fsevents',
            roots: [
              {
                path: '/music',
                enabled: true,
                backend: 'fsevents',
              },
              {
                path: '/network',
                enabled: false,
                backend: 'fsevents',
                reason: 'network filesystem uses manual refresh',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await fetchMediaRoots({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/settings/media-roots',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({
      kind: 'ok',
      settings: {
        audioRoots: ['/music'],
        videoRoots: ['/video'],
        imageRoots: ['/images'],
        persistent: true,
        itemCount: undefined,
        degradedRoots: [],
        index: {
          enabled: true,
          loadedItems: 42,
          lastVerifiedAt: '2026-06-11T00:00:00Z',
          lastError: 'disk busy',
        },
        watcher: {
          enabled: true,
          backend: 'fsevents',
          roots: [
            {
              path: '/music',
              enabled: true,
              backend: 'fsevents',
              reason: undefined,
            },
            {
              path: '/network',
              enabled: false,
              backend: 'fsevents',
              reason: 'network filesystem uses manual refresh',
            },
          ],
        },
      },
    });
  });

  test('updates split media roots', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          audioRoots: ['/music'],
          videoRoots: ['/video'],
          imageRoots: ['/images'],
          itemCount: 2,
          persistent: false,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await updateMediaRoots(
      {
        audioRoots: ['/music'],
        videoRoots: ['/video'],
        imageRoots: ['/images'],
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/settings/media-roots',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          audioRoots: ['/music'],
          videoRoots: ['/video'],
          imageRoots: ['/images'],
        }),
      }),
    );
    expect(result.kind).toBe('ok');
  });

  test('refreshes current media roots', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          audioRoots: ['/music'],
          videoRoots: [],
          imageRoots: ['/images'],
          itemCount: 1,
          persistent: false,
          degradedRoots: [
            {
              name: 'music-deadbeef',
              path: '/music',
              error: 'permission denied',
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await refreshMediaRoots({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/settings/media-roots',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({
      kind: 'ok',
      settings: {
        audioRoots: ['/music'],
        videoRoots: [],
        imageRoots: ['/images'],
        itemCount: 1,
        persistent: false,
        degradedRoots: [
          {
            name: 'music-deadbeef',
            path: '/music',
            error: 'permission denied',
          },
        ],
        index: { enabled: false, loadedItems: 0 },
        watcher: { enabled: false, roots: [] },
      },
    });
  });
});
