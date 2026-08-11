import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  PlaybackEngine,
  EngineEvent,
  EngineListener,
  MediaElementLike,
} from '../../core/playback/engine/engine';
import type {
  PlaybackSession,
  PlaybackState,
  SessionListener,
} from '../../core/playback/session/session';
import type { PlaybackNetworkGate } from '../../core/playback/networkGate/playbackNetworkGate';
import type { PlaybackSource } from '../../core/playback/source/source';
import type {
  PlaybackActivityRecord,
  PlaybackActivityRepository,
  PlaybackActivitySource,
} from '../../core/storage/playbackActivityRepository';
import type {
  ProgressRecord,
  ProgressRepository,
} from '../../core/storage/progressRepository';
import { createProgressService } from '../progress/progressService';
import { createPlayerStore, selectActiveState } from './playerStore';

beforeEach(() => {
  window.localStorage.clear();
});

function fakeElement(): MediaElementLike {
  return {
    src: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    load: vi.fn(),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function fakeEngine(): PlaybackEngine {
  let listener: EngineListener | null = null;
  return {
    get currentSource() {
      return null;
    },
    load: vi.fn(),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    seek: vi.fn(),
    release: vi.fn(),
    subscribe: (l: EngineListener) => {
      listener = l;
      return () => {
        if (listener === l) listener = null;
      };
    },
  };
}

function fakeNetworkGate(): PlaybackNetworkGate & {
  calls: {
    beginAudioStartup: ReturnType<typeof vi.fn<(sourceId: string) => void>>;
    beginAudioSeek: ReturnType<
      typeof vi.fn<(sourceId: string, targetSec: number) => void>
    >;
    closeStartup: ReturnType<typeof vi.fn>;
    closeSeek: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    beginAudioStartup: vi.fn<(sourceId: string) => void>(),
    beginAudioSeek: vi.fn<(sourceId: string, targetSec: number) => void>(),
    closeStartup: vi.fn(),
    closeSeek: vi.fn(),
  };
  return {
    beginAudioStartup(sourceId) {
      calls.beginAudioStartup(sourceId);
      return calls.closeStartup;
    },
    beginAudioSeek(sourceId, targetSec) {
      calls.beginAudioSeek(sourceId, targetSec);
      return calls.closeSeek;
    },
    shouldDefer: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
    calls,
  };
}

function memoryProgressRepository(): ProgressRepository {
  const data = new Map<string, ProgressRecord>();
  return {
    read: (id) => data.get(id) ?? null,
    write: (id, record) => {
      data.set(id, record);
    },
    clear: (id) => {
      data.delete(id);
    },
    entries: () => Array.from(data.entries()),
    mostRecent: () => {
      let best: { mediaId: string; record: ProgressRecord } | null = null;
      let bestStamp = Number.NEGATIVE_INFINITY;
      for (const [mediaId, record] of data) {
        const stamp = Date.parse(record.lastPlayedAt);
        if (Number.isFinite(stamp) && stamp > bestStamp) {
          bestStamp = stamp;
          best = { mediaId, record };
        }
      }
      return best;
    },
  };
}

function makeFakeSession(): PlaybackSession & {
  emit: () => void;
  setState: (s: PlaybackState) => void;
  calls: {
    load: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    seek: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
} {
  let state: PlaybackState = {
    status: { kind: 'idle' },
    source: null,
    positionSec: 0,
    durationSec: 0,
  };
  const listeners = new Set<SessionListener>();
  const calls = {
    load: vi.fn((source: PlaybackSource) => {
      state = {
        status: { kind: 'loading' },
        source,
        positionSec: 0,
        durationSec:
          typeof source.durationSec === 'number' &&
          Number.isFinite(source.durationSec) &&
          source.durationSec > 0
            ? source.durationSec
            : 0,
      };
      for (const l of [...listeners]) l(state);
    }),
    play: vi.fn(async () => {
      state = { ...state, status: { kind: 'playing' } };
      for (const l of [...listeners]) l(state);
    }),
    pause: vi.fn(() => {
      state = { ...state, status: { kind: 'paused' } };
      for (const l of [...listeners]) l(state);
    }),
    seek: vi.fn((positionSec: number) => {
      state = { ...state, positionSec };
      for (const l of [...listeners]) l(state);
    }),
    dispose: vi.fn(),
  };
  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    load: calls.load,
    play: calls.play,
    pause: calls.pause,
    seek: calls.seek,
    dispose: calls.dispose,
    emit: () => {
      for (const l of [...listeners]) l(state);
    },
    setState: (next) => {
      state = next;
      for (const l of [...listeners]) l(state);
    },
    calls,
  };
}

const audioSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'a1',
  mediaType: 'audio',
  url: '/api/media/a1',
  name: 'song.mp3',
};

const videoSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'v1',
  mediaType: 'video',
  url: '/api/media/v1',
  name: 'clip.mp4',
};

describe('createPlayerStore initial state', () => {
  test('starts idle on both kinds with no active', () => {
    const store = createPlayerStore();
    const s = store.getState();
    expect(s.audio.source).toBeNull();
    expect(s.video.source).toBeNull();
    expect(s.active).toBeNull();
  });
});

describe('attachElement', () => {
  test('wires a session backed by the supplied element', () => {
    const calls: Array<MediaElementLike> = [];
    const store = createPlayerStore({
      createEngine: (el) => {
        calls.push(el);
        return fakeEngine();
      },
    });
    const element = fakeElement();
    store.getState().attachElement('audio', element);
    expect(calls).toEqual([element]);
  });

  test('a second attach on the same kind disposes the prior session', () => {
    const sessions = [makeFakeSession(), makeFakeSession()];
    let i = 0;
    const store = createPlayerStore({
      createSession: () => sessions[i++],
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());
    store.getState().attachElement('audio', fakeElement());
    expect(sessions[0].calls.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('attachEngine', () => {
  test('wires the supplied engine without invoking the HTML engine factory', () => {
    const createEngine = vi.fn(() => fakeEngine());
    const session = makeFakeSession();
    const engine = fakeEngine();
    const store = createPlayerStore({
      createEngine,
      createSession: () => session,
    });

    store.getState().attachEngine('video', engine, {
      isConnected: true,
      volume: 1,
      muted: false,
    });

    expect(createEngine).not.toHaveBeenCalled();
    expect(store.getState().video.status.kind).toBe('idle');
  });

  test('drains a queued video request after the engine attaches', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
    });

    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'v1',
      mediaType: 'video',
      url: '/api/media/v1',
      name: 'clip.mp4',
    });
    store.getState().attachEngine('video', fakeEngine(), {
      isConnected: true,
      volume: 1,
      muted: false,
    });

    expect(session.calls.load).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'v1' }),
    );
    expect(session.calls.play).toHaveBeenCalledOnce();
  });
});

