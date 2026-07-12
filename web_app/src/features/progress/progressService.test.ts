import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  PlaybackSession,
  PlaybackState,
  SessionListener,
} from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import type {
  ProgressRecord,
  ProgressRepository,
} from '../../core/storage/progressRepository';
import { createProgressService } from './progressService';

function memoryRepo(): ProgressRepository {
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
      for (const [id, record] of data) {
        const stamp = Date.parse(record.lastPlayedAt);
        if (Number.isFinite(stamp) && stamp > bestStamp) {
          bestStamp = stamp;
          best = { mediaId: id, record };
        }
      }
      return best;
    },
  };
}

interface ProgrammableSession extends PlaybackSession {
  push: (state: PlaybackState) => void;
  seekCalls: number[];
}

function makeSession(initial: PlaybackState): ProgrammableSession {
  let state = initial;
  const listeners = new Set<SessionListener>();
  const seekCalls: number[] = [];
  return {
    seekCalls,
    push(next) {
      state = next;
      for (const l of [...listeners]) l(state);
    },
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    load: () => {},
    play: async () => {},
    pause: () => {},
    seek: (pos) => {
      seekCalls.push(pos);
    },
    dispose: () => {},
  };
}

const idleState: PlaybackState = {
  status: { kind: 'idle' },
  source: null,
  positionSec: 0,
  durationSec: 0,
};

const remote: PlaybackSource = {
  kind: 'remote',
  mediaId: 'm1',
  mediaType: 'video',
  url: '/api/media/m1',
  name: 'clip.mp4',
};

describe('progressService.attach', () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
  });

  const tick = (ms: number) => {
    now += ms;
    return now;
  };

  test('does not call session.seek; resume is driven by URL fragment', () => {
    const repo = memoryRepo();
    repo.write('m1', {
      positionSec: 120,
      durationSec: 600,
      lastPlayedAt: '2025-01-01T00:00:00Z',
    });
    const session = makeSession(idleState);
    const service = createProgressService(repo, { now: () => now });
    service.attach(session);

    session.push({
      status: { kind: 'loading' },
      source: remote,
      positionSec: 0,
      durationSec: 600,
    });
    session.push({
      status: { kind: 'playing' },
      source: remote,
      positionSec: 0,
      durationSec: 600,
    });
    expect(session.seekCalls).toEqual([]);
  });

  test('saves on pause and on ended', () => {
    const repo = memoryRepo();
    const session = makeSession(idleState);
    const service = createProgressService(repo, { now: () => now });
    service.attach(session);

    session.push({
      status: { kind: 'paused' },
      source: remote,
      positionSec: 90,
      durationSec: 600,
    });
    expect(repo.read('m1')?.positionSec).toBe(90);

    session.push({
      status: { kind: 'ended' },
      source: remote,
      positionSec: 600,
      durationSec: 600,
    });
    expect(repo.read('m1')?.positionSec).toBe(600);
  });

  test('throttles writes while playing', () => {
    const repo = memoryRepo();
    const session = makeSession(idleState);
    const writeSpy = vi.spyOn(repo, 'write');
    const service = createProgressService(repo, {
      now: () => now,
      throttleMs: 1000,
    });
    service.attach(session);

    session.push({
      status: { kind: 'playing' },
      source: remote,
      positionSec: 5,
      durationSec: 600,
    });
    session.push({
      status: { kind: 'playing' },
      source: remote,
      positionSec: 6,
      durationSec: 600,
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);

    tick(1500);
    session.push({
      status: { kind: 'playing' },
      source: remote,
      positionSec: 8,
      durationSec: 600,
    });
    expect(writeSpy).toHaveBeenCalledTimes(2);
  });

  test('uses source duration when video session duration is not available yet', () => {
    const repo = memoryRepo();
    const session = makeSession(idleState);
    const service = createProgressService(repo, {
      now: () => now,
      throttleMs: 1000,
    });
    service.attach(session);

    session.push({
      status: { kind: 'playing' },
      source: {
        ...remote,
        durationSec: 600,
        rootName: 'videos',
        relativePath: 'clip.mp4',
      },
      positionSec: 45,
      durationSec: 0,
    });

    expect(repo.read('m1')).toMatchObject({
      positionSec: 45,
      durationSec: 600,
      source: {
        mediaType: 'video',
        name: 'clip.mp4',
        rootName: 'videos',
        relativePath: 'clip.mp4',
      },
    });
  });

  test('flushes on dispose so a navigation does not lose progress', () => {
    const repo = memoryRepo();
    const session = makeSession(idleState);
    const service = createProgressService(repo, {
      now: () => now,
      throttleMs: 60_000,
    });
    const attachment = service.attach(session);

    session.push({
      status: { kind: 'playing' },
      source: remote,
      positionSec: 42,
      durationSec: 600,
    });
    repo.clear('m1');
    attachment.dispose();
    expect(repo.read('m1')?.positionSec).toBe(42);
  });

  test('flushes on pagehide so mobile video backgrounding saves progress', () => {
    const repo = memoryRepo();
    const session = makeSession(idleState);
    const service = createProgressService(repo, {
      now: () => now,
      throttleMs: 60_000,
    });
    const attachment = service.attach(session);

    session.push({
      status: { kind: 'playing' },
      source: remote,
      positionSec: 42,
      durationSec: 600,
    });
    repo.clear('m1');
    window.dispatchEvent(new Event('pagehide'));

    expect(repo.read('m1')?.positionSec).toBe(42);
    attachment.dispose();
  });

  test('ignores spurious updates with no source', () => {
    const repo = memoryRepo();
    const writeSpy = vi.spyOn(repo, 'write');
    const session = makeSession(idleState);
    const service = createProgressService(repo, { now: () => now });
    service.attach(session);

    session.push({
      status: { kind: 'paused' },
      source: null,
      positionSec: 50,
      durationSec: 100,
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('progressService.recordFor', () => {
  test('proxies to the repository read', () => {
    const repo = memoryRepo();
    repo.write('m1', { positionSec: 1, durationSec: 2, lastPlayedAt: '' });
    const service = createProgressService(repo);
    expect(service.recordFor('m1')?.positionSec).toBe(1);
    expect(service.recordFor('missing')).toBeNull();
  });
});
