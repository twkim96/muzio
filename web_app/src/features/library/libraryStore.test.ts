import { describe, expect, test } from 'vitest';

import type {
  LibraryFetchOptions,
  LibraryFetchResult,
  LibraryItem,
  LibraryMediaType,
} from '../../core/api/libraryClient';
import {
  createLibraryStore,
  type LibrarySnapshot,
  type LibrarySnapshotCache,
} from './libraryStore';

const sampleAudioItem: LibraryItem = {
  id: 'cached',
  type: 'audio',
  rootName: 'music',
  relativePath: 'cached.mp3',
  name: 'cached.mp3',
  sizeBytes: 1,
  modifiedAt: '2026-01-01T00:00:00Z',
};

function memorySnapshotCache(
  initial: LibrarySnapshot | null = null,
): LibrarySnapshotCache & { snapshot: LibrarySnapshot | null } {
  return {
    snapshot: initial,
    read() {
      return this.snapshot;
    },
    write(snapshot) {
      this.snapshot = snapshot;
    },
    clear() {
      this.snapshot = null;
    },
  };
}

function fakeFetcher(
  result: LibraryFetchResult,
  observedTypes?: LibraryMediaType[] | 'collect',
) {
  const seen: LibraryMediaType[] = [];
  const fetcher = async (
    type: LibraryMediaType | 'all',
  ): Promise<LibraryFetchResult> => {
    seen.push(type as LibraryMediaType);
    return result;
  };
  return { fetcher, seen, observedTypes };
}