describe('detachElement', () => {
  test('disposes the session and resets the slot', () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());
    store.getState().detachElement('audio');
    expect(session.calls.dispose).toHaveBeenCalledTimes(1);
  });

  test('skips detach when expectedElement does not match the current slot', () => {
    const sessions = [makeFakeSession(), makeFakeSession()];
    let i = 0;
    const store = createPlayerStore({
      createSession: () => sessions[i++],
      createEngine: () => fakeEngine(),
    });
    const first = fakeElement();
    const second = fakeElement();
    store.getState().attachElement('audio', first);
    store.getState().attachElement('audio', second);

    // The cleanup from the first mount fires after the second mount has
    // replaced the wiring. Passing the original element guards against
    // tearing down the live slot.
    store.getState().detachElement('audio', first);
    expect(sessions[1].calls.dispose).not.toHaveBeenCalled();
  });

  test('runs the detach when expectedElement matches the current slot', () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    // Use a real DOM element so the deferred-detach guard sees a true
    // unmount (element removed from the document) rather than a
    // StrictMode remount (still connected).
    const node = document.createElement('audio');
    document.body.appendChild(node);
    store
      .getState()
      .attachElement('audio', node as unknown as MediaElementLike);
    node.remove();
    store
      .getState()
      .detachElement('audio', node as unknown as MediaElementLike);
    expect(session.calls.dispose).toHaveBeenCalledTimes(1);
  });

  test('skips detach when the expected element is still in the DOM (StrictMode microtask race)', () => {
    // Reproduces the audio-not-playing bug: VideoMount/AudioMount cleanup
    // queues a microtask detach. React StrictMode runs the cleanup, then
    // synchronously remounts the same element (idempotent attach). When
    // the microtask finally runs, the slot still references this element
    // -- but the element is also still in the DOM, which is the signal
    // that this is a remount, not a real unmount. The deferred detach
    // must skip in that case so the second-mount session survives.
    const sessions: ReturnType<typeof makeFakeSession>[] = [];
    const store = createPlayerStore({
      createSession: () => {
        const next = makeFakeSession();
        sessions.push(next);
        return next;
      },
      createEngine: () => fakeEngine(),
    });

    const node = document.createElement('audio');
    document.body.appendChild(node);
    store
      .getState()
      .attachElement('audio', node as unknown as MediaElementLike);

    // The microtask runs while the element is still connected to the DOM
    // (StrictMode would have already remounted by this point in real React).
    store
      .getState()
      .detachElement('audio', node as unknown as MediaElementLike);
    expect(sessions[0].calls.dispose).not.toHaveBeenCalled();

    // A genuine unmount removes the node from the DOM first, and then the
    // detach proceeds.
    node.remove();
    store
      .getState()
      .detachElement('audio', node as unknown as MediaElementLike);
    expect(sessions[0].calls.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('playSource', () => {
  test('queues a pending source when the requested kind has no element', async () => {
    const store = createPlayerStore({
      createSession: () => makeFakeSession(),
      createEngine: () => fakeEngine(),
    });
    await store.getState().playSource(audioSource);
    // Active is recorded immediately so the mini player can react, even
    // though no element is wired yet.
    expect(store.getState().active).toBe('audio');
  });

  test('a queued pending source plays as soon as the element attaches', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    await store.getState().playSource(videoSource);
    expect(session.calls.load).not.toHaveBeenCalled();

    store.getState().attachElement('video', fakeElement());

    expect(session.calls.load).toHaveBeenCalledWith(videoSource);
    expect(session.calls.play).toHaveBeenCalled();
  });

  test('detached element causes playSource to queue, not load on the dead engine', async () => {
    // Mirrors the real bug: the user plays a video, navigates back, and
    // clicks a second video. The slot still references the first <video>
    // element, but that node was removed from the DOM. The store must
    // detect the disconnected element, drop the stale wiring, and queue
    // the second source so the next attachElement starts it.
    const sessions: ReturnType<typeof makeFakeSession>[] = [];
    const store = createPlayerStore({
      createSession: () => {
        const next = makeFakeSession();
        sessions.push(next);
        return next;
      },
      createEngine: () => fakeEngine(),
    });

    // Use a real DOM element so isConnected reflects DOM state honestly.
    // jsdom's HTMLMediaElement load/play stubs come from src/test/setup.ts.
    const node = document.createElement('video');
    document.body.appendChild(node);
    store
      .getState()
      .attachElement('video', node as unknown as MediaElementLike);
    await store.getState().playSource(videoSource);
    expect(sessions[0].calls.load).toHaveBeenCalledWith(videoSource);

    // Simulate the user navigating away from /player: React removes the
    // <video> node from the DOM but our store keeps the slot wired.
    node.remove();

    const secondSource: PlaybackSource = {
      ...videoSource,
      mediaId: 'v2',
      url: '/api/media/v2',
      name: 'second.mp4',
    };
    await store.getState().playSource(secondSource);

    // The second click must not load on the dead session.
    expect(sessions[0].calls.load).toHaveBeenCalledTimes(1);

    // The next mount drains the queued source.
    const node2 = document.createElement('video');
    document.body.appendChild(node2);
    store
      .getState()
      .attachElement('video', node2 as unknown as MediaElementLike);
    expect(sessions.length).toBeGreaterThan(1);
    const latest = sessions[sessions.length - 1];
    expect(latest.calls.load).toHaveBeenCalledWith(secondSource);
    expect(latest.calls.play).toHaveBeenCalled();
  });

  test('loads the source on the matching session and marks it active', async () => {
    const audioSession = makeFakeSession();
    const videoSession = makeFakeSession();
    let next: 'audio' | 'video' = 'audio';
    const store = createPlayerStore({
      createSession: () => (next === 'audio' ? audioSession : videoSession),
      createEngine: () => fakeEngine(),
    });
    next = 'audio';
    store.getState().attachElement('audio', fakeElement());
    next = 'video';
    store.getState().attachElement('video', fakeElement());

    await store.getState().playSource(audioSource);

    expect(audioSession.calls.load).toHaveBeenCalledWith(audioSource);
    expect(audioSession.calls.play).toHaveBeenCalled();
    expect(videoSession.calls.load).not.toHaveBeenCalled();
    expect(store.getState().active).toBe('audio');
  });

  test('opens the network gate for audio startup only', async () => {
    const audioSession = makeFakeSession();
    const videoSession = makeFakeSession();
    const networkGate = fakeNetworkGate();
    let next: 'audio' | 'video' = 'audio';
    const store = createPlayerStore({
      createSession: () => (next === 'audio' ? audioSession : videoSession),
      createEngine: () => fakeEngine(),
      networkGate,
    });
    next = 'audio';
    store.getState().attachElement('audio', fakeElement());
    next = 'video';
    store.getState().attachElement('video', fakeElement());

    await store.getState().playSource(audioSource);
    await store.getState().playSource(videoSource);

    expect(networkGate.calls.beginAudioStartup).toHaveBeenCalledTimes(1);
    expect(networkGate.calls.beginAudioStartup).toHaveBeenCalledWith('a1');
    expect(networkGate.calls.closeStartup).toHaveBeenCalledTimes(1);
  });

  test('reselecting the active audio source does not reload the element', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());

    await store.getState().playSource(audioSource);
    await store.getState().playSource({
      ...audioSource,
      url: '/api/media/a1#t=120',
    });

    expect(session.calls.load).toHaveBeenCalledTimes(1);
    expect(session.calls.play).toHaveBeenCalledTimes(2);
  });

  test('reselecting an active video source still follows the video load path', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('video', fakeElement());

    await store.getState().playSource(videoSource);
    await store.getState().playSource(videoSource);

    expect(session.calls.load).toHaveBeenCalledTimes(2);
  });

  test('pauses the other kind so the two sessions never play together', async () => {
    const audioSession = makeFakeSession();
    const videoSession = makeFakeSession();
    let next: 'audio' | 'video' = 'audio';
    const store = createPlayerStore({
      createSession: () => (next === 'audio' ? audioSession : videoSession),
      createEngine: () => fakeEngine(),
    });
    next = 'audio';
    store.getState().attachElement('audio', fakeElement());
    next = 'video';
    store.getState().attachElement('video', fakeElement());

    await store.getState().playSource(audioSource);
    await store.getState().playSource(videoSource);

    expect(audioSession.calls.pause).toHaveBeenCalled();
    expect(store.getState().active).toBe('video');
  });

  test('flushes video progress before replacing the current video source', async () => {
    let nowMs = 0;
    const repo = memoryProgressRepository();
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      progressService: createProgressService(repo, {
        now: () => nowMs,
        throttleMs: 60_000,
      }),
    });
    const firstVideo: PlaybackSource = {
      ...videoSource,
      rootName: 'videos',
      relativePath: 'clips/clip.mp4',
    };
    const secondVideo: PlaybackSource = {
      ...videoSource,
      mediaId: 'v2',
      url: '/api/media/v2',
      name: 'next.mp4',
      rootName: 'videos',
      relativePath: 'clips/next.mp4',
    };
    store.getState().attachElement('video', fakeElement());

    await store.getState().playSource(firstVideo);
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 10,
      durationSec: 100,
    });
    expect(repo.read('v1')?.positionSec).toBe(10);

    nowMs += 1_000;
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 45,
      durationSec: 100,
    });
    expect(repo.read('v1')?.positionSec).toBe(10);

    await store.getState().playSource(secondVideo);

    expect(repo.read('v1')).toMatchObject({
      positionSec: 45,
      durationSec: 100,
      source: {
        mediaType: 'video',
        name: 'clip.mp4',
        rootName: 'videos',
        relativePath: 'clips/clip.mp4',
      },
    });
    expect(session.calls.load).toHaveBeenLastCalledWith(secondVideo);
  });

  test('keeps video time visible in the mini player state after Vidstack detaches', async () => {
    let nowMs = 0;
    const repo = memoryProgressRepository();
    const session = makeFakeSession();
    const engine = fakeEngine();
    const target = { isConnected: true, volume: 1, muted: false };
    const store = createPlayerStore({
      createSession: () => session,
      progressService: createProgressService(repo, {
        now: () => nowMs,
        throttleMs: 60_000,
      }),
    });
    const source: PlaybackSource = {
      ...videoSource,
      durationSec: 1_800,
      rootName: 'videos',
      relativePath: 'clips/clip.mp4',
    };

    store.getState().attachEngine('video', engine, target);
    await store.getState().playSource(source);
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 600,
      durationSec: 1_800,
    });
    nowMs += 1_000;
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 900,
      durationSec: 1_800,
    });
    expect(repo.read('v1')?.positionSec).toBe(600);

    target.isConnected = false;
    store.getState().detachEngine('video', engine);

    expect(store.getState().active).toBe('video');
    expect(store.getState().video).toMatchObject({
      source,
      positionSec: 900,
      durationSec: 1_800,
    });
    expect(repo.read('v1')).toMatchObject({
      positionSec: 900,
      durationSec: 1_800,
    });
  });

  test('keeps a clicked video active while music is paused before video mount', async () => {
    const audioSession = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => audioSession,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());

    await store.getState().playSource(audioSource);
    await store.getState().playSource(videoSource);

    expect(audioSession.calls.pause).toHaveBeenCalled();
    expect(store.getState().active).toBe('video');
    expect(store.getState().video.source).toEqual(videoSource);
    expect(selectActiveState(store.getState()).source).toEqual(videoSource);

    // A late paused event from the audio element must not steal the full
    // player focus back from the pending video request.
    audioSession.emit();
    expect(store.getState().active).toBe('video');
    expect(selectActiveState(store.getState()).source).toEqual(videoSource);
  });
});

