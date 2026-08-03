import type {
  EngineEvent,
  EngineListener,
  PlaybackEngine,
} from '../../core/playback/engine/engine';
import {
  isPlaybackDiagnosticsEnabled,
  recordPlaybackDiagnostic,
} from '../../core/playback/diagnostics/playbackDiagnostics';
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
    readonly buffered?: TimeRanges;
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
  resumeTargetActive: boolean;
  resumeTargetReached: boolean;
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
  let sourceGeneration = 0;
  let seekGeneration = 0;
  let pendingInternalSeekTargetSec: number | null = null;
  let released = false;

  const nativeMedia = () =>
    (
      player as unknown as {
        provider?: { media?: HTMLMediaElement } | null;
      }
    ).provider?.media ?? null;

  const bufferedRanges = () => {
    const ranges = nativeMedia()?.buffered ?? player.state.buffered;
    if (ranges === undefined) return [];
    const result: Array<{ startSec: number; endSec: number }> = [];
    for (let index = 0; index < ranges.length; index += 1) {
      try {
        result.push({
          startSec: ranges.start(index),
          endSec: ranges.end(index),
        });
      } catch {
        return result;
      }
    }
    return result;
  };

  const record = (
    kind: string,
    extra: {
      previousPositionSec?: number | null;
      targetPositionSec?: number | null;
    } = {},
  ) => {
    if (!isPlaybackDiagnosticsEnabled()) return;
    const media = nativeMedia();
    recordPlaybackDiagnostic({
      kind,
      source: current,
      sourceGeneration,
      seekGeneration,
      positionSec: finiteSeconds(player.currentTime),
      durationSec: finiteSeconds(player.duration),
      paused: player.paused,
      readyState: media?.readyState ?? null,
      networkState: media?.networkState ?? null,
      buffered: bufferedRanges(),
      ...extra,
    });
  };

  const maybeRecordResumeTargetReached = (event: EngineEvent) => {
    const generation = activeGeneration;
    if (
      generation === null ||
      !generation.resumeTargetActive ||
      generation.resumeTargetReached
    ) {
      return;
    }
    if (event.kind !== 'time' && event.kind !== 'playing') return;
    const targetPositionSec = mediaFragmentStartSec(generation.source);
    if (targetPositionSec <= 0) return;
    const positionSec =
      'positionSec' in event
        ? finiteSeconds(event.positionSec)
        : finiteSeconds(player.currentTime);
    if (positionSec < targetPositionSec - 0.5) return;
    generation.resumeTargetReached = true;
    generation.resumeTargetActive = false;
    pendingInternalSeekTargetSec = null;
    record('resume_target_reached', { targetPositionSec });
  };

  const emit = (event: EngineEvent) => {
    record(event.kind);
    maybeRecordResumeTargetReached(event);
    for (const listener of [...listeners]) listener(event);
  };

  const activeGenerationAcceptsSourceEvent = (eventName: string) => {
    const generation = activeGeneration;
    if (generation === null) return true;
    const currentURL = vidstackSourceURL(player.currentSrc);
    const accepted =
      currentURL !== ''
        ? sourceURLsMatch(currentURL, generation.source.url)
        : generation.sourceObserved;
    if (!accepted) record(`stale_${eventName}_ignored`);
    return accepted;
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
  const applyGenerationStart = (
    generation: SourceGeneration,
    reason: 'before_play' | 'after_play',
  ) => {
    if (!generation.resumeTargetActive) return;
    const startSec = mediaFragmentStartSec(generation.source);
    if (startSec <= 0) return;
    const previousPositionSec = finiteSeconds(player.currentTime);
    if (previousPositionSec > startSec + 0.5) {
      generation.resumeTargetReached = true;
      generation.resumeTargetActive = false;
      pendingInternalSeekTargetSec = null;
      record(`resume_target_consumed_${reason}`, {
        previousPositionSec,
        targetPositionSec: startSec,
      });
      return;
    }
    if (
      reason === 'after_play' &&
      previousPositionSec < startSec - 0.5 &&
      previousPositionSec > 1 &&
      previousPositionSec >= startSec - 2
    ) {
      record('resume_target_after_play_kept_position', {
        previousPositionSec,
        targetPositionSec: startSec,
      });
      return;
    }
    if (Math.abs(previousPositionSec - startSec) > 0.5) {
      seekGeneration += 1;
      record(`resume_target_apply_${reason}`, {
        previousPositionSec,
        targetPositionSec: startSec,
      });
      pendingInternalSeekTargetSec = startSec;
      player.currentTime = startSec;
      record(`resume_target_applied_${reason}`, {
        previousPositionSec,
        targetPositionSec: startSec,
      });
      return;
    }
    record(`resume_target_already_applied_${reason}`, {
      previousPositionSec,
      targetPositionSec: startSec,
    });
  };

  const handlers: Record<string, EventListener> = {
    'load-start': () => {
      record('load-start');
      emit({ kind: 'loading' });
    },
    'loaded-metadata': (event) => {
      record('loaded-metadata');
      emitDuration(
        finiteSeconds(
          eventDetailNumber(event, 'duration') ?? player.duration,
        ),
      );
    },
    'duration-change': (event) => {
      record('duration-change');
      emitDuration(
        finiteSeconds(
          eventDetailNumber(event, 'duration') ?? player.duration,
        ),
      );
    },
    'source-change': (event) => {
      const generation = activeGeneration;
      if (generation === null) return;
      const sourceURL = vidstackSourceURL(
        (event as CustomEvent<unknown>).detail,
      );
      if (sourceURLsMatch(sourceURL, generation.source.url)) {
        generation.sourceObserved = true;
        record('source-change');
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
        record('can-play');
        generation.settleReady(true);
      }
      emit({ kind: 'canplay', paused: player.paused });
    },
    playing: () => {
      if (!activeGenerationAcceptsSourceEvent('playing')) return;
      emit({ kind: 'playing' });
    },
    pause: () => {
      if (!activeGenerationAcceptsSourceEvent('pause')) return;
      emit({ kind: 'paused' });
    },
    waiting: () => {
      if (!activeGenerationAcceptsSourceEvent('waiting')) return;
      emit({ kind: 'waiting' });
    },
    seeking: () => {
      if (!activeGenerationAcceptsSourceEvent('seeking')) return;
      const positionSec = finiteSeconds(player.currentTime);
      const generation = activeGeneration;
      const internalTargetSec = pendingInternalSeekTargetSec;
      const isInternalSeek =
        internalTargetSec !== null &&
        Math.abs(positionSec - internalTargetSec) <= 0.5;
      pendingInternalSeekTargetSec = null;
      if (generation !== null && generation.resumeTargetActive) {
        const resumeTargetSec = mediaFragmentStartSec(generation.source);
        if (
          !isInternalSeek &&
          resumeTargetSec > 0 &&
          Math.abs(positionSec - resumeTargetSec) > 0.5
        ) {
          generation.resumeTargetActive = false;
          record('resume_target_canceled_native_seek', {
            previousPositionSec: null,
            targetPositionSec: positionSec,
          });
        } else if (isInternalSeek) {
          record('resume_target_internal_seeking', {
            targetPositionSec: positionSec,
          });
        }
      }
      emit({ kind: 'seeking', positionSec });
    },
    seeked: () => {
      if (!activeGenerationAcceptsSourceEvent('seeked')) return;
      emit({ kind: 'seeked', positionSec: finiteSeconds(player.currentTime) });
    },
    stalled: () => {
      if (!activeGenerationAcceptsSourceEvent('stalled')) return;
      emit({ kind: 'stalled' });
    },
    progress: () => {
      if (!activeGenerationAcceptsSourceEvent('progress')) return;
      emit({ kind: 'progress' });
    },
    suspend: () => {
      if (!activeGenerationAcceptsSourceEvent('suspend')) return;
      emit({ kind: 'suspend' });
    },
    abort: () => {
      if (!activeGenerationAcceptsSourceEvent('abort')) return;
      emit({ kind: 'abort' });
    },
    'time-change': (event) => {
      if (!activeGenerationAcceptsSourceEvent('time-change')) return;
      emitTime(event, 'currentTime');
    },
    'time-update': (event) => {
      if (!activeGenerationAcceptsSourceEvent('time-update')) return;
      emitTime(event, 'currentTime');
    },
    ended: () => {
      if (!activeGenerationAcceptsSourceEvent('ended')) return;
      emit({ kind: 'ended' });
    },
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
      sourceGeneration += 1;
      seekGeneration = 0;
      pendingInternalSeekTargetSec = null;
      lastDurationSec = 0;
      lastTimePositionSec = null;
      record('load_request', {
        targetPositionSec: mediaFragmentStartSec(source) || null,
      });
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
        resumeTargetActive: true,
        resumeTargetReached: false,
        settleReady(readyValue) {
          if (settled) return;
          settled = true;
          finishReady(readyValue);
        },
      };
      activeGeneration = generation;
      void generation.commit.then(() => {
        if (!released && activeGeneration === generation) {
          record('source_commit');
          player.startLoading();
          record('start_loading');
        }
      });
    },

    async play() {
      if (released) {
        throw new Error('vidstack engine: cannot play on a released engine');
      }
      record('play_request');
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
      applyGenerationStart(generation, 'before_play');
      try {
        await player.play();
        if (!released && activeGeneration === generation) {
          applyGenerationStart(generation, 'after_play');
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
      const previousPositionSec = finiteSeconds(player.currentTime);
      seekGeneration += 1;
      pendingInternalSeekTargetSec = null;
      const generation = activeGeneration;
      const resumeTargetSec =
        generation === null ? 0 : mediaFragmentStartSec(generation.source);
      if (
        generation !== null &&
        generation.resumeTargetActive &&
        resumeTargetSec > 0 &&
        Math.abs(positionSec - resumeTargetSec) > 0.5
      ) {
        generation.resumeTargetActive = false;
        record('resume_target_canceled_manual_seek', {
          previousPositionSec,
          targetPositionSec: positionSec,
        });
      } else if (
        generation !== null &&
        generation.resumeTargetActive &&
        resumeTargetSec > 0
      ) {
        record('resume_target_immediate_seek', {
          previousPositionSec,
          targetPositionSec: positionSec,
        });
      }
      record('seek_request', {
        previousPositionSec,
        targetPositionSec: positionSec,
      });
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
      pendingInternalSeekTargetSec = null;
      void player.pause();
      current = null;
    },
  };
}
