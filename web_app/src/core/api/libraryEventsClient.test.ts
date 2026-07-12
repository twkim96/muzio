import { afterEach, describe, expect, test, vi } from 'vitest';

import { createLibraryStore } from '../../features/library/libraryStore';
import type { LibraryFetchResult } from './libraryClient';
import {
  parseLibraryRevisionEvent,
  startLibraryLiveSync,
} from './libraryEventsClient';
import { createPlaybackNetworkGate } from '../playback/networkGate/playbackNetworkGate';

class FakeEventSource {
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    this.listeners.set(type, listener);
  }

  emit(data: unknown) {
    this.listeners.get('library')?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  close() {
    this.closed = true;
  }
}

class FakeDocument {
  hidden = false;
  listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.delete(listener);
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('libraryEventsClient', () => {
  test('parses compact revision events', () => {
    expect(
      parseLibraryRevisionEvent(
        JSON.stringify({
          revision: 7,
          affectedTypes: ['audio', 'audio', 'invalid'],
          reason: 'watch',
        }),
      ),
    ).toEqual({
      revision: 7,
      affectedTypes: ['audio'],
      reason: 'watch',
    });
    expect(parseLibraryRevisionEvent('not json')).toBeNull();
  });

  test('fetches deltas only for loaded stores and marks idle stores stale', async () => {
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const fetchChanges = vi.fn(async () => ({
      kind: 'ok' as const,
      revision: 3,
      upserts: [
        {
          id: 'song',
          type: 'audio' as const,
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1,
          modifiedAt: '2026-06-11T00:00:00Z',
        },
      ],
      deletedIds: [],
      resetRequired: false,
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({
      revision: 3,
      affectedTypes: ['audio', 'video'],
      reason: 'watch',
    });

    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(3);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    expect(fetchChanges).toHaveBeenCalledWith(
      'audio',
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stores.video.getState().status).toBe('idle');
    expect(stores.video.getState().stale).toBe(true);
    stop();
  });

  test('coalesces a newer revision while a delta request is in flight', async () => {
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchChanges = vi.fn(async (_type: 'audio' | 'video' | 'image', since: number) => {
      if (since === 1) await first;
      return {
        kind: 'ok' as const,
        revision: since === 1 ? 2 : 3,
        upserts: [],
        deletedIds: [],
        resetRequired: false,
      };
    });
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    source.emit({ revision: 3, affectedTypes: ['audio'], reason: 'watch' });
    release();

    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(3);
    });
    expect(fetchChanges.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    stop();
  });

  test('closes the event stream after a tab stays hidden', () => {
    vi.useFakeTimers();
    const stores = {
      audio: createLibraryStore({ type: 'audio' }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    const source = new FakeEventSource();
    const documentRef = new FakeDocument();
    const stop = startLibraryLiveSync({
      stores,
      eventSourceFactory: () => source,
      documentRef,
      hiddenCloseDelayMs: 60_000,
    });

    documentRef.setHidden(true);
    vi.advanceTimersByTime(59_999);
    expect(source.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(source.closed).toBe(true);
    stop();
  });

  test('defers delta traffic while hidden and catches up on visibility', async () => {
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const documentRef = new FakeDocument();
    const fetchChanges = vi.fn(async () => ({
      kind: 'ok' as const,
      revision: 2,
      upserts: [],
      deletedIds: [],
      resetRequired: false,
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef,
    });

    documentRef.setHidden(true);
    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await Promise.resolve();
    expect(fetchChanges).not.toHaveBeenCalled();

    documentRef.setHidden(false);
    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(2);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    stop();
  });

  test('defers automatic delta traffic during playback startup', async () => {
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const gate = createPlaybackNetworkGate({
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    const endStartup = gate.beginAudioStartup('song');
    const fetchChanges = vi.fn(async () => ({
      kind: 'ok' as const,
      revision: 2,
      upserts: [],
      deletedIds: [],
      resetRequired: false,
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
      networkGate: gate,
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await Promise.resolve();
    expect(fetchChanges).not.toHaveBeenCalled();

    endStartup();
    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(2);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    stop();
  });

  test('defers connected reloads during playback startup', async () => {
    let audioFetchCount = 0;
    const fetchAudio = vi.fn(async (): Promise<LibraryFetchResult> => {
      audioFetchCount += 1;
      return {
        kind: 'ok',
        revision: audioFetchCount === 1 ? 10 : 9,
        items: [],
      };
    });
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: fetchAudio,
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const gate = createPlaybackNetworkGate({
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    const endStartup = gate.beginAudioStartup('song');
    const stop = startLibraryLiveSync({
      stores,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
      networkGate: gate,
    });

    source.emit({ revision: 9, affectedTypes: ['audio'], reason: 'connected' });
    await Promise.resolve();
    expect(fetchAudio).toHaveBeenCalledTimes(1);

    endStartup();
    await vi.waitFor(() => {
      expect(fetchAudio).toHaveBeenCalledTimes(2);
    });
    stop();
  });

  test('keeps a deferred connected reload ahead of later watch events', async () => {
    let audioFetchCount = 0;
    const fetchAudio = vi.fn(async (): Promise<LibraryFetchResult> => {
      audioFetchCount += 1;
      return {
        kind: 'ok',
        revision: audioFetchCount === 1 ? 10 : 9,
        items: [],
      };
    });
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: fetchAudio,
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const gate = createPlaybackNetworkGate({
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    const endStartup = gate.beginAudioStartup('song');
    const fetchChanges = vi.fn(async () => ({
      kind: 'ok' as const,
      revision: 10,
      upserts: [],
      deletedIds: [],
      resetRequired: false,
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
      networkGate: gate,
    });

    source.emit({ revision: 9, affectedTypes: ['audio'], reason: 'connected' });
    source.emit({ revision: 10, affectedTypes: ['audio'], reason: 'watch' });
    await Promise.resolve();
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(fetchChanges).not.toHaveBeenCalled();

    endStartup();
    await vi.waitFor(() => {
      expect(fetchAudio).toHaveBeenCalledTimes(2);
    });
    stop();
  });

  test('reconnects when a hidden tab becomes visible again', () => {
    vi.useFakeTimers();
    const stores = {
      audio: createLibraryStore({ type: 'audio' }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    const sources: FakeEventSource[] = [];
    const documentRef = new FakeDocument();
    const stop = startLibraryLiveSync({
      stores,
      eventSourceFactory: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      documentRef,
      hiddenCloseDelayMs: 60_000,
    });

    documentRef.setHidden(true);
    vi.advanceTimersByTime(60_000);
    expect(sources[0].closed).toBe(true);
    documentRef.setHidden(false);
    expect(sources).toHaveLength(2);
    stop();
  });

  test('does not spin when a delta request fails', async () => {
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const fetchChanges = vi.fn(async () => ({
      kind: 'unreachable' as const,
      message: 'offline',
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await vi.waitFor(() => {
      expect(stores.audio.getState().stale).toBe(true);
    });
    await Promise.resolve();
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    stop();
  });

  test('retries a failed delta with bounded backoff', async () => {
    vi.useFakeTimers();
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    let calls = 0;
    const fetchChanges = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { kind: 'unreachable' as const, message: 'offline' }
        : {
            kind: 'ok' as const,
            revision: 2,
            upserts: [],
            deletedIds: [],
            resetRequired: false,
          };
    });
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
      retryBaseDelayMs: 100,
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    expect(stores.audio.getState().revision).toBe(2);
    stop();
  });

  test('new filesystem events do not bypass an active failure backoff', async () => {
    vi.useFakeTimers();
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const fetchChanges = vi.fn(async () => ({
      kind: 'unreachable' as const,
      message: 'offline',
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
      retryBaseDelayMs: 100,
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    for (let revision = 3; revision <= 8; revision += 1) {
      source.emit({ revision, affectedTypes: ['audio'], reason: 'watch' });
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    stop();
  });

  test('keeps retrying at the capped interval until delta recovery succeeds', async () => {
    vi.useFakeTimers();
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    let calls = 0;
    const fetchChanges = vi.fn(async () => {
      calls += 1;
      return calls < 4
        ? { kind: 'unreachable' as const, message: 'offline' }
        : {
            kind: 'ok' as const,
            revision: 2,
            upserts: [],
            deletedIds: [],
            resetRequired: false,
          };
    });
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
      retryBaseDelayMs: 100,
      retryMaxAttempts: 2,
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchChanges).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchChanges).toHaveBeenCalledTimes(4);
    expect(stores.audio.getState().revision).toBe(2);
    stop();
  });

  test('suspends a scheduled retry while hidden and resumes on visibility', async () => {
    vi.useFakeTimers();
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => ({ kind: 'ok', revision: 1, items: [] }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const documentRef = new FakeDocument();
    let calls = 0;
    const fetchChanges = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { kind: 'unreachable' as const, message: 'offline' }
        : {
            kind: 'ok' as const,
            revision: 2,
            upserts: [],
            deletedIds: [],
            resetRequired: false,
          };
    });
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef,
      retryBaseDelayMs: 100,
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    documentRef.setHidden(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchChanges).toHaveBeenCalledTimes(1);

    documentRef.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    expect(stores.audio.getState().revision).toBe(2);
    stop();
  });

  test('catches up when an event arrives during initial loading', async () => {
    let resolveLoad!: (value: LibraryFetchResult) => void;
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: () =>
          new Promise<LibraryFetchResult>((resolve) => {
            resolveLoad = resolve;
          }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    const loading = stores.audio.getState().load();
    const source = new FakeEventSource();
    const fetchChanges = vi.fn(async () => ({
      kind: 'ok' as const,
      revision: 2,
      upserts: [],
      deletedIds: [],
      resetRequired: false,
    }));
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({ revision: 2, affectedTypes: ['audio'], reason: 'watch' });
    resolveLoad({ kind: 'ok', revision: 1, items: [] });
    await loading;
    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(2);
    });
    expect(fetchChanges).toHaveBeenCalledWith(
      'audio',
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    stop();
  });

  test('reloads once when a reconnected server has a lower revision', async () => {
    let loads = 0;
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => {
          loads += 1;
          return {
            kind: 'ok',
            revision: loads === 1 ? 9 : 2,
            items: [],
          };
        },
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    const stop = startLibraryLiveSync({
      stores,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({
      revision: 2,
      affectedTypes: ['audio'],
      reason: 'connected',
    });

    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(2);
    });
    expect(loads).toBe(2);
    stop();
  });

  test('discards an in-flight delta from the server before a revision reset', async () => {
    let loads = 0;
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => {
          loads += 1;
          return {
            kind: 'ok',
            revision: loads === 1 ? 9 : 2,
            items: [],
          };
        },
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    let releaseDelta!: () => void;
    const pendingDelta = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const fetchChanges = vi.fn(async () => {
      await pendingDelta;
      return {
        kind: 'ok' as const,
        revision: 10,
        upserts: [
          {
            id: 'old-server-item',
            type: 'audio' as const,
            rootName: 'music',
            relativePath: 'old.mp3',
            name: 'old.mp3',
            sizeBytes: 1,
            modifiedAt: '2026-06-11T00:00:00Z',
          },
        ],
        deletedIds: [],
        resetRequired: false,
      };
    });
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({ revision: 10, affectedTypes: ['audio'], reason: 'watch' });
    await vi.waitFor(() => {
      expect(fetchChanges).toHaveBeenCalledTimes(1);
    });
    source.emit({
      revision: 2,
      affectedTypes: ['audio'],
      reason: 'connected',
    });
    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(2);
    });
    releaseDelta();
    await Promise.resolve();

    const result = stores.audio.getState().result;
    expect(stores.audio.getState().revision).toBe(2);
    expect(
      result?.kind === 'ok'
        ? result.items.some((item) => item.id === 'old-server-item')
        : false,
    ).toBe(false);
    stop();
  });

  test('catches up an event received while an old-epoch request exits', async () => {
    let loads = 0;
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: async () => {
          loads += 1;
          return {
            kind: 'ok',
            revision: loads === 1 ? 9 : 2,
            items: [],
          };
        },
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };
    await stores.audio.getState().load();
    const source = new FakeEventSource();
    let releaseOldDelta!: () => void;
    const oldDelta = new Promise<void>((resolve) => {
      releaseOldDelta = resolve;
    });
    let calls = 0;
    const fetchChanges = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await oldDelta;
        return {
          kind: 'ok' as const,
          revision: 10,
          upserts: [],
          deletedIds: [],
          resetRequired: false,
        };
      }
      return {
        kind: 'ok' as const,
        revision: 3,
        upserts: [],
        deletedIds: [],
        resetRequired: false,
      };
    });
    const stop = startLibraryLiveSync({
      stores,
      fetchChanges,
      eventSourceFactory: () => source,
      documentRef: new FakeDocument(),
    });

    source.emit({ revision: 10, affectedTypes: ['audio'], reason: 'watch' });
    await vi.waitFor(() => {
      expect(fetchChanges).toHaveBeenCalledTimes(1);
    });
    source.emit({
      revision: 2,
      affectedTypes: ['audio'],
      reason: 'connected',
    });
    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(2);
    });
    source.emit({ revision: 3, affectedTypes: ['audio'], reason: 'watch' });
    releaseOldDelta();

    await vi.waitFor(() => {
      expect(stores.audio.getState().revision).toBe(3);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    stop();
  });
});
