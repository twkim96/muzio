import { useEffect, useRef } from 'react';

import type { PlaybackStatus } from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import { usePlayerStore } from './PlayerContext';
import { selectActiveState } from './playerStore';

type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto';

interface MediaSessionActionDetails {
  action: MediaSessionAction;
  seekTime?: number | null;
  seekOffset?: number | null;
}

type MediaSessionActionHandler = (
  details: MediaSessionActionDetails,
) => void | Promise<void>;

interface MediaMetadataInitLike {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: Array<{ src: string; sizes?: string; type?: string }>;
}

interface MediaMetadataConstructorLike {
  new (init: MediaMetadataInitLike): unknown;
}

interface MediaSessionLike {
  metadata: unknown | null;
  playbackState?: 'none' | 'paused' | 'playing';
  setActionHandler?(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ): void;
}

interface NavigatorWithMediaSession {
  mediaSession?: MediaSessionLike;
}

interface WindowWithMediaMetadata {
  MediaMetadata?: MediaMetadataConstructorLike;
}

const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'seekbackward',
  'seekforward',
  'seekto',
];

const DEFAULT_SEEK_OFFSET_SEC = 10;

export function MediaSessionSync() {
  const store = usePlayerStore();
  const activeState = store(selectActiveState);
  const source = activeState.source;
  const status = activeState.status;
  const metadataGenerationRef = useRef(0);

  useEffect(() => {
    const generation = metadataGenerationRef.current + 1;
    metadataGenerationRef.current = generation;
    const mediaSession = mediaSessionOrNull();
    const MediaMetadata = mediaMetadataConstructorOrNull();
    if (mediaSession === null || MediaMetadata === null) return;

    if (source === null) {
      setMediaSessionMetadata(mediaSession, null);
      setPlaybackState(mediaSession, status);
      return;
    }

    const applyMetadata = () => {
      if (metadataGenerationRef.current !== generation) return;
      setMediaSessionMetadata(
        mediaSession,
        new MediaMetadata(mediaMetadataForSource(source)),
      );
      setPlaybackState(mediaSession, status);
    };

    applyMetadata();
    queueMicrotask(applyMetadata);
  }, [source, status]);

  useEffect(() => {
    const mediaSession = mediaSessionOrNull();
    if (mediaSession === null || mediaSession.setActionHandler === undefined) {
      return;
    }

    const handlers: Record<MediaSessionAction, MediaSessionActionHandler> = {
      play: () => {
        const state = store.getState();
        const current = selectActiveState(state);
        if (state.active === null || isPlaybackInFlight(current.status)) return;
        void state.togglePlayPause();
      },
      pause: () => {
        const state = store.getState();
        const current = selectActiveState(state);
        if (!isPlaybackInFlight(current.status)) return;
        state.pauseActive();
      },
      seekbackward: (details) => {
        const offset = mediaSessionSeekOffset(details);
        const state = store.getState();
        const current = selectActiveState(state);
        state.seekActive(
          clampSeekTarget(current.positionSec - offset, current.durationSec),
        );
      },
      seekforward: (details) => {
        const offset = mediaSessionSeekOffset(details);
        const state = store.getState();
        const current = selectActiveState(state);
        state.seekActive(
          clampSeekTarget(current.positionSec + offset, current.durationSec),
        );
      },
      seekto: (details) => {
        const seekTime = details.seekTime;
        if (typeof seekTime !== 'number' || !Number.isFinite(seekTime)) return;
        const state = store.getState();
        const current = selectActiveState(state);
        state.seekActive(clampSeekTarget(seekTime, current.durationSec));
      },
    };

    for (const action of MEDIA_SESSION_ACTIONS) {
      setActionHandler(mediaSession, action, handlers[action]);
    }
    return () => {
      for (const action of MEDIA_SESSION_ACTIONS) {
        setActionHandler(mediaSession, action, null);
      }
    };
  }, [store]);

  return null;
}

function mediaMetadataForSource(source: PlaybackSource): MediaMetadataInitLike {
  const artist = source.artist ?? source.rootName;
  return {
    title: source.title ?? source.name,
    ...(artist ? { artist } : {}),
  };
}

function mediaSessionOrNull(): MediaSessionLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as NavigatorWithMediaSession).mediaSession ?? null;
}

function mediaMetadataConstructorOrNull(): MediaMetadataConstructorLike | null {
  if (typeof window === 'undefined') return null;
  return (window as WindowWithMediaMetadata).MediaMetadata ?? null;
}

function setMediaSessionMetadata(
  mediaSession: MediaSessionLike,
  metadata: unknown | null,
) {
  try {
    mediaSession.metadata = metadata;
  } catch {
    // Some partial implementations expose mediaSession but reject metadata.
  }
}

function setPlaybackState(
  mediaSession: MediaSessionLike,
  status: PlaybackStatus,
) {
  try {
    mediaSession.playbackState = playbackStateForStatus(status);
  } catch {
    // Older browsers can expose a readonly or partial playbackState surface.
  }
}

function playbackStateForStatus(
  status: PlaybackStatus,
): 'none' | 'paused' | 'playing' {
  switch (status.kind) {
    case 'playing':
    case 'buffering':
    case 'loading':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'idle':
    case 'ended':
    case 'error':
      return 'none';
  }
}

function setActionHandler(
  mediaSession: MediaSessionLike,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    mediaSession.setActionHandler?.(action, handler);
  } catch {
    // Browsers can throw for action names they do not support.
  }
}

function mediaSessionSeekOffset(details: MediaSessionActionDetails) {
  const offset = details.seekOffset;
  return typeof offset === 'number' && Number.isFinite(offset) && offset > 0
    ? offset
    : DEFAULT_SEEK_OFFSET_SEC;
}

function clampSeekTarget(positionSec: number, durationSec: number) {
  const lowerBounded = Math.max(0, positionSec);
  return Number.isFinite(durationSec) && durationSec > 0
    ? Math.min(lowerBounded, durationSec)
    : lowerBounded;
}

function isPlaybackInFlight(status: PlaybackStatus) {
  return (
    status.kind === 'playing' ||
    status.kind === 'buffering' ||
    status.kind === 'loading'
  );
}
