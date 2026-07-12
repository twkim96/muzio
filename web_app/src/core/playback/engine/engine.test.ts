import { describe, expect, test } from 'vitest';

import {
  createEngine,
  type EngineEvent,
  type MediaElementLike,
} from './engine';
import {
  clearPlaybackDiagnostics,
  getPlaybackDiagnostics,
  setPlaybackDiagnosticsEnabled,
} from '../diagnostics/playbackDiagnostics';
import type { PlaybackSource } from '../source/source';

class FakeTimeRanges implements TimeRanges {
  constructor(private readonly ranges: Array<readonly [number, number]>) {}

  get length() {
    return this.ranges.length;
  }

  start(index: number) {
    const range = this.ranges[index];
    if (!range) throw new DOMException('missing range', 'IndexSizeError');
    return range[0];
  }

  end(index: number) {
    const range = this.ranges[index];
    if (!range) throw new DOMException('missing range', 'IndexSizeError');
    return range[1];
  }
}

class CountingTimeRanges extends FakeTimeRanges {
	startCalls = 0;
	endCalls = 0;

	start(index: number) {
		this.startCalls += 1;
		return super.start(index);
	}

	end(index: number) {
		this.endCalls += 1;
		return super.end(index);
	}
}

class FakeMediaElement implements MediaElementLike {
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  readyState = 0;
  networkState = 0;
  buffered: TimeRanges = new FakeTimeRanges([]);
  loadCalls = 0;
  playCalls = 0;
  pauseCalls = 0;
  // Mimic the real `HTMLMediaElement.error` slot so describeMediaError can
  // read it.
  error: { code: number } | null = null;
  private listeners = new Map<string, Set<() => void>>();

  load() {
    this.loadCalls += 1;
  }
  async play() {
    this.playCalls += 1;
    this.paused = false;
  }
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) listener();
  }
  registeredFor(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const sampleSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'abc',
  mediaType: 'audio',
  url: '/api/media/abc',
  name: 'song.mp3',
};

function collect(engine: ReturnType<typeof createEngine>) {
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return events;
}

describe('createEngine.load', () => {
  test('sets src and triggers element.load', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    engine.load(sampleSource);
    expect(element.src).toBe('/api/media/abc');
    expect(element.loadCalls).toBe(1);
    expect(engine.currentSource).toEqual(sampleSource);
  });
});

describe('engine event normalization', () => {
  test('loadstart emits loading', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    engine.load(sampleSource);
    element.fire('loadstart');
    expect(events.at(-1)).toEqual({ kind: 'loading' });
  });

  test('loadedmetadata emits metadata with duration', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.duration = 123.456;
    element.fire('loadedmetadata');
    expect(events.at(-1)).toEqual({ kind: 'metadata', durationSec: 123.456 });
  });

  test('loadedmetadata coerces non-finite duration to 0', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.duration = NaN;
    element.fire('loadedmetadata');
    expect(events.at(-1)).toEqual({ kind: 'metadata', durationSec: 0 });
  });

  test('canplay reports whether the element is still paused', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.paused = true;
    element.fire('canplay');
    expect(events.at(-1)).toEqual({ kind: 'canplay', paused: true });
  });

  test('playing/pause/waiting/seek/stall/progress/ended emit sealed variants', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.fire('playing');
    element.fire('pause');
    element.fire('waiting');
    element.currentTime = 30;
    element.fire('seeking');
    element.currentTime = 31;
    element.fire('seeked');
    element.fire('stalled');
    element.fire('progress');
    element.fire('suspend');
    element.fire('abort');
    element.fire('ended');
    expect(events.map((e) => e.kind)).toEqual([
      'playing',
      'paused',
      'waiting',
      'seeking',
      'seeked',
      'stalled',
      'progress',
      'suspend',
      'abort',
      'ended',
    ]);
    expect(events[3]).toEqual({ kind: 'seeking', positionSec: 30 });
    expect(events[4]).toEqual({ kind: 'seeked', positionSec: 31 });
  });

  test('timeupdate emits the current position', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.currentTime = 42.5;
    element.fire('timeupdate');
    expect(events.at(-1)).toEqual({ kind: 'time', positionSec: 42.5 });
  });

  test('error reads MediaError code and emits a stable message', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.error = { code: 4 };
    element.fire('error');
    expect(events.at(-1)).toEqual({
      kind: 'error',
      message: 'source not supported',
    });
  });

  test('error without a code falls back to the generic message', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events = collect(engine);
    element.error = null;
    element.fire('error');
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'media error' });
  });
});

