import { create } from 'zustand';

import {
  createSession,
  type PlaybackSession,
  type PlaybackState,
} from '../../core/playback/session/session';
import { PLAYBACK_PROGRESS_THROTTLE_MS } from '../../core/playback/playbackPolicy';
import {
  createEngine,
  type MediaElementLike,
  type PlaybackEngine,
} from '../../core/playback/engine/engine';
import {
  recordPlaybackDiagnosticMilestone,
} from '../../core/playback/diagnostics/playbackDiagnostics';
import {
  playbackNetworkGate,
  type PlaybackNetworkGate,
} from '../../core/playback/networkGate/playbackNetworkGate';
import { contentIdentityForPlaybackSource } from '../../core/media/contentIdentity';
import type { PlaybackSource } from '../../core/playback/source/source';
import {
  buildStreamingUrl,
} from '../../core/playback/source/source';
import {
  createLocalStorageLikedTracksRepository,
  type LikedTracksRepository,
} from '../../core/storage/likedTracksRepository';
import {
  createLocalStoragePlaybackActivityRepository,
  type PlaybackActivityRecord,
  type PlaybackActivityRepository,
  type PlaybackActivitySource,
} from '../../core/storage/playbackActivityRepository';
import {
  createLocalStoragePlaybackPreferencesRepository,
  type PlaybackPreferencesRepository,
} from '../../core/storage/playbackPreferencesRepository';
import type {
  ProgressService,
  ProgressServiceAttachment,
} from '../progress/progressService';
import type { AudioResumeCacheService } from './audioResumeCacheService';
import type { VideoOptimizationService } from './videoOptimizationService';
import { restoreOriginalVideoSource } from './videoOptimizationService';
import {
  buildMusicQueue,
  clearQueueTracks,
  currentQueueTrack,
  explicitNextQueueIndex,
  findQueueTrackIndex,
  insertQueueTrackAfterCurrent,
  moveQueueTrackNext,
  moveQueueTrack as moveQueueTrackInQueue,
  nextQueueIndex,
  nextRepeatMode,
  previousQueueIndex,
  queueTrackKey,
  removeQueueTrack as removeQueueTrackFromQueue,
  shuffleQueueKeepingCurrent,
  type QueueMoveDirection,
  type RepeatMode,
} from './musicQueue';

/**
 * The web app keeps two independent playback sessions: one for audio and one
 * for video. The split lives at this layer (and not inside core/playback)
 * because element ownership is a UI concern: audio rides a hidden, always-
 * mounted `<audio>` element so it can survive route changes, while video uses
 * a persistent Vidstack engine whose portal root moves between a hidden
 * parking host and the full player viewport.
 *
 * The store also tracks the active media kind so the rest of the UI can ask
 * "is anything playing?" without poking at the lower-level state shape.
 */
export type ActiveKind = 'audio' | 'video' | null;

export interface PlayerSnapshot {
  audio: PlaybackState;
  video: PlaybackState;
  active: ActiveKind;
}

export type SleepTimerState =
  | { kind: 'off' }
  | {
      kind: 'running';
      durationSec: number;
      remainingSec: number;
      endsAtMs: number;
    }
  | { kind: 'expired' };

const initialPlayback: PlaybackState = {
  status: { kind: 'idle' },
  source: null,
  positionSec: 0,
  durationSec: 0,
};

