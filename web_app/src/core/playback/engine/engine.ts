import type { PlaybackSource } from '../source/source';
import {
  isPlaybackDiagnosticsEnabled,
  recordPlaybackDiagnostic,
} from '../diagnostics/playbackDiagnostics';

/**
 * Playback engine adapter for `HTMLMediaElement`.
 *
 * The engine is the only place that directly touches `<audio>`/`<video>`.
 * It exposes a small imperative surface (`load`, `play`, `pause`, `seek`,
 * `release`) and re-emits the standard media events as a focused, sealed
 * `EngineEvent` so the session layer never has to know about the DOM.
 *
 * Engines do NOT own UI rendering, download tracking, progress sync, or
 * Android-specific concerns. Those live in their own modules and consume
 * the session, not the engine.
 */
export type EngineEvent =
  | { kind: 'loading' }
  | { kind: 'metadata'; durationSec: number }
  | { kind: 'canplay'; paused: boolean }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'waiting' }
  | { kind: 'seeking'; positionSec: number }
  | { kind: 'seeked'; positionSec: number }
  | { kind: 'stalled' }
  | { kind: 'progress' }
  | { kind: 'suspend' }
  | { kind: 'abort' }
  | { kind: 'time'; positionSec: number }
  | { kind: 'ended' }
  | { kind: 'error'; message: string };

export type EngineListener = (event: EngineEvent) => void;

export interface PlaybackEngine {
  load(source: PlaybackSource): void;
  play(): Promise<void>;
  pause(): void;
  seek(positionSec: number): void;
  release(): void;
  subscribe(listener: EngineListener): () => void;
  /** Current source, or null if nothing is loaded. Read-only convenience. */
  readonly currentSource: PlaybackSource | null;
}

/**
 * Minimal `HTMLMediaElement` surface the engine actually uses. Defining it
 * locally lets unit tests pass a hand-rolled fake instead of constructing
 * a real DOM element.
 */
export interface MediaElementLike {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  readyState?: number;
  networkState?: number;
  buffered?: TimeRanges;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Reads MediaError codes off an element if present and turns them into a
 * stable string. We avoid leaking the numeric code into the session layer
 * so the surface stays plain.
 */
function describeMediaError(element: MediaElementLike): string {
  const error = (element as unknown as { error?: { code?: number } | null })
    .error;
  if (!error || typeof error.code !== 'number') return 'media error';
  switch (error.code) {
    case 1:
      return 'aborted';
    case 2:
      return 'network error';
    case 3:
      return 'decoding error';
    case 4:
      return 'source not supported';
    default:
      return 'media error';
  }
}

const HANDLED_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'canplay',
  'playing',
  'pause',
  'waiting',
  'seeking',
  'seeked',
  'stalled',
  'progress',
  'suspend',
  'abort',
  'timeupdate',
  'ended',
  'error',
] as const;