describe('playMusicQueue', () => {
  test('loads the selected track and stores the queue', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());

    const secondSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a2',
      url: '/api/media/a2',
      name: 'second.mp3',
    };
    await store.getState().playMusicQueue([audioSource, secondSource], 'a2');

    expect(session.calls.load).toHaveBeenCalledWith(secondSource);
    expect(store.getState().musicQueue.map((track) => track.mediaId)).toEqual([
      'a1',
      'a2',
    ]);
    expect(store.getState().musicQueueIndex).toBe(1);
    expect(store.getState().recentlyPlayed[0].mediaId).toBe('a2');
  });

  test('preserves exact order for a 15,000 item queue', async () => {
    const store = createPlayerStore();
    const sources = Array.from({ length: 15_000 }, (_, index) => ({
      ...audioSource,
      mediaId: `audio-${index}`,
      url: `/api/media/audio-${index}`,
      name: `audio-${index}.mp3`,
    }));

    await store.getState().playMusicQueue(sources, 'audio-7500');

    expect(store.getState().musicQueueIndex).toBe(7500);
    expect(store.getState().musicQueue.map((source) => source.mediaId)).toEqual(
      sources.map((source) => source.mediaId),
    );
  });

  test('advances to the next queue track when audio ends', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const secondSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a2',
      url: '/api/media/a2',
      name: 'second.mp3',
    };
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playMusicQueue([audioSource, secondSource], 'a1');

    session.setState({
      ...session.getState(),
      status: { kind: 'ended' },
    });
    await Promise.resolve();

    expect(store.getState().musicQueueIndex).toBe(1);
    expect(session.calls.load).toHaveBeenLastCalledWith(secondSource);
  });

  test('repeat one reloads the current queue track on end but manual next advances', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const secondSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a2',
      url: '/api/media/a2',
      name: 'second.mp3',
    };
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playMusicQueue([audioSource, secondSource], 'a1');
    store.getState().cycleRepeatMode();
    store.getState().cycleRepeatMode();

    session.setState({
      ...session.getState(),
      status: { kind: 'ended' },
    });
    await Promise.resolve();

    expect(store.getState().repeatMode).toBe('one');
    expect(session.calls.load).toHaveBeenCalledTimes(2);
    expect(session.calls.load).toHaveBeenLastCalledWith(audioSource);

    await store.getState().playNextQueueItem();

    expect(store.getState().musicQueueIndex).toBe(1);
    expect(session.calls.load).toHaveBeenLastCalledWith(secondSource);
  });

  test('shuffle uses a copied queue and restores the original order when disabled', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      random: () => 0,
    });
    const secondSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a2',
      url: '/api/media/a2',
      name: 'second.mp3',
    };
    const thirdSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a3',
      url: '/api/media/a3',
      name: 'third.mp3',
    };
    const fourthSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a4',
      url: '/api/media/a4',
      name: 'fourth.mp3',
    };
    store.getState().attachElement('audio', fakeElement());
    await store
      .getState()
      .playMusicQueue([audioSource, secondSource, thirdSource, fourthSource], 'a1');

    store.getState().toggleShuffle();

    expect(store.getState().shuffle).toBe(true);
    expect(store.getState().musicQueue.map((track) => track.mediaId)).toEqual([
      'a1',
      'a3',
      'a4',
      'a2',
    ]);

    store.getState().toggleShuffle();

    expect(store.getState().shuffle).toBe(false);
    expect(store.getState().musicQueue.map((track) => track.mediaId)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
    ]);
    expect(store.getState().musicQueueIndex).toBe(0);
  });

  test('queue item controls play, move, and remove tracks', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const secondSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a2',
      url: '/api/media/a2',
      name: 'second.mp3',
    };
    const thirdSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a3',
      url: '/api/media/a3',
      name: 'third.mp3',
    };
    store.getState().attachElement('audio', fakeElement());
    await store
      .getState()
      .playMusicQueue([audioSource, secondSource, thirdSource], 'a1');

    store.getState().playQueueItemNext('a3');
    expect(store.getState().musicQueue.map((track) => track.mediaId)).toEqual([
      'a1',
      'a3',
      'a2',
    ]);
    store.getState().moveQueueItem('a2', 'up');
    await store.getState().playQueueItem('a2');
    store.getState().removeQueueItem('a1');
    store.getState().clearMusicQueue();

    expect(store.getState().musicQueue.map((track) => track.mediaId)).toEqual([
      'a2',
    ]);
    expect(store.getState().musicQueueIndex).toBe(0);
    expect(session.calls.load).toHaveBeenLastCalledWith(secondSource);
  });

  test('manual previous and next controls play adjacent queue tracks', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const secondSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a2',
      url: '/api/media/a2',
      name: 'second.mp3',
    };
    const thirdSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'a3',
      url: '/api/media/a3',
      name: 'third.mp3',
    };
    store.getState().attachElement('audio', fakeElement());
    await store
      .getState()
      .playMusicQueue([audioSource, secondSource, thirdSource], 'a2');

    await store.getState().playNextQueueItem();
    expect(store.getState().musicQueueIndex).toBe(2);
    expect(session.calls.load).toHaveBeenLastCalledWith(thirdSource);

    await store.getState().playPreviousQueueItem();
    expect(store.getState().musicQueueIndex).toBe(1);
    expect(session.calls.load).toHaveBeenLastCalledWith(secondSource);

    store.getState().cycleRepeatMode();
    await store.getState().playNextQueueItem();
    await store.getState().playNextQueueItem();
    expect(store.getState().musicQueueIndex).toBe(0);
    expect(session.calls.load).toHaveBeenLastCalledWith(audioSource);
  });
});

