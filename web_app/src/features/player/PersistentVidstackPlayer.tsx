import { connectHlsThumbnail } from './hlsDvr/thumbnail';
import { configureHlsDvr } from './hlsDvr/session';
import type { DvrStatus } from './hlsDvr/session';
import './videoFeedback.css';
import { connectVideoTapFeedback } from './videoTapFeedback';
import { connectAndroidVideoPip } from '../../core/platform/androidVideoPip';
import { nativeMessagePort } from '../../core/platform/nativeBridge';
import { androidShellBridge } from '../../core/platform/androidShell';
import { connectNativeVideoSurface } from './nativeVideoSurface';
import {
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
  type PlayerSrc,
  type HLSMimeType,
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

import {
  recordPlaybackDiagnosticMilestone,
} from '../../core/playback/diagnostics/playbackDiagnostics';
import type { PlaybackSource } from '../../core/playback/source/source';
import { TheaterGlyph } from '../../core/ui/AppIcons';
import { usePlayerStore } from './PlayerContext';
import { configureEmbeddedHLSProvider } from './hlsPlaybackSupport';
import { createVidstackEngine } from './vidstackEngine';
import { nativeVideoLoaders, supportsNativeVideo } from './nativeVideoProvider';
import { useOptionalPlayerOverlay } from './PlayerOverlayContext';
import { encodeNativeVideoSource } from './nativeVideoSource';

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
  const [dvrStatus, setDvrStatus] = useState<DvrStatus>({ kind: 'idle', seconds: 0 });
  const dvrCleanup = useRef<(() => void) | null>(null);
  const [tapFeedback, setTapFeedback] = useState<'play' | 'pause' | null>(null);
  const store = usePlayerStore();
  const overlay = useOptionalPlayerOverlay();
  const parkingHostRef = useRef<HTMLDivElement | null>(null);
  const [player, setPlayer] = useState<MediaPlayerInstance | null>(null);
  const [committedSource, setCommittedSource] = useState<CommittedSource>({
    source: null,
    revision: 0,
  });
  const nativeVideo = supportsNativeVideo() && !committedSource.source?.transient;
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

    recordPlaybackDiagnosticMilestone(
      'video_player_mount_ready',
      store.getState().video.source,
    );
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

  useLayoutEffect(() => connectAndroidVideoPip(portalRoot), [portalRoot]);
  useLayoutEffect(() => nativeVideo ? connectNativeVideoSurface(portalRoot) : undefined, [portalRoot, nativeVideo]);
  useLayoutEffect(() => {
    if (!nativeVideo) return;
    return androidShellBridge()?.subscribe?.((event) => {
      if (event.type === 'videoRestore') overlay?.open();
    });
  }, [nativeVideo, overlay]);

  useLayoutEffect(() => {
    if (!player?.el) return;
    return connectVideoTapFeedback(player.el, setTapFeedback);
  }, [player]);

  const source = committedSource.source;
  const transient = source?.transient === true;
  useLayoutEffect(() => {
    if (!player?.el || !source?.transient) return;
    return connectHlsThumbnail(player.el, source.url);
  }, [player, source?.mediaId, source?.url, source?.transient]);
  const dvrPlayerRef = useRef(player);
  dvrPlayerRef.current = player;
  const transientRef = useRef(transient);
  transientRef.current = transient;
  const configureProvider = useCallback((provider: MediaProviderAdapter | null) => {
    dvrCleanup.current?.(); dvrCleanup.current = null;
    setDvrStatus({ kind: 'idle', seconds: 0 });
    if (provider && transientRef.current) dvrCleanup.current = configureHlsDvr(provider, setDvrStatus, dvrPlayerRef.current);
    else configureEmbeddedHLSProvider(provider);
  }, []);
  useLayoutEffect(() => () => { dvrCleanup.current?.(); dvrCleanup.current = null; }, []);
  const playerSource: PlayerSrc | undefined =
    source === null
      ? undefined
      : {
          src: nativeVideo ? encodeNativeVideoSource(source.url) : source.url,
          type: nativeVideo ? 'video/muzio-native' : videoMimeTypeForSource(source),
        } as PlayerSrc;
  const layoutSlots = {
    bufferingIndicator: <div className="muzio-video-loading" role="status" aria-label="Buffering"><span /></div>,
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
          className={`muzio-video h-full w-full aspect-auto overflow-hidden bg-black [&_video]:h-full [&_video]:aspect-auto [&_video]:object-contain [&_.vds-controls-group:last-child]:mb-0 ${theaterMode
            ? 'rounded-none'
            : 'rounded-2xl'}`}
          style={{ display: 'flex', ...(theaterMode ? { border: 0 } : {}) }}
          src={playerSource}
          crossOrigin={nativeMessagePort() ? undefined : 'anonymous'}
          title={source?.title ?? source?.name ?? 'Video'}
          viewType="video"
          logLevel="silent"
          load="custom"
          preload="metadata"
          playsInline
          minLiveDVRWindow={transient ? 12 : 60}
          streamType={dvrStatus.kind === 'recording' && transient ? 'live:dvr' : transient ? 'unknown' : 'on-demand'}
          onProviderChange={configureProvider}
        >
          {/* Vidstack reuses a video outlet across loaders. Remount only the outlet
              when switching between native pixels and an actual HTML video. */}
          <MediaProvider key={`${nativeVideo ? 'native' : 'web'}-${transient ? `${source?.mediaId}/${source?.url}` : 'library'}`} loaders={nativeVideoLoaders} />
          {transient && dvrStatus.kind !== 'idle' && (
            <div className="muzio-dvr-status" role="status">
              {dvrStatus.kind === 'recording' ? `되감기 ${Math.floor(dvrStatus.seconds / 60)}분 · HLS별 서버 보관 최대 1GB` : '이 환경 또는 스트림에서는 임시 되감기를 사용할 수 없습니다.'}
            </div>
          )}
          {theaterMode && source && (
            <div className="muzio-theater-title" data-testid="video-theater-title">
              <span>{source.title ?? source.name}</span>
            </div>
          )}
          {tapFeedback && <div key={tapFeedback} className="muzio-video-feedback" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">{tapFeedback === 'play'
              ? <path d="M8 5v14l11-7z" />
              : <path d="M6 5h4v14H6zm8 0h4v14h-4z" />}</svg>
          </div>}
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

export function videoMimeTypeForSource(source: PlaybackSource): VideoMimeType | HLSMimeType {
  switch (source.mimeType) {
    case 'application/vnd.apple.mpegurl':
      return source.mimeType;
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