describe('createLibraryStore', () => {
  test('initial status is idle and no result', () => {
    const useStore = createLibraryStore({ type: 'audio' });
    const state = useStore.getState();
    expect(state.status).toBe('idle');
    expect(state.result).toBeNull();
    expect(state.revision).toBe(0);
    expect(state.stale).toBe(false);
  });

  test('load resolves to ok and stores items', async () => {
    const result: LibraryFetchResult = {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'r',
          relativePath: 'a.mp3',
          name: 'a.mp3',
          sizeBytes: 1,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    };
    const { fetcher, seen } = fakeFetcher(result);
    const useStore = createLibraryStore({ type: 'audio', fetcher });

    await useStore.getState().load();

    const state = useStore.getState();
    expect(seen).toEqual(['audio']);
    expect(state.status).toBe('ok');
    expect(state.result).toEqual(result);
  });

  test('boots audio from a cached snapshot as stale data', () => {
    const cache = memorySnapshotCache({
      revision: 9,
      etag: 'W/"library-9-audio"',
      complete: true,
      items: [sampleAudioItem],
    });
    const useStore = createLibraryStore({
      type: 'audio',
      snapshotCache: cache,
    });

    const state = useStore.getState();
    expect(state.status).toBe('ok');
    expect(state.stale).toBe(true);
    expect(state.revision).toBe(9);
    expect(state.etag).toBe('W/"library-9-audio"');
    expect(state.result?.kind === 'ok' ? state.result.items : []).toEqual([
      sampleAudioItem,
    ]);
  });

  test('preserving reload from cached data sends the cached ETag', async () => {
    const seen: Array<string | undefined> = [];
    const cache = memorySnapshotCache({
      revision: 9,
      etag: 'W/"library-9-audio"',
      complete: true,
      items: [sampleAudioItem],
    });
    const useStore = createLibraryStore({
      type: 'audio',
      snapshotCache: cache,
      fetcher: async (
        _type: LibraryMediaType | 'all',
        options?: LibraryFetchOptions,
      ) => {
        seen.push(options?.ifNoneMatch);
        return { kind: 'notModified', etag: options?.ifNoneMatch };
      },
    });

    await useStore.getState().load({ preserveResult: true });

    expect(seen).toEqual(['W/"library-9-audio"']);
    expect(useStore.getState().status).toBe('ok');
    expect(useStore.getState().stale).toBe(false);
    expect(useStore.getState().result?.kind).toBe('ok');
  });

  test('successful loads update the snapshot cache', async () => {
    const cache = memorySnapshotCache();
    const useStore = createLibraryStore({
      type: 'audio',
      snapshotCache: cache,
      fetcher: async () => ({
        kind: 'ok',
        revision: 10,
        etag: 'W/"library-10-audio"',
        items: [sampleAudioItem],
      }),
    });

    await useStore.getState().load();

    expect(cache.snapshot).toEqual({
      revision: 10,
      etag: 'W/"library-10-audio"',
      complete: true,
      items: [sampleAudioItem],
    });
  });

  test('preserving reload from an incomplete cache omits its ETag', async () => {
    const seen: Array<string | undefined> = [];
    const cache = memorySnapshotCache({
      revision: 9,
      etag: undefined,
      complete: false,
      items: [sampleAudioItem],
    });
    const useStore = createLibraryStore({
      type: 'audio',
      snapshotCache: cache,
      fetcher: async (_type, options) => {
        seen.push(options?.ifNoneMatch);
        return {
          kind: 'ok',
          revision: 10,
          etag: 'W/"library-10-audio"',
          items: [sampleAudioItem],
        };
      },
    });

    await useStore.getState().load({ preserveResult: true });

    expect(seen).toEqual([undefined]);
    expect(cache.snapshot?.complete).toBe(true);
  });

  test('does not accept 304 as a complete result for an incomplete cache', async () => {
    const cache = memorySnapshotCache({
      revision: 9,
      etag: undefined,
      complete: false,
      items: [sampleAudioItem],
    });
    const useStore = createLibraryStore({
      type: 'audio',
      snapshotCache: cache,
      fetcher: async () => ({
        kind: 'notModified',
        etag: 'W/"library-9-audio"',
      }),
    });

    await useStore.getState().load({ preserveResult: true });

    expect(useStore.getState()).toMatchObject({
      status: 'error',
      stale: true,
      etag: undefined,
    });
  });

  test('passes the configured type to the fetcher', async () => {
    const { fetcher, seen } = fakeFetcher({ kind: 'ok', items: [] });
    const useStore = createLibraryStore({ type: 'video', fetcher });
    await useStore.getState().load();
    expect(seen).toEqual(['video']);
  });

  test('load failures are surfaced as status=error with the result attached', async () => {
    const result: LibraryFetchResult = {
      kind: 'unreachable',
      message: 'net down',
    };
    const { fetcher } = fakeFetcher(result);
    const useStore = createLibraryStore({ type: 'audio', fetcher });

    await useStore.getState().load();

    const state = useStore.getState();
    expect(state.status).toBe('error');
    expect(state.result).toEqual(result);
  });

  test('load toggles status=loading while waiting', async () => {
    let release!: (value: LibraryFetchResult) => void;
    const fetcher = () =>
      new Promise<LibraryFetchResult>((resolve) => {
        release = resolve;
      });
    const useStore = createLibraryStore({ type: 'audio', fetcher });

    const inflight = useStore.getState().load();
    expect(useStore.getState().status).toBe('loading');

    release({ kind: 'ok', items: [] });
    await inflight;

    expect(useStore.getState().status).toBe('ok');
  });

  test('load can keep the previous result while refreshing', async () => {
    let release!: (value: LibraryFetchResult) => void;
    const first: LibraryFetchResult = { kind: 'ok', items: [] };
    const second = new Promise<LibraryFetchResult>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: async () => {
        calls += 1;
        return calls === 1 ? first : second;
      },
    });

    await useStore.getState().load();
    const inflight = useStore.getState().load({ preserveResult: true });

    expect(useStore.getState().status).toBe('loading');
    expect(useStore.getState().result).toBe(first);

    release({ kind: 'ok', items: [] });
    await inflight;
  });

  test('reset returns the store to idle', async () => {
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: async () => ({ kind: 'ok', items: [] }),
    });
    await useStore.getState().load();
    useStore.getState().reset();

    const state = useStore.getState();
    expect(state.status).toBe('idle');
    expect(state.result).toBeNull();
  });

  test('applies upserts and deletes without clearing the loaded result', async () => {
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: async () => ({
        kind: 'ok',
        revision: 3,
        etag: 'W/"library-3-audio"',
        items: [
          {
            id: 'old',
            type: 'audio',
            rootName: 'music',
            relativePath: 'old.mp3',
            name: 'old.mp3',
            sizeBytes: 1,
            modifiedAt: '2025-01-01T00:00:00Z',
          },
        ],
      }),
    });
    await useStore.getState().load();

    useStore.getState().applyChanges({
      kind: 'ok',
      revision: 4,
      etag: 'W/"library-4-audio"',
      deletedIds: ['old'],
      resetRequired: false,
      upserts: [
        {
          id: 'new',
          type: 'audio',
          rootName: 'music',
          relativePath: 'new.mp3',
          name: 'new.mp3',
          sizeBytes: 2,
          modifiedAt: '2025-01-02T00:00:00Z',
        },
      ],
    });

    const state = useStore.getState();
    expect(state.status).toBe('ok');
    expect(state.revision).toBe(4);
    expect(state.etag).toBe('W/"library-4-audio"');
    expect(state.result?.kind === 'ok' ? state.result.etag : undefined).toBe(
      'W/"library-4-audio"',
    );
    expect(state.result?.kind === 'ok' ? state.result.items.map((item) => item.id) : []).toEqual([
      'new',
    ]);
  });

  test('keeps the default latest order while merging a delta', async () => {
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: async () => ({
        kind: 'ok',
        revision: 1,
        items: [
          {
            id: 'old',
            type: 'audio',
            rootName: 'music',
            relativePath: 'old.mp3',
            name: 'old.mp3',
            sizeBytes: 1,
            modifiedAt: '2025-01-01T00:00:00Z',
          },
          {
            id: 'middle',
            type: 'audio',
            rootName: 'music',
            relativePath: 'middle.mp3',
            name: 'middle.mp3',
            sizeBytes: 1,
            modifiedAt: '2025-01-02T00:00:00Z',
          },
        ],
      }),
    });
    await useStore.getState().load();
    useStore.getState().applyChanges({
      kind: 'ok',
      revision: 2,
      deletedIds: [],
      resetRequired: false,
      upserts: [
        {
          id: 'new',
          type: 'audio',
          rootName: 'music',
          relativePath: 'new.mp3',
          name: 'new.mp3',
          sizeBytes: 1,
          modifiedAt: '2025-01-03T00:00:00Z',
        },
      ],
    });

    const result = useStore.getState().result;
    expect(
      result?.kind === 'ok' ? result.items.map((item) => item.id) : [],
    ).toEqual(['new', 'middle', 'old']);
  });

  test('preserving reload failure keeps the visible result', async () => {
    let calls = 0;
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'ok', revision: 2, items: [] }
          : { kind: 'unreachable', message: 'offline' };
      },
    });
    await useStore.getState().load();
    const visible = useStore.getState().result;

    await useStore.getState().load({ preserveResult: true });

    expect(useStore.getState().status).toBe('error');
    expect(useStore.getState().result).toBe(visible);
    expect(useStore.getState().stale).toBe(true);
  });

  test('a late full reload cannot overwrite a newer delta revision', async () => {
    let release!: (value: LibraryFetchResult) => void;
    let calls = 0;
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: async () => {
        calls += 1;
        if (calls === 1) {
          return { kind: 'ok', revision: 9, items: [] };
        }
        return new Promise<LibraryFetchResult>((resolve) => {
          release = resolve;
        });
      },
    });
    await useStore.getState().load();
    const reload = useStore.getState().load({ preserveResult: true });
    useStore.getState().applyChanges({
      kind: 'ok',
      revision: 11,
      deletedIds: [],
      resetRequired: false,
      upserts: [
        {
          id: 'new',
          type: 'audio',
          rootName: 'music',
          relativePath: 'new.mp3',
          name: 'new.mp3',
          sizeBytes: 1,
          modifiedAt: '2026-06-11T00:00:00Z',
        },
      ],
    });
    release({ kind: 'ok', revision: 10, items: [] });
    await reload;

    const state = useStore.getState();
    expect(state.revision).toBe(11);
    expect(state.result?.kind === 'ok' ? state.result.items[0]?.id : undefined).toBe(
      'new',
    );
  });

  test('an event received during initial load remains stale after the response', async () => {
    let release!: (value: LibraryFetchResult) => void;
    const useStore = createLibraryStore({
      type: 'audio',
      fetcher: () =>
        new Promise<LibraryFetchResult>((resolve) => {
          release = resolve;
        }),
    });
    const load = useStore.getState().load();
    useStore.getState().markStale(11);
    release({ kind: 'ok', revision: 10, items: [] });
    await load;

    expect(useStore.getState().revision).toBe(10);
    expect(useStore.getState().stale).toBe(true);
    expect(useStore.getState().staleRevision).toBe(11);
  });

  test('keeps the semantic item array stable for thumbnail-only updates', async () => {
    const base = {
      id: 'video',
      type: 'video' as const,
      rootName: 'video',
      relativePath: 'clip.mp4',
      name: 'clip.mp4',
      sizeBytes: 1,
      modifiedAt: '2026-06-15T00:00:00Z',
      metadata: { title: 'clip' },
      thumbnail: {
        url: '/api/thumbnails/video?v=key&state=pending',
        kind: 'generated-frame',
        status: 'pending',
        cacheKey: 'key',
      },
    };
    const useStore = createLibraryStore({
      type: 'video',
      fetcher: async () => ({ kind: 'ok', revision: 1, items: [base] }),
    });
    await useStore.getState().load();
    const loaded = useStore.getState().result;
    const initialItems =
      loaded?.kind === 'ok' ? loaded.items : [];

    useStore.getState().applyChanges({
      kind: 'ok',
      revision: 2,
      deletedIds: [],
      resetRequired: false,
      upserts: [
        {
          ...base,
          thumbnail: {
            ...base.thumbnail,
            url: '/api/thumbnails/video?v=key&state=ready',
            status: 'ready',
          },
        },
      ],
    });

    const state = useStore.getState();
    expect(state.result?.kind === 'ok' ? state.result.items : []).toBe(
      initialItems,
    );
    expect(state.presentation.get('video')?.status).toBe('ready');
    expect(state.revision).toBe(2);
  });

  test('processes repeated thumbnail updates without replacing semantic items', async () => {
    const items = Array.from({ length: 15_000 }, (_, index) => ({
      id: `video-${index}`,
      type: 'video' as const,
      rootName: 'video',
      relativePath: `video-${index}.mp4`,
      name: `video-${index}.mp4`,
      sizeBytes: index + 1,
      modifiedAt: '2026-06-15T00:00:00Z',
      metadata: { title: `video-${index}` },
      thumbnail: {
        url: `/api/thumbnails/video-${index}?v=key&state=pending`,
        kind: 'generated-frame',
        status: 'pending',
        cacheKey: 'key',
      },
    }));
    const useStore = createLibraryStore({
      type: 'video',
      fetcher: async () => ({ kind: 'ok', revision: 1, items }),
    });
    await useStore.getState().load();
    const loaded = useStore.getState().result;
    const initialItems =
      loaded?.kind === 'ok' ? loaded.items : [];

    for (let index = 0; index < 500; index += 1) {
      const item = items[index];
      useStore.getState().applyChanges({
        kind: 'ok',
        revision: index + 2,
        deletedIds: [],
        resetRequired: false,
        upserts: [
          {
            ...item,
            thumbnail: {
              ...item.thumbnail,
              url: `/api/thumbnails/${item.id}?v=key&state=ready`,
              status: 'ready',
            },
          },
        ],
      });
      const current = useStore.getState().result;
      expect(
        current?.kind === 'ok' ? current.items : [],
      ).toBe(initialItems);
    }

    expect(useStore.getState().presentation.get('video-499')?.status).toBe(
      'ready',
    );
  });
});