describe('playback activity', () => {
  test('records audio play and progress by content identity key', async () => {
    let records: PlaybackActivityRecord[] = [];
    let lastPositionSec = 0;
    let durationSec = 0;
    const activityRepository: PlaybackActivityRepository = {
      list: () => records,
      recordPlay: (source: PlaybackActivitySource) => {
        records = [
          {
            ...source,
            playCount: 1,
            lastPlayedAt: '2026-06-01T00:00:00.000Z',
            lastPositionSec: 0,
            durationSec: 0,
            completed: false,
            events: [],
          },
        ];
        return records;
      },
      updateProgress: (source, patch) => {
        lastPositionSec = patch.positionSec;
        durationSec = patch.durationSec;
        records = [
          {
            ...source,
            playCount: records[0]?.playCount ?? 0,
            lastPlayedAt: records[0]?.lastPlayedAt ?? null,
            lastPositionSec: patch.positionSec,
            durationSec: patch.durationSec,
            completed: patch.completed,
            events: [],
          },
        ];
        return false;
      },
      exportData: () => ({ version: 1, records }),
      importData: (data) => {
        records = (data as { records?: PlaybackActivityRecord[] }).records ?? [];
        return records;
      },
    };
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      activityRepository,
    });
    store.getState().attachElement('audio', fakeElement());

    await store.getState().playSource(audioSource);
    session.setState({
      ...session.getState(),
      positionSec: 30,
      durationSec: 100,
    });

    expect(store.getState().activityRecords[0]).toMatchObject({
      contentKey: 'audio:title:song',
      playCount: 1,
    });
    expect(lastPositionSec).toBe(30);
    expect(durationSec).toBe(100);
  });

  test('records video play for Recently Watching', async () => {
    const recordPlay = vi.fn(() => []);
    const store = createPlayerStore({
      activityRepository: {
        list: () => [],
        recordPlay,
        updateProgress: () => false,
        exportData: () => ({ version: 1, records: [] }),
        importData: () => [],
      },
    });

    await store.getState().playSource(videoSource);

    expect(recordPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId: 'v1',
        mediaType: 'video',
      }),
      expect.any(Number),
    );
  });

  test('throttles position writes without replacing activityRecords', async () => {
    let nowMs = 1_000;
    const initialRecords: PlaybackActivityRecord[] = [];
    const playedRecords: PlaybackActivityRecord[] = [
      {
        ...activitySourceFromTestSource(audioSource),
        playCount: 1,
        lastPlayedAt: '2026-06-12T00:00:00.000Z',
        lastPositionSec: 0,
        durationSec: 0,
        completed: false,
        events: [],
      },
    ];
    const updateProgress = vi.fn(() => false);
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      now: () => nowMs,
      activityProgressThrottleMs: 10_000,
      activityRepository: {
        list: () => initialRecords,
        recordPlay: () => playedRecords,
        updateProgress,
        exportData: () => ({ version: 1, records: playedRecords }),
        importData: () => playedRecords,
      },
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    const activityRecords = store.getState().activityRecords;

    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 5,
      durationSec: 100,
    });
    nowMs += 1_000;
    session.setState({
      ...session.getState(),
      positionSec: 6,
    });
    nowMs += 9_000;
    session.setState({
      ...session.getState(),
      positionSec: 15,
    });

    expect(updateProgress).toHaveBeenCalledTimes(2);
    expect(store.getState().activityRecords).toBe(activityRecords);

    nowMs += 1;
    session.setState({
      ...session.getState(),
      status: { kind: 'paused' },
      positionSec: 16,
    });
    expect(updateProgress).toHaveBeenCalledTimes(3);
  });

  test('flushes throttled activity on demand before unload', async () => {
    let nowMs = 1_000;
    const updateProgress = vi.fn(() => false);
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      now: () => nowMs,
      activityProgressThrottleMs: 10_000,
      activityRepository: {
        list: () => [],
        recordPlay: () => [],
        updateProgress,
        exportData: () => ({ version: 1, records: [] }),
        importData: () => [],
      },
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 5,
      durationSec: 100,
    });
    nowMs += 1_000;
    session.setState({
      ...session.getState(),
      positionSec: 6,
    });
    expect(updateProgress).toHaveBeenCalledTimes(1);

    store.getState().flushActivity();

    expect(updateProgress).toHaveBeenCalledTimes(2);
    expect(updateProgress).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ positionSec: 6 }),
    );
  });

  test('imports and exports activity JSON', () => {
    const imported: PlaybackActivityRecord = {
      contentKey: 'audio:title:imported',
      mediaId: 'a2',
      mediaType: 'audio',
      name: 'imported.mp3',
      artist: null,
      playCount: 2,
      lastPlayedAt: null,
      lastPositionSec: 0,
      durationSec: 0,
      completed: false,
      events: [],
    };
    const store = createPlayerStore({
      activityRepository: {
        list: () => [],
        recordPlay: () => [],
        updateProgress: () => false,
        exportData: () => ({ version: 1, records: [imported] }),
        importData: () => [imported],
      },
    });

    expect(store.getState().importPlaybackActivity('{"version":1,"records":[]}')).toBe(true);
    expect(store.getState().activityRecords).toEqual([imported]);
    expect(store.getState().exportPlaybackActivity()).toContain('imported.mp3');
  });
});