describe('playback diagnostics', () => {
  test('records load, play, seek, and media events when enabled', async () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    const element = new FakeMediaElement();
    element.readyState = 1;
    element.networkState = 2;
    element.duration = 120;
    element.buffered = new FakeTimeRanges([[0, 20]]);
    const engine = createEngine(element);

    engine.load(sampleSource);
    await engine.play();
    element.currentTime = 5;
    engine.seek(30);
    element.currentTime = 30;
    element.fire('seeking');
    element.fire('seeked');

    const entries = getPlaybackDiagnostics();
    expect(entries.map((entry) => entry.kind)).toEqual([
      'load_request',
      'play_request',
      'seek_request',
      'seeking',
      'seeked',
    ]);
    expect(entries[0]).toMatchObject({
      mediaId: 'abc',
      mediaType: 'audio',
      sourceGeneration: 1,
      seekGeneration: 0,
      readyState: 1,
      networkState: 2,
    });
    expect(entries[2]).toMatchObject({
      kind: 'seek_request',
      previousPositionSec: 5,
      targetPositionSec: 30,
      seekGeneration: 1,
    });
    expect(entries[2].buffered).toEqual([{ startSec: 0, endSec: 20 }]);
    setPlaybackDiagnosticsEnabled(false);
    clearPlaybackDiagnostics();
  });

  test('does not record diagnostics when disabled', () => {
    setPlaybackDiagnosticsEnabled(false);
    clearPlaybackDiagnostics();
    const element = new FakeMediaElement();
    const engine = createEngine(element);

    engine.load(sampleSource);
    element.fire('playing');

    expect(getPlaybackDiagnostics()).toEqual([]);
  });

  test('does not read buffered ranges while diagnostics are disabled', () => {
    setPlaybackDiagnosticsEnabled(false);
    const element = new FakeMediaElement();
    const buffered = new CountingTimeRanges([[0, 20]]);
    element.buffered = buffered;
    createEngine(element);

    element.fire('timeupdate');

    expect(buffered.startCalls).toBe(0);
    expect(buffered.endCalls).toBe(0);
  });
});

describe('engine imperative surface', () => {
  test('play calls element.play and pause calls element.pause', async () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    await engine.play();
    engine.pause();
    expect(element.playCalls).toBe(1);
    expect(element.pauseCalls).toBe(1);
  });

  test('seek writes to currentTime when finite and non-negative', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    engine.load(sampleSource);
    const loadCalls = element.loadCalls;
    engine.seek(7);
    expect(element.currentTime).toBe(7);
    expect(element.loadCalls).toBe(loadCalls);
  });

  test('seek ignores invalid inputs', () => {
    const element = new FakeMediaElement();
    element.currentTime = 5;
    const engine = createEngine(element);
    engine.seek(Number.NaN);
    engine.seek(-1);
    engine.seek(Number.POSITIVE_INFINITY);
    expect(element.currentTime).toBe(5);
  });

  test('play swallows AbortError without emitting an error event', async () => {
    const element = new FakeMediaElement();
    element.play = async () => {
      throw new DOMException('aborted', 'AbortError');
    };
    const engine = createEngine(element);
    const events = collect(engine);
    await engine.play();
    expect(events).toEqual([]);
  });

  test('play translates NotAllowedError into an engine error event', async () => {
    const element = new FakeMediaElement();
    element.play = async () => {
      throw new DOMException('blocked', 'NotAllowedError');
    };
    const engine = createEngine(element);
    const events = collect(engine);
    await engine.play();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      message: 'browser blocked playback; press play to retry',
    });
  });

  test('play rethrows unexpected errors', async () => {
    const element = new FakeMediaElement();
    element.play = async () => {
      throw new Error('something genuinely broken');
    };
    const engine = createEngine(element);
    await expect(engine.play()).rejects.toThrow('something genuinely broken');
  });
});

describe('subscribe / unsubscribe', () => {
  test('returned function detaches the listener', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events: EngineEvent[] = [];
    const off = engine.subscribe((e) => events.push(e));
    element.fire('playing');
    off();
    element.fire('pause');
    expect(events.map((e) => e.kind)).toEqual(['playing']);
  });
});

describe('release', () => {
  test('removes element listeners and clears src', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    engine.load(sampleSource);
    expect(element.registeredFor('playing')).toBe(1);
    engine.release();
    expect(element.registeredFor('playing')).toBe(0);
    expect(element.src).toBe('');
    expect(engine.currentSource).toBeNull();
  });

  test('emits no further events after release', () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.release();
    element.fire('playing');
    expect(events).toHaveLength(0);
  });

  test('rejects load and play after release', async () => {
    const element = new FakeMediaElement();
    const engine = createEngine(element);
    engine.release();
    expect(() => engine.load(sampleSource)).toThrow();
    await expect(engine.play()).rejects.toThrow();
  });
});
