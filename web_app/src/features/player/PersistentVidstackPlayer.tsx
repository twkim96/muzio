import {
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
  type PlayerSrc,
  type VideoMimeType,
} from '@vidstack/react';
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from '@vidstack/react/player/layouts/default';
import '@vidstack/react/player/styles/base.css';
import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { PlaybackSource } from '../../core/playback/source/source';
import { TheaterGlyph } from '../../core/ui/AppIcons';
import { usePlayerStore } from './PlayerContext';
import { createVidstackEngine } from './vidstackEngine';

interface CommittedSource {
  source: PlaybackSource | null;
  revision: number;
}

export function PersistentVidstackPlayer({
  host,
  onToggleTheaterMode,
  portalRoot,
  theaterMode,
}: {
  host: HTMLElement | null;
  onToggleTheaterMode: () => void;
  portalRoot: HTMLDivElement;
  theaterMode: boolean;
}) {
  const store = usePlayerStore();
  const parkingHostRef = useRef<HTMLDivElement | null>(null);
  const [player, setPlayer] = useState<MediaPlayerInstance | null>(null);
  const [committedSource, setCommittedSource] = useState<CommittedSource>({
    source: null,
    revision: 0,
  });
  const revisionRef = useRef(0);
  const commitResolversRef = useRef(new Map<number, () => void>());

  const commitSource = useCallback((source: PlaybackSource | null) => {
    const revision = ++revisionRef.current;
    const committed = new Promise<void>((resolve) => {
      commitResolversRef.current.set(revision, resolve);
    });
    setCommittedSource({ source, revision });
    return committed;
  }, []);

  useLayoutEffect(() => {
    for (const [revision, resolve] of commitResolversRef.current) {
      if (revision > committedSource.revision) continue;
      commitResolversRef.current.delete(revision);
      resolve();
    }
  }, [committedSource]);

  useLayoutEffect(() => {
    const target = host ?? parkingHostRef.current;
    if (target === null || portalRoot.parentElement === target) return;
    target.appendChild(portalRoot);
    portalRoot.className =
      host === null ? videoParkedClassName : videoVisibleClassName;
  }, [host, portalRoot]);

  useLayoutEffect(() => {
    if (player === null) return;

    const engine = createVidstackEngine(player, commitSource);
    const target = {
      get isConnected() {
        return player.el?.isConnected ?? false;
      },
      get volume() {
        return player.volume;
      },
      set volume(volume: number) {
        player.volume = volume;
      },
      get muted() {
        return player.muted;
      },
      set muted(muted: boolean) {
        player.muted = muted;
      },
    };
    const syncVolume = (event: Event) => {
      const detail = (
        event as CustomEvent<{ volume?: number; muted?: boolean }>
      ).detail;
      const snapshot = store.getState();
      if (
        typeof detail?.volume === 'number' &&
        Math.abs(detail.volume - snapshot.volume) > 0.001
      ) {
        snapshot.setVolume(detail.volume);
      }
      if (
        typeof detail?.muted === 'boolean' &&
        detail.muted !== snapshot.muted
      ) {
        snapshot.setMuted(detail.muted);
      }
    };

    player.addEventListener('volume-change', syncVolume);
    store.getState().attachEngine('video', engine, target);
    return () => {
      player.removeEventListener('volume-change', syncVolume);
      queueMicrotask(() => {
        store.getState().detachEngine('video', engine);
      });
    };
  }, [commitSource, player, store]);

  useLayoutEffect(() => {
    if (host === null || player === null) return;
    store.getState().prepareSeededSource('video');
  }, [host, player, store]);

  const source = committedSource.source;
  const playerSource: PlayerSrc | undefined =
    source === null
      ? undefined
      : {
          src: source.url,
          type: videoMimeType(source),
        };
  const layoutSlots = {
    beforeFullscreenButton: (
      <TheaterModeButton
        active={theaterMode}
        onToggle={onToggleTheaterMode}
      />
    ),
    ...(import.meta.env.MODE === 'test' ? { timeSlider: null } : {}),
  };

  return (
    <>
      {createPortal(
        <MediaPlayer
          ref={setPlayer}
          data-testid="video-mount"
          className="h-full w-full overflow-hidden rounded-2xl bg-black"
          src={playerSource}
          title={source?.name ?? 'Video'}
          viewType="video"
          logLevel="silent"
          load="custom"
          preload="metadata"
          playsInline
          streamType="on-demand"
        >
          <MediaProvider />
          <DefaultVideoLayout
            icons={defaultLayoutIcons}
            colorScheme="dark"
            slots={layoutSlots}
          />
        </MediaPlayer>,
        portalRoot,
      )}
      <div
        ref={parkingHostRef}
        aria-hidden
        className="pointer-events-none fixed -left-px -top-px h-px w-px overflow-hidden opacity-0"
      />
    </>
  );
}

const videoVisibleClassName = 'h-full w-full';
const videoParkedClassName =
  'pointer-events-none h-px w-px overflow-hidden opacity-0';

function TheaterModeButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="video-theater-toggle"
      aria-label={active ? 'Exit theater mode' : 'Enter theater mode'}
      aria-pressed={active}
      className="vds-button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <TheaterGlyph active={active} className="vds-icon" />
    </button>
  );
}

function videoMimeType(source: PlaybackSource): VideoMimeType {
  switch (source.mimeType) {
    case 'video/mp4':
    case 'video/webm':
    case 'video/3gp':
    case 'video/ogg':
    case 'video/avi':
    case 'video/mpeg':
      return source.mimeType;
  }
  const extension = source.name.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'webm':
      return 'video/webm';
    case 'ogv':
    case 'ogg':
      return 'video/ogg';
    case 'mov':
    case 'mkv':
      return 'video/object';
    default:
      return 'video/mp4';
  }
}