describe('audio resume cache', () => {
  test('requests preparation only after an audio track reaches 30 seconds', async () => {
    const session = makeFakeSession();
    const prepare = vi.fn();
    const resolve = vi.fn((source: PlaybackSource) => source);
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      audioResumeCache: {
        initialize: async () => {},
        prepare,
        resolve,
      },
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource({ ...audioSource, name: 'long.aac' });

    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 29.9,
      durationSec: 300,
    });
    expect(prepare).not.toHaveBeenCalled();

    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 30,
      durationSec: 300,
    });
    expect(prepare).toHaveBeenCalledWith('a1');
  });

  test('does not request remux caching for non-AAC audio', async () => {
    const session = makeFakeSession();
    const prepare = vi.fn();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      audioResumeCache: {
        initialize: async () => {},
        prepare,
        resolve: (source) => source,
      },
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 60,
      durationSec: 300,
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('video optimization', () => {
  test('resolves a known ready sidecar before loading the video session', async () => {
    const session = makeFakeSession();
    const resolve = vi.fn((source: PlaybackSource) => ({
      ...source,
      url: '/api/video-optimization/media/v1?v=key#t=45',
      mimeType: 'video/mp4',
    }));
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      videoOptimization: {
        status: async () => null,
        prepare: async () => null,
        cancel: async () => null,
        clear: async () => null,
        invalidate: () => {},
        supportsNativeHLS: () => false,
        preferOriginal: () => {},
        resolve,
      },
    });
    store.getState().attachElement('video', fakeElement());
    await store.getState().playSource({
      kind: 'remote', mediaId: 'v1', mediaType: 'video', name: 'movie.mp4',
      url: '/api/media/v1#t=45', mimeType: 'video/mp4',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(session.getState().source?.url).toBe('/api/video-optimization/media/v1?v=key#t=45');
  });

  test('falls back from a sidecar error to the original once with resume and MOV MIME', async () => {
    const session = makeFakeSession();
    const optimized: PlaybackSource = {
      kind: 'remote', mediaId: 'v1', mediaType: 'video', name: 'movie.mov',
      url: '/api/video-optimization/media/v1?v=key#t=45', mimeType: 'video/mp4',
      optimizationOriginalUrl: '/api/media/v1#t=45',
      optimizationOriginalMimeType: 'video/quicktime',
      optimizationKind: 'faststart-mp4',
    };
    const invalidate = vi.fn();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      videoOptimization: {
        status: async () => null, prepare: async () => null,
        cancel: async () => null, clear: async () => null, invalidate,
        supportsNativeHLS: () => false,
        preferOriginal: () => {}, resolve: () => optimized,
      },
    });
    store.getState().attachElement('video', fakeElement());
    await store.getState().playSource({
      kind: 'remote', mediaId: 'v1', mediaType: 'video', name: 'movie.mov',
      url: '/api/media/v1#t=45', mimeType: 'video/quicktime',
    });
    session.setState({
      status: { kind: 'error', message: 'network error' },
      source: optimized, positionSec: 80.25, durationSec: 120,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getState().source).toMatchObject({
      url: '/api/media/v1#t=80.3',
      mimeType: 'video/quicktime',
    });
    expect(invalidate).toHaveBeenCalledWith('v1', 'faststart-mp4');
    const loadsAfterFallback = session.calls.load.mock.calls.length;
    session.setState({
      ...session.getState(),
      status: { kind: 'error', message: 'source not supported' },
    });
    await Promise.resolve();
    expect(session.calls.load).toHaveBeenCalledTimes(loadsAfterFallback);
  });

  test('falls back from native HLS to direct MP4 once without changing progress identity', async () => {
    const session = makeFakeSession();
    const optimized: PlaybackSource = {
      kind: 'remote', mediaId: 'v1', mediaType: 'video', name: 'movie.mp4',
      url: '/api/video-optimization/hls/v1/0123456789abcdef01234567/index.m3u8#t=45',
      mimeType: 'application/vnd.apple.mpegurl', optimizationKind: 'hls-fmp4',
      optimizationOriginalUrl: '/api/media/v1#t=45',
      optimizationOriginalMimeType: 'video/mp4',
    };
    const invalidate = vi.fn();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      videoOptimization: {
        status: async () => null, prepare: async () => null, cancel: async () => null,
        clear: async () => null, invalidate, supportsNativeHLS: () => true,
        preferOriginal: () => {}, resolve: () => optimized,
      },
    });
    store.getState().attachElement('video', fakeElement());
    await store.getState().playSource({
      kind: 'remote', mediaId: 'v1', mediaType: 'video', name: 'movie.mp4',
      url: '/api/media/v1#t=45', mimeType: 'video/mp4',
    });
    session.setState({
      status: { kind: 'error', message: 'HLS manifest unavailable' },
      source: optimized, positionSec: 90, durationSec: 120,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledWith('v1', 'hls-fmp4');
    expect(session.getState().source).toMatchObject({
      mediaId: 'v1', url: '/api/media/v1#t=90', mimeType: 'video/mp4',
    });
    expect(session.getState().source?.optimizationKind).toBeUndefined();
  });

  test('resolves a ready sidecar before loading a visible seeded resume', async () => {
    const session = makeFakeSession();
    const status = vi.fn(async () => null);
    const resolve = vi.fn((source: PlaybackSource): PlaybackSource => ({
      ...source,
      url: '/api/video-optimization/media/v1?v=key#t=45',
      mimeType: 'video/mp4',
      optimizationOriginalUrl: source.url,
      optimizationOriginalMimeType: 'video/quicktime',
    }));
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      videoOptimization: {
        status, resolve, prepare: async () => null, cancel: async () => null,
        clear: async () => null, invalidate: () => {}, supportsNativeHLS: () => false,
        preferOriginal: () => {},
      },
    });
    const seed: PlaybackSource = {
      kind: 'remote', mediaId: 'v1', mediaType: 'video', name: 'movie.mov',
      url: '/api/media/v1#t=45', mimeType: 'video/quicktime',
    };
    store.getState().seedSource(seed, { positionSec: 45, durationSec: 120 });
    store.getState().attachElement('video', fakeElement());
    store.getState().prepareSeededSource('video');
    expect(session.calls.load).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(status).toHaveBeenCalledWith('v1', true, 'faststart-mp4');
    expect(session.calls.load).toHaveBeenCalledWith(expect.objectContaining({
      url: '/api/video-optimization/media/v1?v=key#t=45',
      mimeType: 'video/mp4',
    }));
    expect(session.calls.seek).toHaveBeenCalledWith(45);
    const optimized = session.calls.load.mock.calls[0]?.[0] as PlaybackSource;
    session.setState({
      status: { kind: 'error', message: 'network error' },
      source: optimized,
      positionSec: 45,
      durationSec: 120,
    });
    expect(session.calls.load).toHaveBeenLastCalledWith(expect.objectContaining({
      url: '/api/media/v1#t=45',
      mimeType: 'video/quicktime',
    }));
    expect(session.calls.play).not.toHaveBeenCalled();
  });
});