export function createEngine(element: MediaElementLike): PlaybackEngine {
  const listeners = new Set<EngineListener>();
  let current: PlaybackSource | null = null;
  let released = false;
  let sourceGeneration = 0;
  let seekGeneration = 0;

  const finiteCurrentTime = () =>
    Number.isFinite(element.currentTime) ? element.currentTime : 0;

  const finiteDuration = () =>
    Number.isFinite(element.duration) ? element.duration : 0;

  const bufferedRanges = () => {
    const buffered = element.buffered;
    if (!buffered) return [];
    const ranges: Array<{ startSec: number; endSec: number }> = [];
    for (let index = 0; index < buffered.length; index += 1) {
      try {
        ranges.push({
          startSec: buffered.start(index),
          endSec: buffered.end(index),
        });
      } catch {
        // A media element can throw if ranges mutate while being read.
        return ranges;
      }
    }
    return ranges;
  };

  const record = (
    kind: string,
    extra: {
      previousPositionSec?: number | null;
      targetPositionSec?: number | null;
    } = {},
  ) => {
    if (!isPlaybackDiagnosticsEnabled()) return;
    recordPlaybackDiagnostic({
      kind,
      source: current,
      sourceGeneration,
      seekGeneration,
      positionSec: finiteCurrentTime(),
      durationSec: finiteDuration(),
      paused: element.paused,
      readyState:
        typeof element.readyState === 'number' ? element.readyState : null,
      networkState:
        typeof element.networkState === 'number' ? element.networkState : null,
      buffered: bufferedRanges(),
      ...extra,
    });
  };

  const emit = (event: EngineEvent) => {
    record(event.kind);
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  const handlers: Record<(typeof HANDLED_EVENTS)[number], () => void> = {
    loadstart: () => emit({ kind: 'loading' }),
    loadedmetadata: () => {
      const duration = Number.isFinite(element.duration) ? element.duration : 0;
      emit({ kind: 'metadata', durationSec: duration });
    },
    canplay: () => emit({ kind: 'canplay', paused: element.paused }),
    playing: () => emit({ kind: 'playing' }),
    pause: () => emit({ kind: 'paused' }),
    waiting: () => emit({ kind: 'waiting' }),
    seeking: () => emit({ kind: 'seeking', positionSec: finiteCurrentTime() }),
    seeked: () => emit({ kind: 'seeked', positionSec: finiteCurrentTime() }),
    stalled: () => emit({ kind: 'stalled' }),
    progress: () => emit({ kind: 'progress' }),
    suspend: () => emit({ kind: 'suspend' }),
    abort: () => emit({ kind: 'abort' }),
    timeupdate: () =>
      emit({
        kind: 'time',
        positionSec: finiteCurrentTime(),
      }),
    ended: () => emit({ kind: 'ended' }),
    error: () =>
      emit({ kind: 'error', message: describeMediaError(element) }),
  };

  for (const name of HANDLED_EVENTS) {
    element.addEventListener(name, handlers[name]);
  }

  return {
    get currentSource() {
      return current;
    },

    load(source) {
      if (released) {
        throw new Error('engine: cannot load on a released engine');
      }
      current = source;
      sourceGeneration += 1;
      seekGeneration = 0;
      record('load_request');
      element.src = source.url;
      element.load();
    },

    async play() {
      if (released) {
        throw new Error('engine: cannot play on a released engine');
      }
      record('play_request');
      try {
        await element.play();
      } catch (err) {
        // Browsers reject element.play() in two normal cases that the
        // session reports through other channels: AbortError when the
        // request is interrupted by a subsequent pause(), src change, or
        // the element being detached. Those are normal lifecycle events
        // the engine already surfaces through 'pause'/'error' events, so
        // swallow them here to avoid an unhandled promise rejection.
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // NotAllowedError, by contrast, means the browser blocked playback
        // (autoplay policy, user-gesture requirement, etc.). The session
        // must surface this so the UI can prompt the user to press play
        // explicitly. Translate it into an engine error event.
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          emit({
            kind: 'error',
            message: 'browser blocked playback; press play to retry',
          });
          return;
        }
        throw err;
      }
    },

    pause() {
      if (released) return;
      element.pause();
    },

    seek(positionSec) {
      if (released) return;
      if (!Number.isFinite(positionSec) || positionSec < 0) return;
      const previousPositionSec = finiteCurrentTime();
      seekGeneration += 1;
      record('seek_request', {
        previousPositionSec,
        targetPositionSec: positionSec,
      });
      element.currentTime = positionSec;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    release() {
      if (released) return;
      released = true;
      for (const name of HANDLED_EVENTS) {
        element.removeEventListener(name, handlers[name]);
      }
      listeners.clear();
      // Defensive: pause and clear src so the underlying element does not keep
      // buffering after we have detached. We do not call .load() here because
      // an element that was never set up does not need the extra work.
      try {
        element.pause();
      } catch {
        // ignore
      }
      element.src = '';
      current = null;
    },
  };
}
