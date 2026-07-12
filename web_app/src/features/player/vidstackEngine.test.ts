import { describe, expect, test, vi } from 'vitest';

import { createSession } from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import type {
  ProgressRecord,
  ProgressRepository,
} from '../../core/storage/progressRepository';
import { createProgressService } from '../progress/progressService';
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
  state: { error?: { code?: number; message?: string } | null } = {
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

describe('createVidstackEngine', () => {
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
});