function activitySourceFromTestSource(
  source: PlaybackSource,
): PlaybackActivitySource {
  return {
    contentKey: 'audio:title:song',
    mediaId: source.mediaId,
    mediaType: source.mediaType,
    name: source.name,
    artist: null,
  };
}

describe('likes', () => {
  test('loads and persists liked ids', () => {
    const writes: string[][] = [];
    const store = createPlayerStore({
      likedRepository: {
        list: () => ['a1'],
        write: (ids) => writes.push([...ids]),
      },
    });

    expect(store.getState().likedMediaIds).toEqual(['a1']);
    store.getState().toggleLike('a2');

    expect(store.getState().likedMediaIds).toEqual(['a1', 'a2']);
    expect(writes.at(-1)).toEqual(['a1', 'a2']);
  });
});

describe('togglePlayPause', () => {
  test('pauses when active session is playing', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
    });

    await store.getState().togglePlayPause();

    expect(session.calls.pause).toHaveBeenCalledTimes(1);
  });

  test('plays when active session is paused', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    session.setState({ ...session.getState(), status: { kind: 'paused' } });

    await store.getState().togglePlayPause();

    expect(session.calls.play).toHaveBeenCalled();
  });

  test('does nothing when no session is active', async () => {
    const store = createPlayerStore();
    await store.getState().togglePlayPause();
    expect(store.getState().active).toBeNull();
  });
});

describe('seekActive', () => {
  test('forwards to the active session', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    store.getState().seekActive(15);
    expect(session.calls.seek).toHaveBeenCalledWith(15);
  });

  test('is a no-op when nothing is active', () => {
    const store = createPlayerStore();
    expect(() => store.getState().seekActive(5)).not.toThrow();
  });

  test('opens the network gate for audio seek only', async () => {
    const session = makeFakeSession();
    const networkGate = fakeNetworkGate();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      networkGate,
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);

    store.getState().seekActive(1800);
    store.getState().seekActive(Number.NaN);

    expect(networkGate.calls.beginAudioSeek).toHaveBeenCalledTimes(1);
    expect(networkGate.calls.beginAudioSeek).toHaveBeenCalledWith('a1', 1800);
    expect(networkGate.calls.closeSeek).not.toHaveBeenCalled();
  });

  test('keeps the audio seek gate open until a real media timeupdate reaches the target', async () => {
    const session = makeFakeSession();
    const networkGate = fakeNetworkGate();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      networkGate,
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);

    store.getState().seekActive(1800);
    expect(networkGate.calls.closeSeek).not.toHaveBeenCalled();

    session.setState({
      ...session.getState(),
      status: { kind: 'playing' },
      positionSec: 1800,
      mediaPositionUpdateSeq: 1,
    });

    expect(networkGate.calls.closeSeek).toHaveBeenCalledTimes(1);
  });
});

