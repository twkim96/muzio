import { encodeNativeVideoSource } from './nativeVideoSource';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  clearPlaybackDiagnostics,
  getPlaybackDiagnosticSampleId,
  getPlaybackDiagnosticTransportCorrelationId,
  getPlaybackDiagnostics,
  setPlaybackDiagnosticsEnabled,
} from '../../core/playback/diagnostics/playbackDiagnostics';
import { createSession } from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import type {
  ProgressRecord,
  ProgressRepository,
} from '../../core/storage/progressRepository';
import { createProgressService } from '../progress/progressService';
import { createPlayerStore } from './playerStore';
import {
  createVidstackEngine,
  type VidstackPlayerLike,
} from './vidstackEngine';

class FakeVidstackPlayer extends EventTarget implements VidstackPlayerLike {
  el = document.createElement('div');
  duration = 120;
  paused = true;
  currentSrc: unknown = null;
  currentTime = 0;
  volume = 1;
  muted = false;
  state: {
    error?: { code?: number; message?: string } | null;
    buffered?: TimeRanges;
  } = {
    error: null,
  };
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(async () => {
    this.paused = true;
  });
  startLoading = vi.fn();
}

const source: PlaybackSource = {
  kind: 'remote',
  mediaId: 'v1',
  mediaType: 'video',
  url: '/api/media/v1',
  mimeType: 'video/mp4',
  name: 'clip.mp4',
  rootName: 'videos',
  relativePath: 'clips/clip.mp4',
};

const secondSource: PlaybackSource = {
  ...source,
  mediaId: 'v2',
  url: '/api/media/v2',
  name: 'second.mp4',
};

function dispatchSourceChange(
  player: FakeVidstackPlayer,
  playbackSource: PlaybackSource,
) {
  player.dispatchEvent(
    new CustomEvent('source-change', {
      detail: {
        src: playbackSource.url,
        type: playbackSource.mimeType,
      },
    }),
  );
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
    mostRecent: () => null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setPlaybackDiagnosticsEnabled(false);
  clearPlaybackDiagnostics();
});

