import { describe, expect, test, vi } from 'vitest';

import type {
  EngineEvent,
  EngineListener,
  PlaybackEngine,
} from '../engine/engine';
import type { PlaybackSource } from '../source/source';
import { createSession } from './session';

function fakeEngine() {
  let listener: EngineListener | null = null;
  const calls = {
    load: vi.fn(),
    play: vi.fn(async () => {
      // no-op
    }),
    pause: vi.fn(),
    seek: vi.fn(),
    release: vi.fn(),
  };
  let current: PlaybackSource | null = null;
  const engine: PlaybackEngine = {
    get currentSource() {
      return current;
    },
    load(source) {
      current = source;
      calls.load(source);
    },
    play: calls.play,
    pause: calls.pause,
    seek: calls.seek,
    release: calls.release,
    subscribe(l) {
      listener = l;
      return () => {
        if (listener === l) listener = null;
      };
    },
  };
  const fire = (event: EngineEvent) => {
    listener?.(event);
  };
  return { engine, fire, calls, hasListener: () => listener !== null };
}

const remote: PlaybackSource = {
  kind: 'remote',
  mediaId: 'abc',
  mediaType: 'audio',
  url: '/api/media/abc',
  name: 'song.mp3',
};

describe('createSession.initialState', () => {
  test('starts idle with no source and zero counters', () => {
    const { engine } = fakeEngine();
    const session = createSession(engine);
    expect(session.getState()).toEqual({
      status: { kind: 'idle' },
      source: null,
      positionSec: 0,
      durationSec: 0,
      mediaPositionUpdateSeq: 0,
    });
  });
});

describe('createSession.load', () => {
  test('moves to loading and stamps the source synchronously', () => {
    const { engine, calls } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    expect(session.getState()).toEqual({
      status: { kind: 'loading' },
      source: remote,
      positionSec: 0,
      durationSec: 0,
      mediaPositionUpdateSeq: 0,
    });
    expect(calls.load).toHaveBeenCalledWith(remote);
  });

  test('uses source duration as the initial duration while metadata loads', () => {
    const { engine } = fakeEngine();
    const session = createSession(engine);
    const source: PlaybackSource = { ...remote, durationSec: 18_000 };

    session.load(source);

    expect(session.getState()).toMatchObject({
      source,
      positionSec: 0,
      durationSec: 18_000,
    });
  });

  test('clears stale position and duration on a new load', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    fire({ kind: 'metadata', durationSec: 60 });
    fire({ kind: 'time', positionSec: 30 });
    expect(session.getState().durationSec).toBe(60);

    const second: PlaybackSource = { ...remote, mediaId: 'xyz', url: '/api/media/xyz' };
    session.load(second);
    expect(session.getState()).toEqual({
      status: { kind: 'loading' },
      source: second,
      positionSec: 0,
      durationSec: 0,
      mediaPositionUpdateSeq: 0,
    });
  });
});

describe('engine -> session projection', () => {
  test('metadata event updates duration without changing status', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    fire({ kind: 'metadata', durationSec: 42 });
    expect(session.getState().durationSec).toBe(42);
    expect(session.getState().status).toEqual({ kind: 'loading' });
  });

  test('canplay returns a loaded but paused source to paused status', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    fire({ kind: 'metadata', durationSec: 42 });
    fire({ kind: 'canplay', paused: true });
    expect(session.getState().status).toEqual({ kind: 'paused' });
  });

  test('canplay does not interrupt an already playing source', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    fire({ kind: 'playing' });
    fire({ kind: 'canplay', paused: false });
    expect(session.getState().status).toEqual({ kind: 'playing' });
  });

  test('playing/paused/waiting/ended drive status', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    fire({ kind: 'playing' });
    expect(session.getState().status).toEqual({ kind: 'playing' });
    fire({ kind: 'paused' });
    expect(session.getState().status).toEqual({ kind: 'paused' });
    fire({ kind: 'waiting' });
    expect(session.getState().status).toEqual({ kind: 'buffering' });
    fire({ kind: 'ended' });
    expect(session.getState().status).toEqual({ kind: 'ended' });
  });

  test('paused after ended is ignored so the terminal state stays', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    fire({ kind: 'ended' });
    fire({ kind: 'paused' });
    expect(session.getState().status).toEqual({ kind: 'ended' });
  });

  test('error event surfaces the message', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    fire({ kind: 'error', message: 'source not supported' });
    expect(session.getState().status).toEqual({
      kind: 'error',
      message: 'source not supported',
    });
  });

  test('time event updates position only when a source is loaded', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    fire({ kind: 'time', positionSec: 999 });
    expect(session.getState().positionSec).toBe(0);
    session.load(remote);
    fire({ kind: 'time', positionSec: 12 });
    expect(session.getState().positionSec).toBe(12);
    expect(session.getState().mediaPositionUpdateSeq).toBe(1);
  });
});

describe('session listeners', () => {
  test('subscribers receive every state change', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    const seen: string[] = [];
    session.subscribe((s) => seen.push(s.status.kind));
    session.load(remote);
    fire({ kind: 'playing' });
    fire({ kind: 'paused' });
    expect(seen).toEqual(['loading', 'playing', 'paused']);
  });

  test('returned function removes the listener', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    const seen: string[] = [];
    const off = session.subscribe((s) => seen.push(s.status.kind));
    session.load(remote);
    off();
    fire({ kind: 'playing' });
    expect(seen).toEqual(['loading']);
  });
});

describe('imperative surface forwards to engine', () => {
  test('play, pause, and seek delegate', async () => {
    const { engine, calls } = fakeEngine();
    const session = createSession(engine);
    await session.play();
    session.pause();
    session.seek(15);
    expect(calls.play).toHaveBeenCalled();
    expect(calls.pause).toHaveBeenCalled();
    expect(calls.seek).toHaveBeenCalledWith(15);
  });

  test('seek mirrors the requested position immediately', () => {
    const { engine } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    session.seek(8);
    expect(session.getState().positionSec).toBe(8);
    expect(session.getState().mediaPositionUpdateSeq).toBe(0);
  });

  test('seek mirror does not count as a media position update', () => {
    const { engine, fire } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);

    session.seek(1_800);
    expect(session.getState().mediaPositionUpdateSeq).toBe(0);

    fire({ kind: 'time', positionSec: 1_800 });
    expect(session.getState().mediaPositionUpdateSeq).toBe(1);
  });

  test('seek ignores invalid input', () => {
    const { engine } = fakeEngine();
    const session = createSession(engine);
    session.load(remote);
    session.seek(Number.NaN);
    session.seek(-1);
    expect(session.getState().positionSec).toBe(0);
  });
});

describe('dispose', () => {
  test('detaches engine listener and stops emitting to subscribers', () => {
    const { engine, fire, hasListener } = fakeEngine();
    const session = createSession(engine);
    const seen: string[] = [];
    session.subscribe((s) => seen.push(s.status.kind));
    session.dispose();
    expect(hasListener()).toBe(false);
    fire({ kind: 'playing' });
    expect(seen).toEqual([]);
  });

  test('releases the underlying engine so the media element does not keep buffering', () => {
    const { engine, calls } = fakeEngine();
    const session = createSession(engine);
    session.dispose();
    expect(calls.release).toHaveBeenCalledTimes(1);
  });
});