describe('sleep timer', () => {
  test('pauses the active session when the timer expires', async () => {
    const session = makeFakeSession();
    let nowMs = 0;
    const timer = { tick: null as null | (() => void) };
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      now: () => nowMs,
      setInterval: (handler) => {
        timer.tick = handler;
        return 1;
      },
      clearInterval: () => {},
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);

    store.getState().startSleepTimer(1 / 60);
    nowMs = 1000;
    timer.tick?.();

    expect(session.calls.pause).toHaveBeenCalledTimes(1);
    expect(store.getState().sleepTimer).toEqual({ kind: 'expired' });
  });

  test('cancelSleepTimer prevents the expiry pause', async () => {
    const session = makeFakeSession();
    let nowMs = 0;
    const timer = { tick: null as null | (() => void) };
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      now: () => nowMs,
      setInterval: (handler) => {
        timer.tick = handler;
        return 1;
      },
      clearInterval: () => {},
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);

    store.getState().startSleepTimer(1 / 60);
    store.getState().cancelSleepTimer();
    nowMs = 1000;
    timer.tick?.();

    expect(session.calls.pause).not.toHaveBeenCalled();
    expect(store.getState().sleepTimer).toEqual({ kind: 'off' });
  });
});

describe('volume and mute', () => {
  test('applies volume preferences to attached elements', () => {
    const audioElement = fakeElement() as MediaElementLike & {
      volume?: number;
      muted?: boolean;
    };
    const videoElement = fakeElement() as MediaElementLike & {
      volume?: number;
      muted?: boolean;
    };
    const store = createPlayerStore({
      createSession: () => makeFakeSession(),
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', audioElement);
    store.getState().attachElement('video', videoElement);

    store.getState().setVolume(0.4);
    store.getState().toggleMute();

    expect(store.getState().volume).toBe(0.4);
    expect(store.getState().muted).toBe(true);
    expect(audioElement.volume).toBe(0.4);
    expect(videoElement.volume).toBe(0.4);
    expect(audioElement.muted).toBe(true);
    expect(videoElement.muted).toBe(true);
  });

  test('newly attached elements inherit existing volume preferences', () => {
    const element = fakeElement() as MediaElementLike & {
      volume?: number;
      muted?: boolean;
    };
    const store = createPlayerStore({
      createSession: () => makeFakeSession(),
      createEngine: () => fakeEngine(),
    });
    store.getState().setVolume(2);
    store.getState().toggleMute();

    store.getState().attachElement('audio', element);

    expect(element.volume).toBe(1);
    expect(element.muted).toBe(true);
  });
});

describe('seedSource', () => {
  test('hydrates active source artwork without reloading or losing position', () => {
    const session = makeFakeSession();
    session.setState({
      status: { kind: 'paused' },
      source: {
        ...audioSource,
        name: 'Caravan Palace - Suzy.mp3',
        title: undefined,
        artist: undefined,
        album: undefined,
        artworkUrl: undefined,
      },
      positionSec: 64,
      durationSec: 247,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);

    store.getState().updateSourcePresentation({
      ...audioSource,
      name: 'Caravan Palace - Suzy.mp3',
      title: 'Suzy',
      artist: 'Caravan Palace',
      album: 'Caravan Palace',
      artworkUrl: '/api/thumbnails/a1?v=cover&state=ready',
    });

    expect(store.getState().audio).toMatchObject({
      positionSec: 64,
      durationSec: 247,
      source: {
        title: 'Suzy',
        artist: 'Caravan Palace',
        album: 'Caravan Palace',
        artworkUrl: '/api/thumbnails/a1?v=cover&state=ready',
      },
    });
    expect(session.calls.load).not.toHaveBeenCalled();
    expect(session.calls.seek).not.toHaveBeenCalled();
  });

  test('parks a source on the matching slot and marks active without playing', () => {
    const sessions: ReturnType<typeof makeFakeSession>[] = [];
    const store = createPlayerStore({
      createSession: () => {
        const next = makeFakeSession();
        sessions.push(next);
        return next;
      },
      createEngine: () => fakeEngine(),
    });
    store.getState().seedSource(audioSource);

    expect(store.getState().active).toBe('audio');
    expect(store.getState().audio.source).toEqual(audioSource);
    // No session was constructed (parking lot only); no load/play happened.
    expect(sessions).toHaveLength(0);
  });

  test('does not load a seeded source when the element attaches', () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().seedSource(audioSource);
    store.getState().attachElement('audio', fakeElement());

    expect(session.calls.load).not.toHaveBeenCalled();
    expect(session.calls.play).not.toHaveBeenCalled();
    expect(store.getState().audio.source).toEqual(audioSource);
    expect(store.getState().audio.status).toEqual({ kind: 'idle' });
  });

  test('prepares a seeded video source for a visible viewport without playing', () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const resumedVideo: PlaybackSource = {
      ...videoSource,
      url: '/api/media/v1#t=45',
      durationSec: 120,
      rootName: 'videos',
      relativePath: 'clips/clip.mp4',
    };
    store.getState().seedSource(resumedVideo, {
      positionSec: 45,
      durationSec: 120,
    });
    store.getState().attachElement('video', fakeElement());

    expect(session.calls.load).not.toHaveBeenCalled();

    store.getState().prepareSeededSource('video');

    expect(session.calls.load).toHaveBeenCalledWith(resumedVideo);
    expect(session.calls.seek).toHaveBeenCalledWith(45);
    expect(session.calls.play).not.toHaveBeenCalled();
    expect(store.getState().video).toMatchObject({
      source: resumedVideo,
      positionSec: 45,
      durationSec: 120,
    });
  });

  test('first play on a seeded source loads and plays it', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().seedSource(audioSource);
    store.getState().attachElement('audio', fakeElement());

    await store.getState().togglePlayPause();

    expect(session.calls.load).toHaveBeenCalledWith(audioSource);
    expect(session.calls.play).toHaveBeenCalled();
    expect(store.getState().audio.status).toEqual({ kind: 'playing' });
  });

  test('keeps saved video time visible until the seeded video is played', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const resumedVideo: PlaybackSource = {
      ...videoSource,
      url: '/api/media/v1',
      durationSec: 120,
      rootName: 'videos',
      relativePath: 'clips/clip.mp4',
    };
    const expectedVideo: PlaybackSource = {
      ...resumedVideo,
      url: '/api/media/v1#t=45',
    };
    store.getState().seedSource(resumedVideo, {
      positionSec: 45,
      durationSec: 120,
    });

    expect(store.getState().active).toBe('video');
    expect(store.getState().video).toMatchObject({
      source: expectedVideo,
      positionSec: 45,
      durationSec: 120,
      status: { kind: 'idle' },
    });

    store.getState().attachElement('video', fakeElement());
    expect(session.calls.load).not.toHaveBeenCalled();

    await store.getState().togglePlayPause();

    expect(session.calls.load).toHaveBeenCalledWith(expectedVideo);
    expect(session.calls.play).toHaveBeenCalled();
  });

  test('plays a prepared seeded video without reloading it from zero', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const resumedVideo: PlaybackSource = {
      ...videoSource,
      url: '/api/media/v1',
      durationSec: 18_000,
      rootName: 'videos',
      relativePath: 'clips/clip.mp4',
    };
    const expectedVideo: PlaybackSource = {
      ...resumedVideo,
      url: '/api/media/v1#t=14400',
    };
    store.getState().seedSource(resumedVideo, {
      positionSec: 14_400,
      durationSec: 18_000,
    });
    store.getState().attachElement('video', fakeElement());
    store.getState().prepareSeededSource('video');

    expect(session.calls.load).toHaveBeenCalledTimes(1);
    expect(session.calls.load).toHaveBeenCalledWith(expectedVideo);
    expect(session.calls.seek).toHaveBeenCalledWith(14_400);
    expect(store.getState().video.positionSec).toBe(14_400);

    await store.getState().togglePlayPause();

    expect(session.calls.load).toHaveBeenCalledTimes(1);
    expect(session.calls.play).toHaveBeenCalledTimes(1);
    expect(store.getState().video.source).toEqual(expectedVideo);
    expect(store.getState().video.positionSec).toBe(14_400);
  });

  test('does not save prepared seeded video progress before first play', async () => {
    const session = makeFakeSession();
    const progressRepository = memoryProgressRepository();
    const updateProgress = vi.fn(
      (
        _source: PlaybackActivitySource,
        _patch: Parameters<PlaybackActivityRepository['updateProgress']>[1],
      ) => false,
    );
    const recordPlay = vi.fn(() => []);
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
      progressService: createProgressService(progressRepository, {
        now: () => Date.parse('2026-07-04T00:00:00.000Z'),
      }),
      activityRepository: {
        list: () => [],
        recordPlay,
        updateProgress,
        exportData: () => ({ version: 1, records: [] }),
        importData: () => [],
      },
    });
    const resumedVideo: PlaybackSource = {
      ...videoSource,
      url: '/api/media/v1',
      durationSec: 18_000,
      rootName: 'videos',
      relativePath: 'clips/clip.mp4',
    };
    const nextVideo: PlaybackSource = {
      ...videoSource,
      mediaId: 'v2',
      url: '/api/media/v2',
      name: 'next.mp4',
      durationSec: 120,
    };

    store.getState().seedSource(resumedVideo, {
      positionSec: 14_400,
      durationSec: 18_000,
    });
    store.getState().attachElement('video', fakeElement());
    store.getState().prepareSeededSource('video');
    store.getState().detachElement('video');
    store.getState().attachElement('video', fakeElement());

    expect(progressRepository.read('v1')).toBeNull();
    expect(
      updateProgress.mock.calls.some(([source]) => source.mediaId === 'v1'),
    ).toBe(false);

    await store.getState().playSource(nextVideo);

    expect(progressRepository.read('v1')).toBeNull();
    expect(
      updateProgress.mock.calls.some(([source]) => source.mediaId === 'v1'),
    ).toBe(false);
    expect(recordPlay).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'v2' }),
      expect.any(Number),
    );
  });

  test('upgrades first playSource for the seeded video to the saved time', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().seedSource(videoSource, {
      positionSec: 7_200,
      durationSec: 10_000,
    });
    store.getState().attachElement('video', fakeElement());

    await store.getState().playSource(videoSource);

    expect(session.calls.load).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId: 'v1',
        mediaType: 'video',
        url: '/api/media/v1#t=7200',
      }),
    );
    expect(session.calls.play).toHaveBeenCalled();
  });

  test('skips when a real element-backed session is already wired', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);

    const otherSource: PlaybackSource = {
      ...audioSource,
      mediaId: 'other',
      url: '/api/media/other',
    };
    store.getState().seedSource(otherSource);
    // The live source is preserved; the seed does not overwrite a real
    // session.
    expect(store.getState().audio.source?.mediaId).toBe(audioSource.mediaId);
  });
});

