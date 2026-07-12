import type {
  EngineEvent,
  EngineListener,
  PlaybackEngine,
} from '../../core/playback/engine/engine';
import type { PlaybackSource } from '../../core/playback/source/source';

export interface VidstackPlayerLike extends EventTarget {
  readonly el: HTMLElement | null;
  readonly duration: number;
  readonly paused: boolean;
  readonly currentSrc?: unknown;
  currentTime: number;
  volume: number;
  muted: boolean;
  readonly state: {
    readonly error?: { code?: number; message?: string } | null;
  };
  play(): Promise<void>;
  pause(): Promise<void>;
  startLoading(): void;
}

type CommitSource = (source: PlaybackSource | null) => Promise<void>;

interface SourceGeneration {
  readonly source: PlaybackSource;
  readonly commit: Promise<void>;
  readonly ready: Promise<boolean>;
  sourceObserved: boolean;
  settleReady(ready: boolean): void;
}

function vidstackSourceURL(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'src' in value &&
    typeof value.src === 'string'
  ) {
    return value.src;
  }
  return '';
}

function sourceURLsMatch(currentURL: string, expectedURL: string): boolean {
  if (currentURL === expectedURL) return true;
  try {
    const baseURL =
      typeof window === 'undefined'
        ? 'http://localhost/'
        : window.location.href;
    const current = new URL(currentURL, baseURL);
    const expected = new URL(expectedURL, baseURL);
    current.hash = '';
    expected.hash = '';
    return current.href === expected.href;
  } catch {
    return false;
  }
}

function mediaFragmentStartSec(source: PlaybackSource): number {
  try {
    const baseURL =
      typeof window === 'undefined'
        ? 'http://localhost/'
        : window.location.href;
    const url = new URL(source.url, baseURL);
    const match = /^t=([0-9]+(?:\.[0-9]+)?)$/.exec(url.hash.slice(1));
    if (match === null) return 0;
    const startSec = Number(match[1]);
    return Number.isFinite(startSec) && startSec > 0 ? startSec : 0;
  } catch {
    return 0;
  }
}

function describeVidstackError(player: VidstackPlayerLike): string {
  const error = player.state.error;
  if (error?.message) return error.message;
  switch (error?.code) {
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

function eventDetailNumber(event: Event, key: string): number | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail === 'number') return detail;
  if (
    typeof detail === 'object' &&
    detail !== null &&
    key in detail &&
    typeof (detail as Record<string, unknown>)[key] === 'number'
  ) {
    return (detail as Record<string, number>)[key];
  }
  return null;
}