describe('createVidstackEngine', () => {
  test('falls back from an unavailable native index proxy once without losing resume or identity', async () => {
    vi.stubGlobal('MuzioNative', {
      platform: 'macos',
      videoIndexBaseUrl: 'http://127.0.0.1:12345/0123456789abcdef0123456789abcdef/',
      postMessage: vi.fn(),
    });
    const original = { ...source, url: `${source.url}?v=2#t=60` };
    const player = new FakeVidstackPlayer();
    const commit = vi.fn(async (_next: PlaybackSource | null) => {});
    const engine = createVidstackEngine(player, commit);
    const events: string[] = [];
    engine.subscribe((event) => events.push(event.kind));
    engine.load(original);
    const play = engine.play();
    await Promise.resolve();
    const proxy = commit.mock.calls[0][0]!;
    expect(proxy.url).toContain('127.0.0.1:12345');
    expect(engine.currentSource).toBe(original);
    player.currentSrc = proxy.url;
    player.dispatchEvent(new Event('error'));
    await Promise.resolve();
    const fallback = commit.mock.calls[1][0]!;
    expect(new URL(fallback.url, window.location.href).hash).toBe('#t=60');
    expect(fallback.url).not.toContain('12345');
    expect(events).not.toContain('error');
    player.currentSrc = fallback.url;
    dispatchSourceChange(player, fallback);
    player.dispatchEvent(new Event('can-play'));
    await play;
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.currentTime).toBe(60);
    player.dispatchEvent(new Event('error'));
    expect(commit).toHaveBeenCalledTimes(2);
    expect(events.filter((kind) => kind === 'error')).toHaveLength(1);
    engine.release();
  });

  function proxyFixture() {
    vi.stubGlobal('MuzioNative', {
      platform: 'macos',
      videoIndexBaseUrl: 'http://127.0.0.1:12345/0123456789abcdef0123456789abcdef/',
      postMessage: vi.fn(),
    });
    const player = new FakeVidstackPlayer();
    const commit = vi.fn(async (_next: PlaybackSource | null) => {});
    const engine = createVidstackEngine(player, commit);
    const original = { ...source, url: `${source.url}#t=60` };
    const session = createSession(engine);
    session.load(original);
    const proxy = commit.mock.calls[0][0]!;
    player.currentSrc = proxy.url;
    dispatchSourceChange(player, proxy);
    const ready = () => {
      const transport = commit.mock.calls.at(-1)![0]!;
      player.currentSrc = transport.url;
      dispatchSourceChange(player, transport);
      player.dispatchEvent(new Event('can-play'));
    };
    return { player, commit, engine, session, ready };
  }

  test('waits for fresh fallback readiness and ignores late proxy readiness', async () => {
    const { player, commit, engine, ready } = proxyFixture();
    ready();
    await engine.play();
    player.currentTime = 75;
    player.play.mockClear();
    player.dispatchEvent(new Event('error'));
    const resume = engine.play();
    await Promise.resolve();
    await Promise.resolve();
    player.dispatchEvent(new Event('can-play')); // Still names the failed proxy.
    player.dispatchEvent(new Event('error'));
    expect(commit).toHaveBeenCalledTimes(2);
    expect(player.play).not.toHaveBeenCalled();
    ready();
    await resume;
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.currentTime).toBe(75);
    engine.release();
  });

  test('keeps a pause from Vidstack controls across proxy fallback', async () => {
    const { player, engine, ready } = proxyFixture();
    ready();
    await engine.play();
    player.paused = true;
    player.dispatchEvent(new Event('pause'));
    player.play.mockClear();
    player.dispatchEvent(new Event('error'));
    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(player.play).not.toHaveBeenCalled();
    expect(player.paused).toBe(true);
    engine.release();
  });

  test('carries playback started by Vidstack controls into the fallback', async () => {
    const { player, engine, ready } = proxyFixture();
    ready();
    player.paused = false;
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(new Event('error'));
    ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(player.play).toHaveBeenCalledOnce();
    engine.release();
  });

  test.each([0, 90])('preserves an immediate seek to %s instead of the old resume fragment', async (position) => {
    const { player, commit, engine, ready } = proxyFixture();
    ready();
    player.currentTime = 60;
    player.dispatchEvent(new Event('time-update'));
    engine.seek(position);
    player.dispatchEvent(new Event('error'));
    const fallback = commit.mock.calls[1][0]!;
    expect(new URL(fallback.url).hash).toBe(position ? `#t=${position}` : '');
    engine.release();
  });

  test('restores the same duration after the fallback loading event resets the session', () => {
    const { player, engine, session, ready } = proxyFixture();
    ready();
    player.dispatchEvent(new Event('loaded-metadata'));
    expect(session.getState().durationSec).toBe(120);
    player.dispatchEvent(new Event('error'));
    ready();
    player.dispatchEvent(new Event('load-start'));
    expect(session.getState().durationSec).toBe(0);
    player.dispatchEvent(new Event('loaded-metadata'));
    expect(session.getState().durationSec).toBe(120);
    engine.release();
  });

  test('honors pause while the initial play waits through proxy fallback', async () => {
    const { player, engine, ready } = proxyFixture();
    const pending = engine.play();
    player.dispatchEvent(new Event('error'));
    engine.pause();
    ready();
    await pending;
    expect(player.play).not.toHaveBeenCalled();
    engine.release();
  });

  test('waits for the React source commit before loading and playing', async () => {
    let finishCommit = () => {};
    const commitSource = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCommit = resolve;
        }),
    );
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, commitSource);

    engine.load(source);
    const play = engine.play();

    expect(player.startLoading).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();

    finishCommit();
    await Promise.resolve();
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('can-play'));
    await play;

    expect(commitSource).toHaveBeenCalledWith(source);
    expect(player.startLoading).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledOnce();
  });

  test('retains observed identity for an identical pending reload without currentSrc', async () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const resumed = { ...source, url: `${source.url}#t=49.9` };
    engine.load(resumed);
    dispatchSourceChange(player, resumed);
    engine.load({ ...resumed });
    const play = engine.play();
    player.dispatchEvent(new Event('can-play'));
    await play;
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.currentTime).toBe(49.9);
  });

  test.each(['different-source', 'changed-fragment', 'retry-after-error'] as const)(
    'requires fresh observed identity for %s when currentSrc is unavailable', async (scenario) => {
      const player = new FakeVidstackPlayer();
      const engine = createVidstackEngine(player, async () => {});
      engine.load(source);
      dispatchSourceChange(player, source);
      if (scenario === 'retry-after-error') player.dispatchEvent(new Event('error'));
      const next = scenario === 'different-source' ? secondSource : scenario === 'changed-fragment'
        ? { ...source, url: `${source.url}#t=49.9` } : source;
      engine.load(next);
      const play = engine.play();
      player.dispatchEvent(new Event('can-play'));
      await Promise.resolve();
      await Promise.resolve();
      expect(player.play).not.toHaveBeenCalled();
      dispatchSourceChange(player, next);
      player.dispatchEvent(new Event('can-play'));
      await play;
      expect(player.play).toHaveBeenCalledOnce();
    },
  );

  test('normalizes Vidstack events into playback engine events', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const events: string[] = [];
    engine.subscribe((event) => events.push(event.kind));

    player.dispatchEvent(new Event('load-start'));
    player.dispatchEvent(new Event('loaded-metadata'));
    player.dispatchEvent(new Event('can-play'));
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(new Event('pause'));
    player.dispatchEvent(new Event('waiting'));
    player.dispatchEvent(new Event('time-update'));
    player.dispatchEvent(new Event('ended'));
    player.dispatchEvent(new Event('error'));

    expect(events).toEqual([
      'loading',
      'metadata',
      'canplay',
      'playing',
      'paused',
      'waiting',
      'time',
      'ended',
      'error',
    ]);
  });

  test('keeps the original source identity when the Apple provider uses an opaque transport URL', async () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const session = createSession(engine);
    session.load(source);
    const virtual = encodeNativeVideoSource(source.url);
    player.currentSrc = { src: virtual, type: 'video/muzio-native' };
    player.dispatchEvent(new CustomEvent('source-change', { detail: player.currentSrc }));
    player.dispatchEvent(new Event('can-play'));
    player.currentTime = 90;
    player.dispatchEvent(new Event('seeking'));
    expect(session.getState()).toMatchObject({ source, positionSec: 90, userSeekTargetSec: 90 });
  });

  test('projects a native Vidstack timeline seek into the session boundary state', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const session = createSession(engine);

    session.load(source);
    dispatchSourceChange(player, source);
    player.currentSrc = { src: source.url, type: source.mimeType };
    player.currentTime = 90;
    player.dispatchEvent(new Event('seeking'));

    expect(session.getState()).toMatchObject({
      positionSec: 90,
      userSeekSeq: 1,
      userSeekTargetSec: 90,
    });
  });

  test('persists video progress from Vidstack duration and time updates', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const session = createSession(engine);
    const repo = memoryProgressRepository();
    createProgressService(repo, {
      now: () => Date.UTC(2026, 6, 4),
      throttleMs: 60_000,
    }).attach(session);

    session.load(source);
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(
      new CustomEvent('duration-change', {
        detail: { duration: 120 },
      }),
    );
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(
      new CustomEvent('time-update', {
        detail: { currentTime: 45 },
      }),
    );

    expect(repo.read('v1')).toMatchObject({
      positionSec: 45,
      durationSec: 120,
      source: {
        mediaType: 'video',
        name: 'clip.mp4',
      },
    });
  });

  test('persists video progress from Vidstack time-change when time-update is absent', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const session = createSession(engine);
    const repo = memoryProgressRepository();
    createProgressService(repo, {
      now: () => Date.UTC(2026, 6, 4),
      throttleMs: 60_000,
    }).attach(session);

    session.load(source);
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(
      new CustomEvent('duration-change', {
        detail: 120,
      }),
    );
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(
      new CustomEvent('time-change', {
        detail: 45,
      }),
    );

    expect(session.getState()).toMatchObject({
      positionSec: 45,
      durationSec: 120,
    });
    expect(repo.read('v1')).toMatchObject({
      positionSec: 45,
      durationSec: 120,
    });
  });

  test('deduplicates matching time-change and time-update positions', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const events: Array<{ kind: string; positionSec?: number }> = [];
    engine.subscribe((event) => events.push(event));

    player.dispatchEvent(
      new CustomEvent('time-change', { detail: { currentTime: 45 } }),
    );
    player.dispatchEvent(
      new CustomEvent('time-update', { detail: { currentTime: 45 } }),
    );

    expect(events.filter((event) => event.kind === 'time')).toEqual([
      { kind: 'time', positionSec: 45 },
    ]);
  });

  test('persists video progress when only player duration is available on time events', () => {
    const player = new FakeVidstackPlayer();
    player.duration = 33_944.864333;
    const engine = createVidstackEngine(player, async () => {});
    const session = createSession(engine);
    const repo = memoryProgressRepository();
    createProgressService(repo, {
      now: () => Date.UTC(2026, 6, 4),
      throttleMs: 60_000,
    }).attach(session);

    session.load(source);
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(
      new CustomEvent('time-change', {
        detail: { currentTime: 15 },
      }),
    );

    expect(session.getState()).toMatchObject({
      positionSec: 15,
      durationSec: 33_944.864333,
    });
    expect(repo.read('v1')).toMatchObject({
      positionSec: 15,
      durationSec: 33_944.864333,
    });
  });

  test('seeks directly through the Vidstack player', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.seek(42);

    expect(player.currentTime).toBe(42);
  });

  test('release removes listeners and pauses playback', () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const listener = vi.fn();
    engine.subscribe(listener);

    engine.release();
    player.dispatchEvent(new Event('playing'));

    expect(player.pause).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(engine.currentSource).toBeNull();
  });

  test('settles superseded play requests without playing the stale source', async () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(source);
    const firstPlay = engine.play();
    engine.load(secondSource);
    const secondPlay = engine.play();
    await Promise.resolve();
    dispatchSourceChange(player, secondSource);
    player.dispatchEvent(new Event('can-play'));

    const settled = await Promise.race([
      Promise.all([firstPlay, secondPlay]).then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 50);
      }),
    ]);

    expect(settled).toBe(true);
    expect(player.play).toHaveBeenCalledOnce();
    expect(engine.currentSource).toEqual(secondSource);
  });

  test('ignores stale readiness events from the previous source', async () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(source);
    const firstPlay = engine.play();
    engine.load(secondSource);
    const secondPlay = engine.play();
    await Promise.resolve();

    player.currentSrc = { src: source.url, type: source.mimeType };
    player.dispatchEvent(new Event('can-play'));
    await Promise.resolve();
    expect(player.play).not.toHaveBeenCalled();

    player.currentSrc = { src: secondSource.url, type: secondSource.mimeType };
    dispatchSourceChange(player, secondSource);
    player.dispatchEvent(new Event('can-play'));
    await Promise.all([firstPlay, secondPlay]);
    expect(player.play).toHaveBeenCalledOnce();
  });

  test('ignores stale playback and seek events until the new source is confirmed', async () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    const resumedSecondSource: PlaybackSource = {
      ...secondSource,
      url: `${secondSource.url}#t=45`,
      durationSec: 120,
    };
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(source);
    const firstPlay = engine.play();
    await Promise.resolve();
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('can-play'));
    await firstPlay;

    engine.load(resumedSecondSource);
    const secondPlay = engine.play();
    await Promise.resolve();

    player.currentSrc = source.url;
    player.currentTime = 7_200;
    player.dispatchEvent(
      new CustomEvent('time-update', {
        detail: { currentTime: 7_200 },
      }),
    );
    player.dispatchEvent(new Event('seeking'));
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(new Event('pause'));
    player.dispatchEvent(new Event('ended'));

    player.currentSrc = secondSource.url;
    player.currentTime = 0;
    dispatchSourceChange(player, resumedSecondSource);
    player.dispatchEvent(new Event('can-play'));
    await secondPlay;

    expect(player.currentTime).toBe(45);
    expect(getPlaybackDiagnostics().map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'stale_time-update_ignored',
        'stale_seeking_ignored',
        'stale_playing_ignored',
        'stale_pause_ignored',
        'stale_ended_ignored',
        'resume_target_apply_before_play',
      ]),
    );
  });

  test('accepts an absolute current URL for the active relative source', async () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(source);
    const play = engine.play();
    await Promise.resolve();
    dispatchSourceChange(player, source);
    player.currentSrc = {
      src: new URL(source.url, window.location.href).href,
      type: source.mimeType,
    };
    player.dispatchEvent(new Event('can-play'));
    await play;

    expect(player.play).toHaveBeenCalledOnce();
  });

  test('accepts provider URLs that omit a resume fragment from the active source', async () => {
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=45`,
      durationSec: 120,
    };
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const session = createSession(engine);
    const repo = memoryProgressRepository();
    createProgressService(repo, {
      now: () => Date.UTC(2026, 6, 4),
      throttleMs: 60_000,
    }).attach(session);

    session.load(resumedSource);
    const play = session.play();
    await Promise.resolve();

    player.currentSrc = { src: source.url, type: source.mimeType };
    player.dispatchEvent(
      new CustomEvent('source-change', {
        detail: {
          src: source.url,
          type: source.mimeType,
        },
      }),
    );
    player.dispatchEvent(new Event('can-play'));
    await play;

    player.dispatchEvent(
      new CustomEvent('duration-change', {
        detail: 120,
      }),
    );
    player.dispatchEvent(new Event('playing'));
    player.dispatchEvent(
      new CustomEvent('time-update', {
        detail: { currentTime: 46 },
      }),
    );

    expect(player.play).toHaveBeenCalledOnce();
    expect(player.currentTime).toBe(45);
    expect(session.getState()).toMatchObject({
      positionSec: 46,
      durationSec: 120,
    });
    expect(repo.read('v1')).toMatchObject({
      positionSec: 46,
      durationSec: 120,
    });
  });

  test.each([false, true])('keeps cold resume pending when the provider initially clamps a seek to zero (prepared: %s)', async (prepared) => {
    const player = new FakeVidstackPlayer();
    let position = 0;
    let seekable = false;
    Object.defineProperty(player, 'currentTime', {
      get: () => position,
      set: (value: number) => {
        position = seekable ? value : 0;
        player.dispatchEvent(new CustomEvent('seeking', { detail: position }));
      },
    });
    const engine = createVidstackEngine(player, async () => {});
    const store = createPlayerStore({ createEngine: () => engine });
    store.getState().seedSource(source, { positionSec: 45, durationSec: 120 });
    const element = document.createElement('video');
    document.body.append(element);
    store.getState().attachElement('video', element);
    expect(store.getState().video.positionSec).toBe(45);
    expect(engine.currentSource).toBeNull();
    if (prepared) store.getState().prepareSeededSource('video');
    const task = store.getState().togglePlayPause();
    await vi.waitFor(() => expect(engine.currentSource).not.toBeNull());
    const resumed = engine.currentSource!;
    player.currentSrc = resumed.url;
    dispatchSourceChange(player, resumed);
    player.dispatchEvent(new Event('can-play'));
    await task;
    seekable = true;
    player.dispatchEvent(new Event('progress'));
    player.dispatchEvent(new CustomEvent('time-update', { detail: { currentTime: 0 } }));
    expect(player.currentTime).toBe(45);
    player.dispatchEvent(new CustomEvent('time-update', { detail: { currentTime: 45 } }));
    expect(store.getState().video.positionSec).toBe(45);
    store.getState().detachElement('video');
    element.remove();
  });

  test('allows playback from a nearby keyframe without repeated resume seeks', async () => {
    const player = new FakeVidstackPlayer();
    player.play = vi.fn(async () => { player.currentTime = 44; player.paused = false; });
    const engine = createVidstackEngine(player, async () => {});
    const resumed = { ...source, url: source.url + '#t=45' };
    engine.load(resumed);
    const task = engine.play();
    await Promise.resolve();
    player.currentSrc = resumed.url;
    dispatchSourceChange(player, resumed);
    player.dispatchEvent(new Event('can-play'));
    await task;
    player.dispatchEvent(new Event('progress'));
    expect(player.currentTime).toBe(44);
    engine.release();
  });

  test('an explicit UI seek to zero overrides a pending startup resume', async () => {
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});
    const resumed = { ...source, url: source.url + '#t=45' };
    engine.load(resumed);
    const task = engine.play();
    await Promise.resolve();
    player.currentSrc = resumed.url;
    dispatchSourceChange(player, resumed);
    player.dispatchEvent(new Event('can-play'));
    await task;
    player.dispatchEvent(new CustomEvent('media-seek-request', { detail: 0 }));
    player.currentTime = 0;
    player.dispatchEvent(new Event('seeking'));
    player.dispatchEvent(new Event('progress'));
    expect(player.currentTime).toBe(0);
    engine.release();
  });

  test('applies a resume fragment after can-play before starting playback', async () => {
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=14400`,
      durationSec: 18_000,
    };
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(resumedSource);
    const play = engine.play();
    await Promise.resolve();

    player.currentSrc = { src: source.url, type: source.mimeType };
    player.dispatchEvent(
      new CustomEvent('source-change', {
        detail: {
          src: source.url,
          type: source.mimeType,
        },
      }),
    );
    player.dispatchEvent(new Event('can-play'));
    await play;

    expect(player.currentTime).toBe(14_400);
    expect(player.play).toHaveBeenCalledOnce();
  });

  test('reapplies a resume fragment if play resets current time', async () => {
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=7200`,
      durationSec: 10_000,
    };
    const player = new FakeVidstackPlayer();
    player.play = vi.fn(async () => {
      player.currentTime = 0;
      player.paused = false;
    });
    const engine = createVidstackEngine(player, async () => {});

    engine.load(resumedSource);
    const play = engine.play();
    await Promise.resolve();

    player.currentSrc = { src: source.url, type: source.mimeType };
    player.dispatchEvent(
      new CustomEvent('source-change', {
        detail: {
          src: source.url,
          type: source.mimeType,
        },
      }),
    );
    player.dispatchEvent(new Event('can-play'));
    await play;

    expect(player.play).toHaveBeenCalledOnce();
    expect(player.currentTime).toBe(7_200);
  });

  test('consumes the resume target after playback progresses and never rewinds on replay', async () => {
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=7200`,
      durationSec: 10_000,
    };
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(resumedSource);
    const firstPlay = engine.play();
    await Promise.resolve();
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('can-play'));
    await firstPlay;

    player.currentTime = 7_210;
    player.dispatchEvent(
      new CustomEvent('time-update', {
        detail: { currentTime: 7_210 },
      }),
    );
    engine.pause();
    await engine.play();

    expect(player.currentTime).toBe(7_210);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  test('does not rewind normal progress made before the play promise resolves', async () => {
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=7200`,
      durationSec: 10_000,
    };
    const player = new FakeVidstackPlayer();
    player.play = vi.fn(async () => {
      player.currentTime += 0.6;
      player.paused = false;
    });
    const engine = createVidstackEngine(player, async () => {});

    engine.load(resumedSource);
    const play = engine.play();
    await Promise.resolve();
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('can-play'));
    await play;

    expect(player.currentTime).toBe(7_200.6);
  });

  test('native Vidstack seeking cancels the pending resume fallback', async () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=7200`,
      durationSec: 10_000,
    };
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(resumedSource);
    const firstPlay = engine.play();
    await Promise.resolve();
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('can-play'));
    await firstPlay;

    player.currentTime = 120;
    player.dispatchEvent(new Event('seeking'));
    engine.pause();
    await engine.play();

    expect(player.currentTime).toBe(120);
    expect(getPlaybackDiagnostics().map((entry) => entry.kind)).toContain(
      'resume_target_canceled_native_seek',
    );
  });

  test('does not mistake the internal resume seek for a native manual seek', async () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=7200`,
      durationSec: 10_000,
    };
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async () => {});

    engine.load(resumedSource);
    const play = engine.play();
    await Promise.resolve();
    player.currentSrc = source.url;
    dispatchSourceChange(player, source);
    player.dispatchEvent(new Event('can-play'));
    await play;
    player.dispatchEvent(new Event('seeking'));
    player.dispatchEvent(new Event('playing'));

    const kinds = getPlaybackDiagnostics().map((entry) => entry.kind);
    expect(kinds).toContain('resume_target_internal_seeking');
    expect(kinds).not.toContain('resume_target_canceled_native_seek');
  });

  test('does not overwrite a manual seek with the previous resume fallback', async () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}#t=7200`,
      durationSec: 10_000,
    };
    const player = new FakeVidstackPlayer();
    let committedSource: PlaybackSource | null = null;
    const engine = createVidstackEngine(player, async (nextSource) => {
      committedSource = nextSource;
    });

    engine.load(resumedSource);
    engine.seek(120);
    const play = engine.play();
    await Promise.resolve();
    player.currentSrc = committedSource!.url;
    dispatchSourceChange(player, committedSource!);
    player.dispatchEvent(new Event('can-play'));
    await play;

    expect(player.currentTime).toBe(120);
    expect(getPlaybackDiagnostics().map((entry) => entry.kind)).toContain(
      'resume_target_canceled_manual_seek',
    );
    expect(getPlaybackDiagnostics().map((entry) => entry.kind)).not.toContain(
      'resume_target_apply_before_play',
    );
  });

  test('correlates diagnostic samples without changing media URL cache identity', async () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    const resumedSource: PlaybackSource = {
      ...source,
      url: `${source.url}?existing=1#t=45`,
      durationSec: 120,
    };
    let committedSource: PlaybackSource | null = null;
    const player = new FakeVidstackPlayer();
    const engine = createVidstackEngine(player, async (nextSource) => {
      committedSource = nextSource;
    });

    engine.load(resumedSource);
    const play = engine.play();
    await Promise.resolve();

    expect(committedSource).not.toBeNull();
    expect(committedSource).toEqual(resumedSource);
    const transportCorrelationId =
      getPlaybackDiagnosticTransportCorrelationId();
    const firstSampleId = getPlaybackDiagnosticSampleId();
    clearPlaybackDiagnostics();
    const secondSampleId = getPlaybackDiagnosticSampleId();
    expect(getPlaybackDiagnosticTransportCorrelationId()).toBe(
      transportCorrelationId,
    );
    expect(secondSampleId).not.toBe(firstSampleId);
    expect(committedSource!.url).toBe(`${source.url}?existing=1#t=45`);

    player.currentSrc = committedSource!.url;
    dispatchSourceChange(player, committedSource!);
    player.dispatchEvent(new Event('can-play'));
    await play;
    player.dispatchEvent(new Event('progress'));
    engine.seek(60);
    player.dispatchEvent(new Event('seeking'));
    player.dispatchEvent(new Event('seeked'));
    player.dispatchEvent(new Event('playing'));

    const entries = getPlaybackDiagnostics();
    expect(entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        'canplay',
        'resume_target_apply_before_play',
        'progress',
        'seek_request',
        'seeking',
        'seeked',
        'playing',
      ]),
    );
    expect(entries.every((entry) => entry.mediaId === source.mediaId)).toBe(
      true,
    );
    expect(entries.every((entry) => entry.sourceGeneration === 1)).toBe(true);
    expect(entries.at(-1)).toMatchObject({
      transportCorrelationId,
      sampleId: secondSampleId,
      seekGeneration: 2,
    });
    expect(engine.currentSource).toEqual(resumedSource);
  });

  test('does not inspect buffered ranges while diagnostics are disabled', () => {
    const start = vi.fn(() => 0);
    const end = vi.fn(() => 1);
    const player = new FakeVidstackPlayer();
    player.state.buffered = { length: 1, start, end };
    const engine = createVidstackEngine(player, async () => {});

    engine.load(source);
    player.dispatchEvent(new Event('progress'));

    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