describe('selectActiveState', () => {
  test('returns the audio state when active=audio', () => {
    const snapshot = {
      audio: { source: audioSource, status: { kind: 'playing' as const }, positionSec: 1, durationSec: 2 },
      video: { source: null, status: { kind: 'idle' as const }, positionSec: 0, durationSec: 0 },
      active: 'audio' as const,
    };
    expect(selectActiveState(snapshot).source).toEqual(audioSource);
  });

  test('returns the video state when active=video', () => {
    const snapshot = {
      audio: { source: null, status: { kind: 'idle' as const }, positionSec: 0, durationSec: 0 },
      video: { source: videoSource, status: { kind: 'playing' as const }, positionSec: 0, durationSec: 0 },
      active: 'video' as const,
    };
    expect(selectActiveState(snapshot).source).toEqual(videoSource);
  });

  test('returns the idle stub when nothing is active', () => {
    const snapshot = {
      audio: { source: null, status: { kind: 'idle' as const }, positionSec: 0, durationSec: 0 },
      video: { source: null, status: { kind: 'idle' as const }, positionSec: 0, durationSec: 0 },
      active: null,
    };
    expect(selectActiveState(snapshot).source).toBeNull();
  });
});

describe('subscribe propagation', () => {
  test('session updates re-emit through the player store', async () => {
    const session = makeFakeSession();
    const store = createPlayerStore({
      createSession: () => session,
      createEngine: () => fakeEngine(),
    });
    const observed: string[] = [];
    store.subscribe((s) => observed.push(s.audio.status.kind));
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    session.setState({ ...session.getState(), status: { kind: 'paused' } });
    expect(observed).toContain('loading');
    expect(observed).toContain('playing');
    expect(observed).toContain('paused');
  });
});

// Suppress unused-warning by referencing the type at runtime. Vitest already
// compiles these tests but EngineEvent must keep a runtime usage so the
// import is not pruned by isolatedModules.
const _engineEvent: EngineEvent = { kind: 'paused' };
void _engineEvent;