function finiteSeconds(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Vidstack-native video engine. Vidstack owns the provider and controls; this
 * adapter only projects its commands/events onto the app's shared playback
 * session contract.
 */
export function createVidstackEngine(
  player: VidstackPlayerLike,
  commitSource: CommitSource,
): PlaybackEngine {
  const listeners = new Set<EngineListener>();
  let current: PlaybackSource | null = null;
  let activeGeneration: SourceGeneration | null = null;
  let lastDurationSec = 0;
  let lastTimePositionSec: number | null = null;
  let released = false;

  const emit = (event: EngineEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const emitDuration = (durationSec: number) => {
    if (durationSec <= 0 || durationSec === lastDurationSec) return;
    lastDurationSec = durationSec;
    emit({ kind: 'metadata', durationSec });
  };

  const emitCurrentDuration = () => {
    const durationSec = finiteSeconds(player.duration);
    if (durationSec <= 0) return;
    emitDuration(durationSec);
  };

  const emitTime = (event: Event, detailKey: string) => {
    emitCurrentDuration();
    const positionSec = finiteSeconds(
      eventDetailNumber(event, detailKey) ??
        eventDetailNumber(event, 'time') ??
        player.currentTime,
    );
    if (positionSec === lastTimePositionSec) return;
    lastTimePositionSec = positionSec;
    emit({
      kind: 'time',
      positionSec,
    });
  };
  const applyGenerationStart = (generation: SourceGeneration) => {
    const startSec = mediaFragmentStartSec(generation.source);
    if (
      startSec > 0 &&
      Math.abs(finiteSeconds(player.currentTime) - startSec) > 0.5
    ) {
      player.currentTime = startSec;
    }
  };

  const handlers: Record<string, EventListener> = {
    'load-start': () => emit({ kind: 'loading' }),
    'loaded-metadata': (event) =>
      emitDuration(
        finiteSeconds(
          eventDetailNumber(event, 'duration') ?? player.duration,
        ),
      ),
    'duration-change': (event) =>
      emitDuration(
        finiteSeconds(
          eventDetailNumber(event, 'duration') ?? player.duration,
        ),
      ),
    'source-change': (event) => {
      const generation = activeGeneration;
      if (generation === null) return;
      const sourceURL = vidstackSourceURL(
        (event as CustomEvent<unknown>).detail,
      );
      if (sourceURLsMatch(sourceURL, generation.source.url)) {
        generation.sourceObserved = true;
      }
    },
    'can-play': () => {
      const generation = activeGeneration;
      if (generation !== null) {
        const currentURL = vidstackSourceURL(player.currentSrc);
        if (
          currentURL !== '' &&
          !sourceURLsMatch(currentURL, generation.source.url)
        ) {
          return;
        }
        if (currentURL === '' && !generation.sourceObserved) return;
        generation.settleReady(true);
      }
      emit({ kind: 'canplay', paused: player.paused });
    },
    playing: () => emit({ kind: 'playing' }),
    pause: () => emit({ kind: 'paused' }),
    waiting: () => emit({ kind: 'waiting' }),
    'time-change': (event) => emitTime(event, 'currentTime'),
    'time-update': (event) => emitTime(event, 'currentTime'),
    ended: () => emit({ kind: 'ended' }),
    error: () => {
      const generation = activeGeneration;
      if (generation !== null) {
        const currentURL = vidstackSourceURL(player.currentSrc);
        if (
          currentURL !== '' &&
          !sourceURLsMatch(currentURL, generation.source.url)
        ) {
          return;
        }
        generation.settleReady(false);
      }
      emit({ kind: 'error', message: describeVidstackError(player) });
    },
  };

  for (const [name, handler] of Object.entries(handlers)) {
    player.addEventListener(name, handler);
  }

  return {
    get currentSource() {
      return current;
    },

    load(source) {
      if (released) {
        throw new Error('vidstack engine: cannot load on a released engine');
      }
      activeGeneration?.settleReady(false);
      current = source;
      lastDurationSec = 0;
      lastTimePositionSec = null;
      let finishReady = (_ready: boolean) => {};
      let settled = false;
      const ready = new Promise<boolean>((resolve) => {
        finishReady = resolve;
      });
      const generation: SourceGeneration = {
        source,
        commit: commitSource(source),
        ready,
        sourceObserved: false,
        settleReady(readyValue) {
          if (settled) return;
          settled = true;
          finishReady(readyValue);
        },
      };
      activeGeneration = generation;
      void generation.commit.then(() => {
        if (!released && activeGeneration === generation) {
          player.startLoading();
        }
      });
    },

    async play() {
      if (released) {
        throw new Error('vidstack engine: cannot play on a released engine');
      }
      const generation = activeGeneration;
      if (generation === null) return;
      await generation.commit;
      if (released || activeGeneration !== generation) {
        return;
      }
      const ready = await generation.ready;
      if (!ready || released || activeGeneration !== generation) {
        return;
      }
      applyGenerationStart(generation);
      try {
        await player.play();
        if (!released && activeGeneration === generation) {
          applyGenerationStart(generation);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
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
      void player.pause();
    },

    seek(positionSec) {
      if (
        released ||
        !Number.isFinite(positionSec) ||
        positionSec < 0
      ) {
        return;
      }
      player.currentTime = positionSec;
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
      for (const [name, handler] of Object.entries(handlers)) {
        player.removeEventListener(name, handler);
      }
      listeners.clear();
      activeGeneration?.settleReady(false);
      activeGeneration = null;
      void player.pause();
      current = null;
    },
  };
}