export interface PlayerState extends PlayerSnapshot {
  sleepTimer: SleepTimerState;
  stopAfterCurrent: boolean;
  volume: number;
  muted: boolean;
  musicQueue: PlaybackSource[];
  musicQueueIndex: number;
  shuffle: boolean;
  shuffleBaseQueue: PlaybackSource[] | null;
  repeatMode: RepeatMode;
  likedMediaIds: string[];
  recentlyPlayed: PlaybackSource[];
  activityRecords: PlaybackActivityRecord[];
  /** Wire (or rewire) a real media element for the given kind. */
  attachElement(kind: 'audio' | 'video', element: MediaElementLike): void;
  /** Wire a player-owned engine, used by Vidstack video playback. */
  attachEngine(
    kind: 'audio' | 'video',
    engine: PlaybackEngine,
    target: PlaybackTarget,
  ): void;
  /** Detach the element for the given kind and dispose its session. If
   *  expectedElement is provided, the detach is skipped when the slot has
   *  already been re-attached to a different element (the StrictMode
   *  double-invoke case). */
  detachElement(kind: 'audio' | 'video', expectedElement?: MediaElementLike): void;
  detachEngine(kind: 'audio' | 'video', expectedEngine?: PlaybackEngine): void;
  /** Load a source on the appropriate session and start playback. */
  playSource(source: PlaybackSource): Promise<void>;
  prefetchVideoOptimization(mediaId: string): void;
  /** Replace the music queue, select a track, and start audio playback. */
  playMusicQueue(sources: PlaybackSource[], startMediaId: string): Promise<void>;
  /** Insert a library audio source after the current Queue item and play it. */
  insertQueueItemAfterCurrentAndPlay(source: PlaybackSource): Promise<void>;
  /**
   * Seeds the active slot with a source without starting playback. Used at
   * boot to surface a "Continue" mini-player based on the most recent
   * progress record. The next user-driven playSource overrides this seed.
   */
  seedSource(
    source: PlaybackSource,
    savedState?: { positionSec?: number; durationSec?: number },
  ): void;
  /**
   * Loads a boot-time seed into an already attached session without starting
   * playback. Video calls this only after the visible viewport exists, so the
   * mini-player seed still avoids unsolicited network work on plain app boot.
   */
  prepareSeededSource(kind: 'audio' | 'video'): void;
  togglePlayPause(): Promise<void>;
  retryActivePlayback(): Promise<void>;
  pauseActive(): void;
  seekActive(positionSec: number): void;
  /** Start a sleep timer in minutes. Expiry pauses the active session. */
  startSleepTimer(minutes: number): void;
  cancelSleepTimer(): void;
  toggleStopAfterCurrent(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeatMode(): void;
  toggleLike(mediaId: string): void;
  refreshActivity(): void;
  /** Persist the latest audio/video activity positions immediately. */
  flushActivity(): void;
  exportPlaybackActivity(): string;
  importPlaybackActivity(data: unknown): boolean;
  playQueueItem(mediaId: string): Promise<void>;
  playQueueTrack(trackKey: string): Promise<void>;
  playPreviousQueueItem(): Promise<void>;
  playNextQueueItem(): Promise<void>;
  playQueueItemNext(mediaId: string): void;
  playQueueTrackNext(trackKey: string): void;
  removeQueueItem(mediaId: string): void;
  removeQueueTrack(trackKey: string): void;
  clearMusicQueue(): void;
  moveQueueItem(mediaId: string, direction: QueueMoveDirection): void;
  moveQueueTrack(trackKey: string, direction: QueueMoveDirection): void;
  /** Test/factory hook: replace a session implementation directly. */
  setSessionForTests(kind: 'audio' | 'video', session: PlaybackSession | null): void;
}

export interface PlaybackTarget {
  readonly isConnected?: boolean;
  volume?: number;
  muted?: boolean;
}

interface MountSlot {
  session: PlaybackSession | null;
  engine: PlaybackEngine | null;
  unsubscribe: (() => void) | null;
  element: PlaybackTarget | null;
  /**
   * Source the user asked to play before any element was attached. The next
   * attachElement on this kind picks it up and starts playback. Still useful
   * for tests and startup races where a play request arrives before a mount.
   */
  pendingPlay: PlaybackSource | null;
  /**
   * Lifecycle handle returned by progressService.attach, when one is wired.
   * Disposing it flushes the last position to storage and detaches the
   * service before the engine itself is released.
   */
  progressAttachment: ProgressServiceAttachment | null;
  /**
   * Boot-time "continue" candidate. Unlike a parking-lot source, this stays
   * unloaded during plain app boot; visible video can prepare it later without
   * autoplay so native controls still receive the resume URL.
   */
  seededSource: PlaybackSource | null;
  seededState: { positionSec: number; durationSec: number } | null;
  /**
   * True after a visible video viewport preloads a boot-time seed without
   * user playback. Until the first real play, replacing/detaching this source
   * must not promote it to "last played".
   */
  preparedSeed: boolean;
  seedPreparationGeneration: number;
  seedPreparationPending: boolean;
  optimizationFallbackInProgress: boolean;
  endStartupGate: (() => void) | null;
  endSeekGate: (() => void) | null;
  seekTargetSec: number | null;
  seekStartedMediaPositionSeq: number;
}

/**
 * Returns true if the element is currently part of the live DOM tree.
 * Detached elements (route unmounts that did not call detachElement) are
 * still reachable through closure, but their src changes never reach a
 * visible video frame and they should be treated as missing.
 */
function isElementConnected(element: PlaybackTarget): boolean {
  const node = element as { isConnected?: boolean };
  if (typeof node.isConnected === 'boolean') return node.isConnected;
  // Fake elements in unit tests should set isConnected explicitly. We
  // default to true here because attach paths in production always run
  // immediately after the DOM mounts the element; tests that mean to
  // simulate a detached element override the field on the fake.
  return true;
}

/**
 * A no-op session that remembers the last loaded source so a detached slot
 * can hand its selection to the next attached element. It never produces
 * playback events; the next real session is responsible for picking up the
 * source via session.load().
 */
function createParkingLotSession(initial: PlaybackState): PlaybackSession {
  let state: PlaybackState = {
    status: { kind: 'idle' },
    source: initial.source,
    positionSec: initial.positionSec,
    durationSec: initial.durationSec,
  };
  return {
    getState: () => state,
    subscribe: () => () => {},
    load(next) {
      state = {
        status: { kind: 'idle' },
        source: next,
        positionSec: 0,
        durationSec: 0,
      };
    },
    play: async () => {},
    pause: () => {},
    seek: () => {},
    dispose: () => {},
  };
}

export interface PlayerStoreOptions {
  /** Override session construction in tests. */
  createSession?: (engine: PlaybackEngine) => PlaybackSession;
  /** Override engine construction in tests. */
  createEngine?: (element: MediaElementLike) => PlaybackEngine;
  /** Optional progress service. When provided each session is attached on
   *  creation and disposed before its engine is released. Pass null to
   *  disable progress entirely (default). */
  progressService?: ProgressService | null;
  /** Optional single-slot server cache used to accelerate AAC resume. */
  audioResumeCache?: AudioResumeCacheService | null;
  /** Explicit single-slot faststart sidecar selector for direct-play video. */
  videoOptimization?: VideoOptimizationService | null;
  /** Test hook for deterministic sleep-timer behavior. */
  now?: () => number;
  setInterval?: (handler: () => void, timeoutMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  likedRepository?: LikedTracksRepository | null;
  activityRepository?: PlaybackActivityRepository | null;
  preferencesRepository?: PlaybackPreferencesRepository | null;
  activityProgressThrottleMs?: number;
  random?: () => number;
  networkGate?: PlaybackNetworkGate;
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}

function applyElementPreferences(
  element: PlaybackTarget,
  volume: number,
  muted: boolean,
) {
  element.volume = clampVolume(volume);
  element.muted = muted;
}

function addRecentlyPlayed(
  list: readonly PlaybackSource[],
  source: PlaybackSource,
): PlaybackSource[] {
  return [
    source,
    ...list.filter((item) => item.mediaId !== source.mediaId),
  ].slice(0, 8);
}

function playbackSourceWithoutQueueEntry(source: PlaybackSource): PlaybackSource {
  if (source.queueEntryId === undefined) return source;
  const { queueEntryId: _queueEntryId, ...playbackSource } = source;
  return playbackSource;
}

function playbackSourceWithResumePosition(
  source: PlaybackSource,
  positionSec: number,
): PlaybackSource {
  if (!Number.isFinite(positionSec) || positionSec <= 0) return source;
  return {
    ...source,
    url: buildStreamingUrl(source.mediaId, { startSec: positionSec }),
  };
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

function samePlaybackSource(
  left: PlaybackSource | null,
  right: PlaybackSource | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.mediaType === right.mediaType &&
    left.mediaId === right.mediaId &&
    left.url === right.url
  );
}

function samePlaybackMedia(
  left: PlaybackSource | null,
  right: PlaybackSource | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.mediaType === right.mediaType &&
    left.mediaId === right.mediaId
  );
}

function activitySourceFromPlaybackSource(
  source: PlaybackSource,
): PlaybackActivitySource {
  const identity = contentIdentityForPlaybackSource(source);
  return {
    contentKey: identity.key,
    mediaId: source.mediaId,
    mediaType: source.mediaType,
    name: source.name,
    artist: identity.artist,
  };
}

export function createPlayerStore(options: PlayerStoreOptions = {}) {
  const sessionFactory = options.createSession ?? createSession;
  const engineFactory = options.createEngine ?? createEngine;
  const progressService = options.progressService ?? null;
  const audioResumeCache = options.audioResumeCache ?? null;
  const videoOptimization = options.videoOptimization ?? null;
  const likedRepository =
    options.likedRepository === undefined
      ? createLocalStorageLikedTracksRepository()
      : options.likedRepository;
  const activityRepository =
    options.activityRepository === undefined
      ? createLocalStoragePlaybackActivityRepository()
      : options.activityRepository;
  const preferencesRepository = options.preferencesRepository === undefined
    ? createLocalStoragePlaybackPreferencesRepository()
    : options.preferencesRepository;
  const initialPreferences = preferencesRepository?.read() ?? {
    volume: 1,
    muted: false,
    shuffle: false,
    repeatMode: 'none' as const,
  };
  const persistPreferences = (preferences: {
    volume: number;
    muted: boolean;
    shuffle: boolean;
    repeatMode: RepeatMode;
  }) => preferencesRepository?.write(preferences);
  const configuredActivityThrottleMs =
    options.activityProgressThrottleMs ?? PLAYBACK_PROGRESS_THROTTLE_MS;
  const activityProgressThrottleMs = Number.isFinite(
    configuredActivityThrottleMs,
  )
    ? Math.max(0, configuredActivityThrottleMs)
    : PLAYBACK_PROGRESS_THROTTLE_MS;
  const random = options.random ?? Math.random;
  const networkGate = options.networkGate ?? playbackNetworkGate;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn =
    options.setInterval ??
    ((handler: () => void, timeoutMs: number) =>
      globalThis.setInterval(handler, timeoutMs));
  const clearIntervalFn =
    options.clearInterval ??
    ((handle: unknown) =>
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  let sleepTimerHandle: unknown = null;
  let queueEntryCounter = 0;
  const lastActivityProgress = {
    audio: {
      contentKey: '',
      writtenAtMs: Number.NEGATIVE_INFINITY,
      positionSec: 0,
      durationSec: 0,
      completed: false,
    },
    video: {
      contentKey: '',
      writtenAtMs: Number.NEGATIVE_INFINITY,
      positionSec: 0,
      durationSec: 0,
      completed: false,
    },
  };

  const slots: Record<'audio' | 'video', MountSlot> = {
    audio: {
      session: null,
      engine: null,
      unsubscribe: null,
      element: null,
      pendingPlay: null,
      progressAttachment: null,
      seededSource: null,
      seededState: null,
      preparedSeed: false,
      seedPreparationGeneration: 0,
      seedPreparationPending: false,
      optimizationFallbackInProgress: false,
      endStartupGate: null,
      endSeekGate: null,
      seekTargetSec: null,
      seekStartedMediaPositionSeq: 0,
    },
    video: {
      session: null,
      engine: null,
      unsubscribe: null,
      element: null,
      pendingPlay: null,
      progressAttachment: null,
      seededSource: null,
      seededState: null,
      preparedSeed: false,
      seedPreparationGeneration: 0,
      seedPreparationPending: false,
      optimizationFallbackInProgress: false,
      endStartupGate: null,
      endSeekGate: null,
      seekTargetSec: null,
      seekStartedMediaPositionSeq: 0,
    },
  };

  return create<PlayerState>((set, get) => {
    const withQueueEntry = (source: PlaybackSource): PlaybackSource => ({
      ...source,
      queueEntryId:
        source.queueEntryId ??
        `queue-${++queueEntryCounter}-${source.mediaId}`,
    });
    const withQueueEntries = (sources: readonly PlaybackSource[]) =>
      sources.map(withQueueEntry);
    const projectFromSlot = (kind: 'audio' | 'video'): PlaybackState => {
      const slot = slots[kind];
      const state = slot.session ? slot.session.getState() : initialPlayback;
      if (state.source !== null) return state;
      if (slot.pendingPlay !== null) {
        return {
          status: { kind: 'loading' },
          source: slot.pendingPlay,
          positionSec: 0,
          durationSec: 0,
        };
      }
      if (slot.seededSource === null) return state;
      return {
        status: { kind: 'idle' },
        source: slot.seededSource,
        positionSec: slot.seededState?.positionSec ?? 0,
        durationSec:
          slot.seededState?.durationSec ??
          (typeof slot.seededSource.durationSec === 'number'
            ? slot.seededSource.durationSec
            : 0),
      };
    };

    const recomputeActive = (state: PlayerSnapshot): ActiveKind => {
      const audioActive = state.audio.source !== null;
      const videoActive = state.video.source !== null;
      if (state.active === 'audio' && audioActive) return 'audio';
      if (state.active === 'video' && videoActive) return 'video';
      if (audioActive) return 'audio';
      if (videoActive) return 'video';
      return null;
    };

    const sync = () => {
      set((prev) => {
        const next: PlayerSnapshot = {
          audio: projectFromSlot('audio'),
          video: projectFromSlot('video'),
          active: prev.active,
        };
        next.active = recomputeActive(next);
        return next;
      });
    };

    const closeStartupGate = (slot: MountSlot) => {
      slot.endStartupGate?.();
      slot.endStartupGate = null;
    };

    const closeSeekGate = (slot: MountSlot) => {
      slot.endSeekGate?.();
      slot.endSeekGate = null;
      slot.seekTargetSec = null;
      slot.seekStartedMediaPositionSeq = 0;
    };

    const beginAudioStartupGate = (slot: MountSlot, sourceId: string) => {
      closeStartupGate(slot);
      slot.endStartupGate = networkGate.beginAudioStartup(sourceId);
    };

    const beginAudioSeekGate = (
      slot: MountSlot,
      sourceId: string,
      targetSec: number,
    ) => {
      closeSeekGate(slot);
      slot.seekStartedMediaPositionSeq =
        slot.session?.getState().mediaPositionUpdateSeq ?? 0;
      slot.seekTargetSec = targetSec;
      slot.endSeekGate = networkGate.beginAudioSeek(sourceId, targetSec);
    };

    const updateAudioGateState = (state: PlaybackState) => {
      const slot = slots.audio;
      if (slot.endStartupGate !== null) {
        if (
          state.status.kind === 'playing' ||
          state.status.kind === 'paused' ||
          state.status.kind === 'ended' ||
          state.status.kind === 'error'
        ) {
          closeStartupGate(slot);
        }
      }
      if (slot.endSeekGate !== null) {
        const target = slot.seekTargetSec;
        if (
          state.status.kind === 'error' ||
          state.status.kind === 'ended' ||
          (target !== null &&
            state.status.kind === 'playing' &&
            (state.mediaPositionUpdateSeq ?? 0) >
              slot.seekStartedMediaPositionSeq &&
            Math.abs(state.positionSec - target) < 1)
        ) {
          closeSeekGate(slot);
        }
      }
    };

    const playSourceOnSlot = async (
      source: PlaybackSource,
      options: { skipVideoOptimization?: boolean } = {},
    ) => {
      const targetKind = source.mediaType;
      const otherKind = targetKind === 'audio' ? 'video' : 'audio';
      const slot = slots[targetKind];
      let playbackSource = playbackSourceWithoutQueueEntry(source);
      if (
        slot.seededSource !== null &&
        slot.seededSource.mediaId === playbackSource.mediaId &&
        slot.seededSource.mediaType === playbackSource.mediaType &&
        mediaFragmentStartSec(playbackSource) <= 0
      ) {
        const seedPositionSec = slot.seededState?.positionSec ?? 0;
        playbackSource = playbackSourceWithResumePosition(
          playbackSource,
          mediaFragmentStartSec(slot.seededSource) || seedPositionSec,
        );
      }
      if (targetKind === 'audio' && audioResumeCache !== null) {
        playbackSource = audioResumeCache.resolve(playbackSource);
      }
      if (
        targetKind === 'video' &&
        videoOptimization !== null &&
        !options.skipVideoOptimization
      ) {
        playbackSource = videoOptimization.resolve(playbackSource);
      }
      if (
        targetKind === 'video' &&
        playbackSource.optimizationOriginalUrl !== undefined
      ) {
        slot.optimizationFallbackInProgress = false;
      }
      slot.seedPreparationGeneration += 1;
      slot.seedPreparationPending = false;
      if (targetKind === 'video') {
        recordPlaybackDiagnosticMilestone(
          'video_selection',
          playbackSource,
          mediaFragmentStartSec(playbackSource) || null,
        );
      }

      try {
        // Pause the other kind so the two sessions never speak at once.
        const otherSession = slots[otherKind].session;
        if (otherSession) otherSession.pause();

        const elementAlive =
          slot.element !== null && isElementConnected(slot.element);
        const currentState = slot.session?.getState() ?? null;
        const shouldFlushCurrent = !slot.preparedSeed;
        const sameActiveAudio =
          targetKind === 'audio' &&
          slot.session !== null &&
          elementAlive &&
          currentState?.status.kind !== 'ended' &&
          samePlaybackMedia(currentState?.source ?? null, playbackSource);
        if (slot.session !== null && shouldFlushCurrent && !sameActiveAudio) {
          slot.progressAttachment?.flush();
          syncActivityProgress(targetKind, slot.session.getState(), true);
        }
        const activityRecords =
          activityRepository !== null
            ? activityRepository.recordPlay(
                activitySourceFromPlaybackSource(playbackSource),
                now(),
              )
            : get().activityRecords;

        set((state) => ({
          active: targetKind,
          activityRecords,
          recentlyPlayed:
            targetKind === 'audio'
              ? addRecentlyPlayed(state.recentlyPlayed, playbackSource)
              : state.recentlyPlayed,
        }));

        slot.seededSource = null;
        slot.seededState = null;
        slot.preparedSeed = false;
        if (sameActiveAudio) {
          beginAudioStartupGate(slot, playbackSource.mediaId);
          await slot.session!.play();
          sync();
          return;
        }
        // The element can be alive in the store but already removed from the
        // DOM: if an element reference survives after its node was removed,
        // treat it as absent so the next mount drains the queued source through
        // attachElement.
        if (slot.session === null || !elementAlive) {
          if (slot.session !== null && !elementAlive) {
            // Stale wiring against a detached DOM node. Tear it down so the
            // next attachElement sees a clean slot and rebuilds against the
            // newly mounted element.
            slot.progressAttachment?.dispose({ flush: shouldFlushCurrent });
            slot.progressAttachment = null;
            slot.unsubscribe?.();
            slot.session.dispose();
            slot.session = null;
            slot.engine = null;
            slot.unsubscribe = null;
            slot.element = null;
            slot.preparedSeed = false;
          }
          slot.pendingPlay = playbackSource;
          sync();
          return;
        }

        if (targetKind === 'audio') {
          beginAudioStartupGate(slot, playbackSource.mediaId);
        }
        slot.session.load(playbackSource);
        await slot.session.play();
      } catch (err) {
        if (targetKind === 'audio') closeStartupGate(slot);
        throw err;
      }
    };

    const playMusicQueueIndex = async (index: number) => {
      const source = currentQueueTrack(get().musicQueue, index);
      if (source === null) return;
      set({ musicQueueIndex: index });
      await playSourceOnSlot(source);
    };

    const baseQueueSnapshot = (state: PlayerState) => {
      const current = currentQueueTrack(state.musicQueue, state.musicQueueIndex);
      const tracks = state.shuffleBaseQueue ?? state.musicQueue;
      const currentIndex =
        current === null
          ? state.musicQueueIndex
          : findQueueTrackIndex(tracks, queueTrackKey(current));
      return {
        tracks,
        currentIndex: currentIndex >= 0 ? currentIndex : state.musicQueueIndex,
      };
    };

    const maybeAdvanceAudioQueue = () => {
      const state = get();
      if (state.audio.status.kind !== 'ended') return;
      const nextIndex = nextQueueIndex(
        {
          tracks: state.musicQueue,
          currentIndex: state.musicQueueIndex,
          repeatMode: state.repeatMode,
          stopAfterCurrent: state.stopAfterCurrent,
        });
      if (nextIndex === null) return;
      void playMusicQueueIndex(nextIndex);
    };

    const syncActivityProgress = (
      kind: 'audio' | 'video',
      state: PlaybackState,
      force = false,
    ) => {
      if (
        activityRepository === null ||
        state.source === null
      ) {
        return;
      }
      const completed = state.status.kind === 'ended';
      const terminal =
        state.status.kind === 'paused' ||
        state.status.kind === 'ended' ||
        state.status.kind === 'error';
      if (
        !force &&
        !terminal &&
        state.positionSec <= 0 &&
        state.durationSec <= 0
      ) {
        return;
      }
      const source = activitySourceFromPlaybackSource(state.source);
      const last = lastActivityProgress[kind];
      if (
        last.contentKey === source.contentKey &&
        last.positionSec === state.positionSec &&
        last.durationSec === state.durationSec &&
        last.completed === completed
      ) {
        return;
      }
      const writtenAtMs = now();
      if (
        !force &&
        !terminal &&
        last.contentKey === source.contentKey &&
        writtenAtMs - last.writtenAtMs < activityProgressThrottleMs
      ) {
        return;
      }
      const collectionChanged = activityRepository.updateProgress(
        source,
        {
          positionSec: state.positionSec,
          durationSec: state.durationSec,
          completed,
        },
      );
      lastActivityProgress[kind] = {
        contentKey: source.contentKey,
        writtenAtMs,
        positionSec: state.positionSec,
        durationSec: state.durationSec,
        completed,
      };
      if (collectionChanged) {
        set({ activityRecords: activityRepository.list() });
      }
    };

    const subscribeToSession = (kind: 'audio' | 'video') => {
      const slot = slots[kind];
      if (!slot.session) return;
      slot.unsubscribe = slot.session.subscribe(() => {
        const nextState = slot.session?.getState() ?? initialPlayback;
        sync();
        if (!slot.preparedSeed) {
          syncActivityProgress(kind, nextState);
        }
        if (
          kind === 'audio' &&
          audioResumeCache !== null &&
          nextState.status.kind === 'playing' &&
          nextState.source !== null &&
          nextState.source.name.toLowerCase().endsWith('.aac') &&
          nextState.positionSec >= 30
        ) {
          audioResumeCache.prepare(nextState.source.mediaId);
        }
        if (
          kind === 'video' &&
          videoOptimization !== null &&
          nextState.status.kind === 'error' &&
          nextState.source?.optimizationOriginalUrl !== undefined &&
          !slot.optimizationFallbackInProgress
        ) {
          slot.optimizationFallbackInProgress = true;
          videoOptimization.invalidate(
            nextState.source.mediaId,
            nextState.source.optimizationKind,
          );
          const fallback = restoreOriginalVideoSource(
            nextState.source,
            nextState.positionSec,
          );
          if (slot.preparedSeed && slot.session !== null) {
            slot.seededSource = fallback;
            slot.session.load(fallback);
            if (nextState.positionSec > 0) {
              slot.session.seek(nextState.positionSec);
            }
            sync();
            return;
          }
          void playSourceOnSlot(fallback, {
            skipVideoOptimization: true,
          }).catch(() => {
            // The direct source owns any subsequent error. The optimization
            // fallback is deliberately attempted only once.
          });
        }
        if (kind === 'audio') maybeAdvanceAudioQueue();
        if (kind === 'audio') updateAudioGateState(nextState);
      });
    };

    const clearSleepTimerHandle = () => {
      if (sleepTimerHandle === null) return;
      clearIntervalFn(sleepTimerHandle);
      sleepTimerHandle = null;
    };

    const tickSleepTimer = () => {
      const timer = get().sleepTimer;
      if (timer.kind !== 'running') {
        clearSleepTimerHandle();
        return;
      }

      const remainingSec = Math.max(
        0,
        Math.ceil((timer.endsAtMs - now()) / 1000),
      );
      if (remainingSec <= 0) {
        clearSleepTimerHandle();
        get().pauseActive();
        set({ sleepTimer: { kind: 'expired' } });
        return;
      }

      if (remainingSec !== timer.remainingSec) {
        set({
          sleepTimer: {
            ...timer,
            remainingSec,
          },
        });
      }
    };

    const applyPreferencesToAttachedElements = (volume: number, muted: boolean) => {
      for (const slot of Object.values(slots)) {
        if (slot.element !== null) {
          applyElementPreferences(slot.element, volume, muted);
        }
      }
    };

    return {
      audio: initialPlayback,
      video: initialPlayback,
      active: null,
      sleepTimer: { kind: 'off' },
      stopAfterCurrent: false,
      volume: initialPreferences.volume,
      muted: initialPreferences.muted,
      musicQueue: [],
      musicQueueIndex: -1,
      shuffle: initialPreferences.shuffle,
      shuffleBaseQueue: null,
      repeatMode: initialPreferences.repeatMode,
      likedMediaIds: likedRepository?.list() ?? [],
      recentlyPlayed: [],
      activityRecords: activityRepository?.list() ?? [],

      attachElement(kind, element) {
        const slot = slots[kind];
        // Same element already wired? Nothing to do; this is the common case
        // when a route remounts but React reuses the same DOM node.
        if (slot.element === element && slot.session !== null) {
          // Even on a no-op attach, drain any pending source the user
          // requested while the element was missing.
          const pending = slot.pendingPlay;
          if (pending !== null && slot.session !== null) {
            slot.pendingPlay = null;
            slot.seededSource = null;
            slot.seededState = null;
            slot.preparedSeed = false;
            if (kind === 'audio') beginAudioStartupGate(slot, pending.mediaId);
            slot.session.load(pending);
            void slot.session.play();
          }
          return;
        }

        const previousSource = slot.session?.getState().source ?? null;

        // Tear down any previous wiring so route remounts do not stack.
        const wasPreparedSeed = slot.preparedSeed;
        const shouldFlushPrevious = !slot.preparedSeed;
        closeStartupGate(slot);
        closeSeekGate(slot);
        if (slot.session !== null && shouldFlushPrevious) {
          syncActivityProgress(kind, slot.session.getState(), true);
        }
        slot.progressAttachment?.dispose({ flush: shouldFlushPrevious });
        slot.progressAttachment = null;
        slot.unsubscribe?.();
        slot.session?.dispose();
        slot.preparedSeed = false;

        const engine = engineFactory(element);
        const session = sessionFactory(engine);
        const target = element as unknown as PlaybackTarget;
        slot.engine = engine;
        slot.session = session;
        slot.element = target;
        applyElementPreferences(target, get().volume, get().muted);
        subscribeToSession(kind);
        if (progressService !== null) {
          slot.progressAttachment = progressService.attach(session);
        }

        // Order matters: a queued user request beats a parking-lot source so
        // clicking a new library row while the player route was still
        // mounting starts the new file, not the previous one.
        const pending = slot.pendingPlay;
        if (pending !== null) {
          slot.pendingPlay = null;
          slot.seededSource = null;
          slot.seededState = null;
          slot.preparedSeed = false;
          if (kind === 'audio') beginAudioStartupGate(slot, pending.mediaId);
          session.load(pending);
          void session.play();
        } else if (previousSource !== null) {
          // If a source was loaded before the previous element was detached,
          // hand it to the new session so the user does not lose their
          // selection when the player route remounts the video element.
          slot.preparedSeed = wasPreparedSeed;
          session.load(previousSource);
        }

        sync();
      },

      attachEngine(kind, engine, target) {
        const slot = slots[kind];
        if (slot.engine === engine && slot.session !== null) {
          const pending = slot.pendingPlay;
          if (pending !== null) {
            slot.pendingPlay = null;
            slot.seededSource = null;
            slot.seededState = null;
            slot.preparedSeed = false;
            if (kind === 'audio') beginAudioStartupGate(slot, pending.mediaId);
            slot.session.load(pending);
            void slot.session.play();
          }
          return;
        }

        const previousSource = slot.session?.getState().source ?? null;
        const wasPreparedSeed = slot.preparedSeed;
        const shouldFlushPrevious = !slot.preparedSeed;
        closeStartupGate(slot);
        closeSeekGate(slot);
        if (slot.session !== null && shouldFlushPrevious) {
          syncActivityProgress(kind, slot.session.getState(), true);
        }
        slot.progressAttachment?.dispose({ flush: shouldFlushPrevious });
        slot.progressAttachment = null;
        slot.unsubscribe?.();
        slot.session?.dispose();
        slot.preparedSeed = false;

        const session = sessionFactory(engine);
        slot.engine = engine;
        slot.session = session;
        slot.element = target;
        applyElementPreferences(target, get().volume, get().muted);
        subscribeToSession(kind);
        if (progressService !== null) {
          slot.progressAttachment = progressService.attach(session);
        }

        const pending = slot.pendingPlay;
        if (pending !== null) {
          slot.pendingPlay = null;
          slot.seededSource = null;
          slot.seededState = null;
          slot.preparedSeed = false;
          if (kind === 'audio') beginAudioStartupGate(slot, pending.mediaId);
          session.load(pending);
          void session.play();
        } else if (previousSource !== null) {
          slot.preparedSeed = wasPreparedSeed;
          session.load(previousSource);
        }

        sync();
      },

      detachElement(kind, expectedElement) {
        const slot = slots[kind];
        // Optional safety: only detach if the slot still points at the
        // element the caller knows about. This lets a deferred cleanup
        // skip the detach when a remount has already replaced the wiring.
        if (
          expectedElement !== undefined &&
          slot.element !== (expectedElement as unknown as PlaybackTarget)
        ) {
          return;
        }
        // Deferred cleanups (queueMicrotask in AudioMount/VideoMount) race
        // with React StrictMode's second mount: by the time the microtask
        // runs, the second mount has already re-attached idempotently to
        // the same DOM node. Distinguish "real unmount" from "StrictMode
        // remount" by asking the DOM. A real unmount removes the element
        // from the tree; a StrictMode remount leaves it in place.
        if (
          expectedElement !== undefined &&
          isElementConnected(expectedElement as unknown as PlaybackTarget)
        ) {
          return;
        }
        // Keep the loaded source (if any) accessible to the next attach so
        // navigating away from the player and back does not silently drop
        // the active media. We still dispose the engine so the dead element
        // does not keep listeners attached.
        const lingeringState = slot.session?.getState() ?? null;
        const lingeringSource = lingeringState?.source ?? null;
        const wasPreparedSeed = slot.preparedSeed;
        const shouldFlushCurrent = !slot.preparedSeed;
        closeStartupGate(slot);
        closeSeekGate(slot);
        if (slot.session !== null && shouldFlushCurrent) {
          syncActivityProgress(kind, slot.session.getState(), true);
        }
        slot.progressAttachment?.dispose({ flush: shouldFlushCurrent });
        slot.progressAttachment = null;
        slot.unsubscribe?.();
        slot.session?.dispose();
        slot.preparedSeed = false;

        if (lingeringState !== null && lingeringSource !== null) {
          // Replace the live session with a parking-lot session that only
          // remembers the last source. The next attachElement will read it
          // back through previousSource above.
          slot.session = createParkingLotSession(lingeringState);
          slot.preparedSeed = wasPreparedSeed;
        } else {
          slot.session = null;
          slot.preparedSeed = false;
        }
        slot.engine = null;
        slot.unsubscribe = null;
        slot.element = null;
        // pendingPlay survives detach: a user can click a video row and
        // immediately navigate elsewhere; we do not want to leak the request.
        // Clearing it here would trade a stale autoplay for a dropped one;
        // dropping is the right tradeoff because the user already moved on.
        slot.pendingPlay = null;
        sync();
      },

      detachEngine(kind, expectedEngine) {
        const slot = slots[kind];
        if (expectedEngine !== undefined && slot.engine !== expectedEngine) {
          return;
        }
        if (slot.element !== null && isElementConnected(slot.element)) {
          return;
        }

        const lingeringState = slot.session?.getState() ?? null;
        const lingeringSource = lingeringState?.source ?? null;
        const wasPreparedSeed = slot.preparedSeed;
        const shouldFlushCurrent = !slot.preparedSeed;
        closeStartupGate(slot);
        closeSeekGate(slot);
        if (slot.session !== null && shouldFlushCurrent) {
          syncActivityProgress(kind, slot.session.getState(), true);
        }
        slot.progressAttachment?.dispose({ flush: shouldFlushCurrent });
        slot.progressAttachment = null;
        slot.unsubscribe?.();
        slot.session?.dispose();
        slot.preparedSeed = false;
        slot.session =
          lingeringState !== null && lingeringSource !== null
            ? createParkingLotSession(lingeringState)
            : null;
        slot.preparedSeed =
          lingeringState !== null && lingeringSource !== null
            ? wasPreparedSeed
            : false;
        slot.engine = null;
        slot.unsubscribe = null;
        slot.element = null;
        slot.pendingPlay = null;
        sync();
      },

      seedSource(source, savedState) {
        const targetKind = source.mediaType;
        const slot = slots[targetKind];
        // Skip when a real source is already loaded so the boot-time seed cannot
        // overwrite live playback or a route-remount parking-lot source.
        const liveSource = slot.session?.getState().source ?? null;
        if (liveSource !== null) return;
        const positionSec =
          typeof savedState?.positionSec === 'number' &&
          Number.isFinite(savedState.positionSec) &&
          savedState.positionSec > 0
            ? savedState.positionSec
            : 0;
        slot.seededSource = playbackSourceWithResumePosition(
          source,
          positionSec,
        );
        const durationSec =
          typeof savedState?.durationSec === 'number' &&
          Number.isFinite(savedState.durationSec) &&
          savedState.durationSec > 0
            ? savedState.durationSec
            : typeof source.durationSec === 'number' &&
                Number.isFinite(source.durationSec) &&
                source.durationSec > 0
              ? source.durationSec
              : 0;
        slot.seededState = { positionSec, durationSec };
        slot.preparedSeed = false;
        slot.seedPreparationGeneration += 1;
        slot.seedPreparationPending = false;
        slot.pendingPlay = null;
        set({ active: targetKind });
        sync();
      },

      prepareSeededSource(kind) {
        const slot = slots[kind];
        if (slot.seededSource === null || slot.session === null) return;
        if (slot.session.getState().source !== null) return;
        if (slot.seedPreparationPending) return;
        const seededSource = slot.seededSource;
        const session = slot.session;
        const positionSec = slot.seededState?.positionSec ?? 0;
        const loadSeed = (resolved: PlaybackSource) => {
          if (
            slot.seededSource !== seededSource ||
            slot.session !== session ||
            session.getState().source !== null
          ) {
            return;
          }
          slot.seededSource = resolved;
          slot.preparedSeed = true;
          session.load(resolved);
          if (positionSec > 0) session.seek(positionSec);
          sync();
        };
        if (kind !== 'video' || videoOptimization === null) {
          loadSeed(seededSource);
          return;
        }
        const generation = ++slot.seedPreparationGeneration;
        slot.seedPreparationPending = true;
        const refreshes = [videoOptimization.status(seededSource.mediaId, true, 'faststart-mp4')];
        if (videoOptimization.supportsNativeHLS()) {
          refreshes.push(videoOptimization.status(seededSource.mediaId, true, 'hls-fmp4'));
        }
        void Promise.all(refreshes).then(() => {
          if (generation !== slot.seedPreparationGeneration) return;
          slot.seedPreparationPending = false;
          loadSeed(videoOptimization.resolve(seededSource));
        }).catch(() => {
          if (generation !== slot.seedPreparationGeneration) return;
          slot.seedPreparationPending = false;
          loadSeed(seededSource);
        });
      },

      async playSource(source) {
        if (source.mediaType === 'audio') {
          const nextQueue = [withQueueEntry(source)];
          set({
            musicQueue: nextQueue,
            musicQueueIndex: 0,
            shuffleBaseQueue: get().shuffle ? nextQueue : null,
          });
        }
        await playSourceOnSlot(source);
      },

      prefetchVideoOptimization(mediaId) {
        if (videoOptimization === null || mediaId.trim() === '') return;
        const requests = [videoOptimization.status(mediaId, false, 'faststart-mp4')];
        if (videoOptimization.supportsNativeHLS()) {
          requests.push(videoOptimization.status(mediaId, false, 'hls-fmp4'));
        }
        void Promise.all(requests).catch(() => {
          // Prefetch must never interfere with the direct playback path.
        });
      },

      async playMusicQueue(sources, startMediaId) {
        const queue = buildMusicQueue(withQueueEntries(sources), startMediaId);
        const activeQueue = get().shuffle
          ? shuffleQueueKeepingCurrent(queue.tracks, queue.currentIndex, random)
          : queue;
        const source = currentQueueTrack(
          activeQueue.tracks,
          activeQueue.currentIndex,
        );
        if (source === null) return;
        set({
          musicQueue: activeQueue.tracks,
          musicQueueIndex: activeQueue.currentIndex,
          shuffleBaseQueue: get().shuffle ? queue.tracks : null,
        });
        await playSourceOnSlot(source);
      },

      async insertQueueItemAfterCurrentAndPlay(source) {
        if (source.mediaType !== 'audio') {
          await get().playSource(source);
          return;
        }
        const state = get();
        const next = insertQueueTrackAfterCurrent(
          state.musicQueue,
          state.musicQueueIndex,
          withQueueEntry(source),
        );
        const base = baseQueueSnapshot(state);
        const nextBase = insertQueueTrackAfterCurrent(
          base.tracks,
          base.currentIndex,
          withQueueEntry(source),
        );
        const current = currentQueueTrack(next.tracks, next.currentIndex);
        if (current === null) return;
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
        await playSourceOnSlot(current);
      },

      async togglePlayPause() {
        const active = get().active;
        if (active === null) return;
        const slot = slots[active];
        const seededSource = slot.seededSource;
        if (seededSource !== null) {
          const session = slot.session;
          if (
            session !== null &&
            samePlaybackSource(session.getState().source, seededSource)
          ) {
            slot.seededSource = null;
            slot.seededState = null;
            slot.preparedSeed = false;
            sync();
            try {
              if (active === 'audio') {
                beginAudioStartupGate(slot, seededSource.mediaId);
              }
              await session.play();
            } catch (err) {
              if (active === 'audio') closeStartupGate(slot);
              throw err;
            }
            return;
          }
          await get().playSource(seededSource);
          return;
        }
        const session = slot.session;
        if (!session) return;
        const status = session.getState().status.kind;
        if (status === 'playing' || status === 'buffering' || status === 'loading') {
          session.pause();
          return;
        }
        const source = session.getState().source;
        try {
          if (active === 'audio' && source !== null) {
            beginAudioStartupGate(slot, source.mediaId);
          }
          await session.play();
        } catch (err) {
          if (active === 'audio') closeStartupGate(slot);
          throw err;
        }
      },

      async retryActivePlayback() {
        const active = get().active;
        if (active === null) return;
        const slot = slots[active];
        const seededSource = slot.seededSource;
        if (seededSource !== null) {
          await get().playSource(seededSource);
          return;
        }
        const session = slot.session;
        if (!session) return;
        const source = session.getState().source;
        try {
          if (active === 'audio' && source !== null) {
            beginAudioStartupGate(slot, source.mediaId);
          }
          await session.play();
        } catch (err) {
          if (active === 'audio') closeStartupGate(slot);
          throw err;
        }
      },

      pauseActive() {
        const active = get().active;
        if (active === null) return;
        slots[active].session?.pause();
      },

      seekActive(positionSec) {
        const active = get().active;
        if (active === null) return;
        const session = slots[active].session;
        if (!session) return;
        const source = session.getState().source;
        if (
          active === 'audio' &&
          source !== null &&
          Number.isFinite(positionSec) &&
          positionSec >= 0
        ) {
          beginAudioSeekGate(slots.audio, source.mediaId, positionSec);
        }
        session.seek(positionSec);
      },

      startSleepTimer(minutes) {
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        clearSleepTimerHandle();
        const durationSec = Math.max(1, Math.round(minutes * 60));
        const endsAtMs = now() + durationSec * 1000;
        set({
          sleepTimer: {
            kind: 'running',
            durationSec,
            remainingSec: durationSec,
            endsAtMs,
          },
        });
        sleepTimerHandle = setIntervalFn(tickSleepTimer, 1000);
      },

      cancelSleepTimer() {
        clearSleepTimerHandle();
        set({ sleepTimer: { kind: 'off' } });
      },

      toggleStopAfterCurrent() {
        set((state) => ({
          stopAfterCurrent: !state.stopAfterCurrent,
        }));
      },

      setVolume(volume) {
        const nextVolume = clampVolume(volume);
        applyPreferencesToAttachedElements(nextVolume, get().muted);
        set({ volume: nextVolume });
        const state = get();
        persistPreferences({ volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeatMode: state.repeatMode });
      },

      setMuted(muted) {
        applyPreferencesToAttachedElements(get().volume, muted);
        set({ muted });
        const state = get();
        persistPreferences({ volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeatMode: state.repeatMode });
      },

      toggleMute() {
        const muted = !get().muted;
        get().setMuted(muted);
      },

      toggleShuffle() {
        set((state) => {
          if (!state.shuffle) {
            const shuffled = shuffleQueueKeepingCurrent(
              state.musicQueue,
              state.musicQueueIndex,
              random,
            );
            return {
              shuffle: true,
              shuffleBaseQueue: [...state.musicQueue],
              musicQueue: shuffled.tracks,
              musicQueueIndex: shuffled.currentIndex,
            };
          }

          const current = currentQueueTrack(
            state.musicQueue,
            state.musicQueueIndex,
          );
          const restored = state.shuffleBaseQueue ?? state.musicQueue;
          const restoredIndex =
            current === null
              ? state.musicQueueIndex
              : findQueueTrackIndex(restored, queueTrackKey(current));
          return {
            shuffle: false,
            shuffleBaseQueue: null,
            musicQueue: [...restored],
            musicQueueIndex:
              restoredIndex >= 0
                ? restoredIndex
                : Math.min(state.musicQueueIndex, restored.length - 1),
          };
        });
        const state = get();
        persistPreferences({ volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeatMode: state.repeatMode });
      },

      cycleRepeatMode() {
        set((state) => ({ repeatMode: nextRepeatMode(state.repeatMode) }));
        const state = get();
        persistPreferences({ volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeatMode: state.repeatMode });
      },

      toggleLike(mediaId) {
        const trimmed = mediaId.trim();
        if (trimmed === '') return;
        const setIds = new Set(get().likedMediaIds);
        if (setIds.has(trimmed)) {
          setIds.delete(trimmed);
        } else {
          setIds.add(trimmed);
        }
        const likedMediaIds = [...setIds];
        likedRepository?.write(likedMediaIds);
        set({ likedMediaIds });
      },

      refreshActivity() {
        set({ activityRecords: activityRepository?.list() ?? [] });
      },

      flushActivity() {
        for (const kind of ['audio', 'video'] as const) {
          const session = slots[kind].session;
          if (session !== null && !slots[kind].preparedSeed) {
            syncActivityProgress(kind, session.getState(), true);
          }
        }
      },

      exportPlaybackActivity() {
        return JSON.stringify(
          activityRepository?.exportData() ?? { version: 1, records: [] },
          null,
          2,
        );
      },

      importPlaybackActivity(data) {
        if (activityRepository === null) return false;
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          const activityRecords = activityRepository.importData(parsed);
          set({ activityRecords });
          return true;
        } catch {
          return false;
        }
      },

      async playQueueItem(mediaId) {
        const index = get().musicQueue.findIndex(
          (track) => track.mediaId === mediaId,
        );
        if (index < 0) return;
        await playMusicQueueIndex(index);
      },

      async playQueueTrack(trackKey) {
        const index = get().musicQueue.findIndex(
          (track) => queueTrackKey(track) === trackKey,
        );
        if (index < 0) return;
        await playMusicQueueIndex(index);
      },

      async playPreviousQueueItem() {
        const state = get();
        const previousIndex = previousQueueIndex({
          tracks: state.musicQueue,
          currentIndex: state.musicQueueIndex,
          repeatMode: state.repeatMode,
          stopAfterCurrent: state.stopAfterCurrent,
        });
        if (previousIndex === null) return;
        await playMusicQueueIndex(previousIndex);
      },

      async playNextQueueItem() {
        const state = get();
        const nextIndex = explicitNextQueueIndex(
          {
            tracks: state.musicQueue,
            currentIndex: state.musicQueueIndex,
            repeatMode: state.repeatMode,
            stopAfterCurrent: state.stopAfterCurrent,
          });
        if (nextIndex === null) return;
        await playMusicQueueIndex(nextIndex);
      },

      playQueueItemNext(mediaId) {
        const state = get();
        const next = moveQueueTrackNext(
          state.musicQueue,
          state.musicQueueIndex,
          mediaId,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = moveQueueTrackNext(
          base.tracks,
          base.currentIndex,
          mediaId,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      playQueueTrackNext(trackKey) {
        const state = get();
        const next = moveQueueTrackNext(
          state.musicQueue,
          state.musicQueueIndex,
          trackKey,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = moveQueueTrackNext(
          base.tracks,
          base.currentIndex,
          trackKey,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      removeQueueItem(mediaId) {
        const state = get();
        const next = removeQueueTrackFromQueue(
          state.musicQueue,
          state.musicQueueIndex,
          mediaId,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = removeQueueTrackFromQueue(
          base.tracks,
          base.currentIndex,
          mediaId,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      removeQueueTrack(trackKey) {
        const state = get();
        const next = removeQueueTrackFromQueue(
          state.musicQueue,
          state.musicQueueIndex,
          trackKey,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = removeQueueTrackFromQueue(
          base.tracks,
          base.currentIndex,
          trackKey,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      clearMusicQueue() {
        const state = get();
        const next = clearQueueTracks(
          state.musicQueue,
          state.musicQueueIndex,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = clearQueueTracks(
          base.tracks,
          base.currentIndex,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      moveQueueItem(mediaId, direction) {
        const state = get();
        const next = moveQueueTrackInQueue(
          state.musicQueue,
          state.musicQueueIndex,
          mediaId,
          direction,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = moveQueueTrackInQueue(
          base.tracks,
          base.currentIndex,
          mediaId,
          direction,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      moveQueueTrack(trackKey, direction) {
        const state = get();
        const next = moveQueueTrackInQueue(
          state.musicQueue,
          state.musicQueueIndex,
          trackKey,
          direction,
        );
        const base = baseQueueSnapshot(state);
        const nextBase = moveQueueTrackInQueue(
          base.tracks,
          base.currentIndex,
          trackKey,
          direction,
        );
        set({
          musicQueue: next.tracks,
          musicQueueIndex: next.currentIndex,
          shuffleBaseQueue: state.shuffle ? nextBase.tracks : null,
        });
      },

      setSessionForTests(kind, session) {
        const slot = slots[kind];
        const shouldFlushCurrent = !slot.preparedSeed;
        if (slot.session !== null && shouldFlushCurrent) {
          syncActivityProgress(kind, slot.session.getState(), true);
        }
        slot.progressAttachment?.dispose({ flush: shouldFlushCurrent });
        slot.progressAttachment = null;
        slot.unsubscribe?.();
        slot.session = session;
        slot.engine = null;
        slot.unsubscribe = null;
        slot.element = null;
        slot.seededSource = null;
        slot.preparedSeed = false;
        if (session) {
          slot.unsubscribe = session.subscribe(() => {
            const nextState = session.getState();
            sync();
            syncActivityProgress(kind, nextState);
            if (kind === 'audio') maybeAdvanceAudioQueue();
          });
        }
        slot.seededState = null;
        sync();
      },
    };
  });
}

export type PlayerStoreApi = ReturnType<typeof createPlayerStore>;

/**
 * Returns the playback state of whichever kind is active, or the idle stub.
 * Useful for the mini player and full-screen surfaces that do not care
 * about the audio/video split.
 */
export function selectActiveState(snapshot: PlayerSnapshot): PlaybackState {
  if (snapshot.active === 'audio') return snapshot.audio;
  if (snapshot.active === 'video') return snapshot.video;
  return initialPlayback;
}
