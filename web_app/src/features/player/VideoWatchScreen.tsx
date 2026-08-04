import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

import type { FallbackPlan } from '../../core/api/fallbackClient';
import type { LibraryItem } from '../../core/api/libraryClient';
import {
  buildStreamingUrl,
  playbackSourceFromLibraryItem,
} from '../../core/playback/source/source';
import { useLibraryStores, useLibraryThumbnail } from '../library/LibraryContext';
import {
  formatDuration,
  formatModified,
  formatSize,
} from '../library/formatLibraryItem';
import { progressFractionFor, resumePositionFor } from '../progress/progressPolicy';
import { useProgressRecord } from '../progress/ProgressContext';
import {
  DownChevronIcon,
  OpenExternalGlyph,
  ShareGlyph,
  VideoGlyph,
} from '../../core/ui/AppIcons';
import { usePlayerStore } from './PlayerContext';
import { formatTime } from './formatTime';
import { useVideoTheaterMode, VideoViewport } from './VideoMount';
import type { Playability } from '../../core/playback/capabilities/canPlayMime';
import type { PlaybackSource } from '../../core/playback/source/source';
import type { VideoOptimizationStatus } from '../../core/api/videoOptimizationClient';
import {
  restoreOriginalVideoSource,
  videoOptimizationService,
} from './videoOptimizationService';

const WATCH_GESTURE_EXIT_MS = 180;
const WATCH_GESTURE_SETTLE_MS = 200;

export type VideoFallbackState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; plan: FallbackPlan }
  | { kind: 'error' };

interface VideoWatchScreenProps {
  shellRef: RefObject<HTMLDivElement>;
  source: PlaybackSource | null;
  sourceName: string;
  sourceDetail: string;
  positionSec: number;
  durationSec: number;
  playability: Playability;
  fallbackState: VideoFallbackState;
  onCollapse: () => void;
}

type VideoLibraryItem = LibraryItem & { type: 'video' };

export function VideoWatchScreen({
  shellRef,
  source,
  sourceName,
  sourceDetail,
  positionSec,
  durationSec,
  playability,
  fallbackState,
  onCollapse,
}: VideoWatchScreenProps) {
  const videoStore = useLibraryStores().video;
  const videoStatus = videoStore((state) => state.status);
  const videoResult = videoStore((state) => state.result);
  const videoStale = videoStore((state) => state.stale);
  const currentProgress = useProgressRecord(source?.mediaId ?? '');
  const { theaterMode } = useVideoTheaterMode();

  useEffect(() => {
    const shouldLoad =
      videoStatus === 'idle' || (videoStatus === 'ok' && videoStale);
    if (!shouldLoad) return;
    void videoStore.getState().load({ preserveResult: true });
  }, [videoStatus, videoStale, videoStore]);

  const videoItems = useMemo(
    () =>
      videoResult?.kind === 'ok'
        ? videoResult.items.filter(isVideoItem)
        : [],
    [videoResult],
  );
  const currentItem =
    source === null
      ? null
      : videoItems.find((item) => item.id === source.mediaId) ?? null;
  const title =
    source?.title ?? currentItem?.metadata?.title ?? sourceName;
  const detailRows = videoDetailRows({
    currentItem,
    currentProgress,
    durationSec,
    positionSec,
    source,
    sourceDetail,
  });
  const watchGesture = useVideoWatchGesture({
    onDismiss: onCollapse,
  });

  return (
    <div
      ref={shellRef}
      data-testid="player-screen"
      className="relative h-[100svh] touch-auto overflow-hidden overscroll-y-contain bg-transparent text-[var(--color-fg)]"
    >
      <div
        data-testid="player-motion-layer"
        className={`relative z-10 h-[100svh] overflow-hidden bg-[var(--color-bg)] lg:h-screen ${watchGesture.motionClassName}`}
        style={watchGesture.motionStyle}
      >
        <DismissButton
          label="Collapse video player"
          onCollapse={onCollapse}
        />
        <main
          data-testid="video-watch-layout"
          className={`mx-auto grid h-full min-h-0 w-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] content-stretch gap-5 px-0 pb-0 pt-14 sm:px-6 sm:pt-16 lg:h-screen lg:min-h-screen lg:gap-[var(--video-watch-gutter)] ${
            theaterMode
              ? 'max-w-none lg:grid-cols-1 lg:grid-rows-[auto_minmax(0,1fr)] lg:px-0 lg:pb-0'
              : 'max-w-[var(--video-watch-max-width)] lg:grid-cols-[minmax(0,1fr)_var(--video-watch-sidebar-width)] lg:grid-rows-none lg:items-start lg:px-8 lg:pb-8'
          }`}
        >
          <section
            data-testid="video-primary-column"
            className={`min-w-0 ${theaterMode ? 'lg:col-span-full' : ''}`}
            ref={watchGesture.setPrimaryHost}
          >
            <div
              data-testid="video-viewport-shell"
              className="relative"
            >
              <VideoViewport
                className={`aspect-video w-full touch-none overflow-hidden rounded-none bg-black sm:rounded-[var(--video-watch-radius)] ${
                  theaterMode ? 'lg:rounded-none' : ''
                }`}
                onHostChange={watchGesture.setFullscreenHost}
              />
            </div>
            <section
              data-testid="video-info"
              className="px-4 pt-4 sm:px-0"
              aria-label="Video information"
            >
              <h1
                data-testid="video-player-title"
                className="break-words text-xl font-semibold leading-7 tracking-normal text-[var(--color-fg)] sm:text-2xl sm:leading-8"
                title={title}
              >
                {title}
              </h1>
              <p className="mt-1 break-words text-sm leading-5 text-[var(--color-muted)]">
                {sourceDetail}
              </p>
              <ExternalPlaybackActions source={source} title={title} />
              <VideoOptimizationPanel source={source} positionSec={positionSec} playability={playability} />
              {playability === 'no' && (
                <div className="mt-3 rounded-[var(--video-watch-row-radius)] border border-[color:var(--color-border)] bg-[var(--color-control)] px-3 py-2">
                  <p
                    data-testid="unsupported-banner"
                    className="text-sm leading-5 text-amber-200"
                  >
                    The browser reports that this format may not play. Direct
                    play will still be attempted.
                  </p>
                  <FallbackStatusView fallbackState={fallbackState} />
                </div>
              )}
            </section>

          </section>

          <section
            data-testid="video-secondary-column"
            data-allow-scroll
            className={`min-h-0 min-w-0 touch-pan-y overflow-y-auto overscroll-contain px-4 pb-6 pr-5 sm:px-0 sm:pr-1 ${
              theaterMode
                ? 'lg:overflow-y-auto lg:overscroll-contain lg:px-8 lg:pb-8 lg:pr-8'
                : 'lg:contents lg:touch-auto lg:overflow-visible lg:overscroll-auto lg:p-0'
            }`}
            ref={watchGesture.setSecondaryHost}
          >
            <VideoDescription
              detailRows={detailRows}
              gestureRef={watchGesture.setDesktopDescriptionHost}
            />
            <VideoUpNextList
              currentMediaId={source?.mediaId ?? null}
              items={videoItems}
              status={videoStatus}
            />
          </section>
        </main>
      </div>
    </div>
  );
}

function VideoOptimizationPanel({
  source,
  positionSec,
  playability,
}: {
  source: PlaybackSource | null;
  positionSec: number;
  playability: Playability;
}) {
  const store = usePlayerStore();
  const playSource = store((state) => state.playSource);
  const [status, setStatus] = useState<VideoOptimizationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const mediaId = source?.mediaId ?? '';

  useEffect(() => {
    if (mediaId === '') { setStatus(null); return; }
    let cancelled = false;
    let timer: number | null = null;
    const refresh = async () => {
      const next = await videoOptimizationService.status(mediaId, true);
      if (cancelled) return;
      setStatus(next);
      if (next?.state === 'building') {
        timer = window.setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [mediaId, refreshVersion]);

  if (source === null || status === null) return null;
  const run = async (action: () => Promise<VideoOptimizationStatus | null>) => {
    setBusy(true);
    try {
      const next = await action();
      setStatus(next);
      if (next?.state === 'building') setRefreshVersion((value) => value + 1);
    } finally { setBusy(false); }
  };
  const usingReady = status.url !== undefined && source.url.startsWith(status.url);

  return (
    <section
      data-testid="video-optimization"
      className="mt-3 rounded-[var(--video-watch-row-radius)] border border-[color:var(--color-border)] bg-[var(--color-control)] px-3 py-3"
      aria-label="Faster playback copy"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-fg)]">Faster playback copy</p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-muted)]">
            {optimizationMessage(status, usingReady, playability)}
          </p>
          {status.eligible && status.state !== 'ready' && (
            <p className="text-xs leading-5 text-[var(--color-muted)]">
              Estimated {formatSize(status.estimatedOutputBytes)} · free {formatSize(status.availableBytes)} · peak cache {formatSize(status.peakCacheBytes)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(status.state === 'eligible' || status.state === 'failed') && playability !== 'no' && (
            <button type="button" disabled={busy} onClick={() => void run(() => videoOptimizationService.prepare(mediaId))} className="rounded-full border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
              {status.state === 'failed' ? 'Retry preparation' : 'Prepare faster playback'}
            </button>
          )}
          {status.state === 'building' && (
            <button type="button" disabled={busy} onClick={() => void run(() => videoOptimizationService.cancel(mediaId))} className="rounded-full border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
              Cancel build
            </button>
          )}
          {status.state === 'ready' && !usingReady && (
            <button type="button" disabled={busy} onClick={() => {
              const direct = { ...source, url: buildStreamingUrl(mediaId, { startSec: positionSec }) };
              void playSource(videoOptimizationService.resolve(direct));
            }} className="rounded-full border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
              Use faster copy
            </button>
          )}
          {status.state === 'ready' && usingReady && (
            <button type="button" disabled={busy} onClick={() => {
              videoOptimizationService.preferOriginal(mediaId);
              void playSource(restoreOriginalVideoSource(source, positionSec));
            }} className="rounded-full border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
              Use original
            </button>
          )}
          {status.state === 'ready' && !usingReady && status.cacheKey !== undefined && (
            <button type="button" disabled={busy} onClick={() => void run(() => videoOptimizationService.clear(mediaId, status.cacheKey!))} className="rounded-full border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
              Clear copy
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function optimizationMessage(status: VideoOptimizationStatus, usingReady: boolean, playability: Playability): string {
  if (status.state === 'ready') return usingReady ? 'Playing the immutable faststart copy.' : 'The copy is ready. It will be selected for later playback.';
  if (status.state === 'building') return 'Preparing in the background. Existing playback stays on the original file.';
  if (status.state === 'insufficient-space') return 'Not enough free space to build the copy safely.';
  if (status.state === 'failed') return status.reason ?? 'Preparation failed. Direct playback remains available.';
  if (status.state === 'eligible' && playability === 'no') return 'The browser reports this codec as unsupported, so a container-only copy would not help. Direct playback remains available.';
  if (status.state === 'eligible') return 'This end-moov file can be copied without re-encoding. The original is never modified.';
  if (status.layout === 'front-moov' && (status.movieIndexBytes ?? 0) >= 16 * 1024 * 1024) return 'The index is already at the front, so faststart cannot help. This large index is a segmented-playback candidate for 1.4.2.';
  if (status.layout === 'front-moov') return 'This file already has a front-loaded index; no faster copy is needed.';
  if (status.layout === 'fragmented') return 'Fragmented MP4 is not copied by this faststart cache; direct playback remains available.';
  return status.reason ?? 'This file is not eligible; direct playback remains available.';
}

function VideoDescription({
  detailRows,
  gestureRef,
}: {
  detailRows: Array<{ label: string; value: string }>;
  gestureRef: (host: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={gestureRef}
      data-testid="video-description"
      aria-label="Video description"
      className="rounded-[var(--video-watch-radius)] border border-[color:var(--color-border)] bg-[var(--color-control)] p-4 lg:col-start-1 lg:row-start-2 lg:mt-0"
    >
      <dl className="grid gap-3 text-sm leading-5 sm:grid-cols-2">
        {detailRows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs font-medium text-[var(--color-muted)]">
              {row.label}
            </dt>
            <dd className="mt-0.5 break-words text-[var(--color-fg)]">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ExternalPlaybackActions({
  source,
  title,
}: {
  source: PlaybackSource | null;
  title: string;
}) {
  const [message, setMessage] = useState('');
  if (source === null) return null;
  const url = absolutePlaybackUrl(source.url);

  const openStream = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const shareStream = async () => {
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        setMessage('Stream URL shared.');
        return;
      }
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(url);
        setMessage('Stream URL copied.');
        return;
      }
      setMessage('Sharing is not available.');
    } catch (error) {
      if (isAbortError(error)) return;
      setMessage('Sharing failed.');
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="video-open-stream"
        className="inline-flex h-9 items-center gap-2 rounded-[var(--video-watch-row-radius)] border border-[color:var(--color-border)] bg-[var(--color-control)] px-3 text-sm font-medium leading-5 text-[var(--color-fg)] transition hover:bg-[var(--color-control-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={openStream}
      >
        <OpenExternalGlyph className="h-4 w-4" />
        Open stream
      </button>
      <button
        type="button"
        data-testid="video-share-stream"
        className="inline-flex h-9 items-center gap-2 rounded-[var(--video-watch-row-radius)] border border-[color:var(--color-border)] bg-[var(--color-control)] px-3 text-sm font-medium leading-5 text-[var(--color-fg)] transition hover:bg-[var(--color-control-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => {
          void shareStream();
        }}
      >
        <ShareGlyph className="h-4 w-4" />
        Share stream
      </button>
      {message !== '' && (
        <span
          role="status"
          className="text-xs leading-4 text-[var(--color-muted)]"
        >
          {message}
        </span>
      )}
    </div>
  );
}

function absolutePlaybackUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  return new URL(url, window.location.href).href;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function DismissButton({
  label,
  onCollapse,
}: {
  label: string;
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="player-close"
      aria-label={label}
      className="fixed left-3 top-3 z-30 inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-fg)] transition hover:bg-[var(--color-control-hover)] sm:left-5 sm:top-5"
      onClick={onCollapse}
    >
      <DownChevronIcon />
    </button>
  );
}

function VideoUpNextList({
  currentMediaId,
  items,
  status,
}: {
  currentMediaId: string | null;
  items: VideoLibraryItem[];
  status: string;
}) {
  const visibleItems = items.slice(0, 24);

  return (
    <aside
      data-testid="video-side-list"
      data-no-dismiss-gesture
      aria-label="Video list"
      className="mt-4 min-w-0 touch-pan-y lg:sticky lg:top-[var(--video-watch-list-desktop-top)] lg:col-start-2 lg:row-start-1 lg:mt-0"
    >
      <h2 className="mb-3 text-base font-semibold text-[var(--color-fg)]">
        Videos
      </h2>
      <div
        data-testid="video-side-scrollport"
        className="min-h-0 touch-pan-y pr-1 lg:max-h-[var(--video-watch-list-desktop-max-height)] lg:overflow-y-auto lg:overscroll-contain"
      >
        {status === 'loading' && visibleItems.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">Loading videos...</p>
        ) : visibleItems.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No videos found.
          </p>
        ) : (
          <ol data-testid="video-up-next-list" className="grid touch-pan-y gap-2">
            {visibleItems.map((item) => (
              <VideoUpNextRow
                key={item.id}
                current={item.id === currentMediaId}
                item={item}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function VideoUpNextRow({
  current,
  item,
}: {
  current: boolean;
  item: VideoLibraryItem;
}) {
  const store = usePlayerStore();
  const playSource = store.getState().playSource;
  const progressRecord = useProgressRecord(item.id);
  const fraction = progressFractionFor(progressRecord);
  const duration = formatDuration(item.metadata?.durationSec);
  const detail = [item.rootName, item.relativePath].filter(Boolean).join(' / ');
  const title = item.metadata?.title ?? item.name;
  const progressLabel =
    fraction === null
      ? ''
      : fraction >= 1
        ? 'Watched'
        : `${Math.round(fraction * 100)}% watched`;

  const play = () => {
    if (current) return;
    const source = playbackSourceFromLibraryItem(item);
    const startSec = resumePositionFor(progressRecord) ?? undefined;
    if (startSec !== undefined && source.kind === 'remote') {
      source.url = buildStreamingUrl(item.id, { startSec });
    }
    void playSource(source);
  };

  return (
    <li>
      <button
        type="button"
        aria-current={current ? 'true' : undefined}
        aria-label={current ? `Now playing ${item.name}` : `Play ${item.name}`}
        className={`grid w-full touch-pan-y grid-cols-[var(--video-watch-thumb-width)_minmax(0,1fr)] gap-3 rounded-[var(--video-watch-row-radius)] p-1.5 text-left transition hover:bg-[var(--color-control-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-100 disabled:hover:bg-[var(--color-control)] ${
          current ? 'bg-[var(--color-control)]' : ''
        }`}
        disabled={current}
        onClick={play}
      >
        <VideoThumbnail item={item} />
        <span className="min-w-0 py-0.5">
          {current && (
            <span className="mb-1 block text-xs font-medium leading-4 text-[var(--color-accent)]">
              Now playing
            </span>
          )}
          <span className="line-clamp-2 break-words text-sm font-medium leading-5 text-[var(--color-fg)]">
            {title}
          </span>
          <span className="mt-1 block truncate text-xs leading-4 text-[var(--color-muted)]">
            {detail}
          </span>
          <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs leading-4 text-[var(--color-muted)]">
            {duration !== '' && <span>{duration}</span>}
            {progressLabel !== '' && <span>{progressLabel}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function VideoThumbnail({ item }: { item: VideoLibraryItem }) {
  const [failed, setFailed] = useState(false);
  const thumbnail = useLibraryThumbnail(item);
  const thumbnailUrl =
    thumbnail?.url && thumbnail.status !== 'missing'
      ? thumbnail.url
      : null;
  useEffect(() => {
    setFailed(false);
  }, [thumbnailUrl]);
  if (thumbnailUrl !== null && !failed) {
    return (
      <span className="relative h-[var(--video-watch-thumb-height)] w-[var(--video-watch-thumb-width)] overflow-hidden rounded-[var(--video-watch-row-radius)] bg-black">
        <img
          src={thumbnailUrl}
          alt=""
          aria-hidden
          decoding="async"
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-[var(--video-watch-thumb-height)] w-[var(--video-watch-thumb-width)] items-center justify-center rounded-[var(--video-watch-row-radius)] bg-[var(--color-control)] text-[var(--color-muted)]"
    >
      <VideoGlyph className="h-6 w-6" />
    </span>
  );
}

function videoDetailRows({
  currentItem,
  currentProgress,
  durationSec,
  positionSec,
  source,
  sourceDetail,
}: {
  currentItem: VideoLibraryItem | null;
  currentProgress: ReturnType<typeof useProgressRecord>;
  durationSec: number;
  positionSec: number;
  source: PlaybackSource | null;
  sourceDetail: string;
}): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const root = currentItem?.rootName ?? source?.rootName;
  const path = currentItem?.relativePath ?? source?.relativePath;
  if (root) rows.push({ label: 'Root', value: root });
  if (path) rows.push({ label: 'Path', value: path });
  if (!root && !path) rows.push({ label: 'Source', value: sourceDetail });

  const knownDuration =
    durationSec > 0
      ? durationSec
      : currentItem?.metadata?.durationSec ?? currentProgress?.durationSec ?? 0;
  if (knownDuration > 0) {
    rows.push({ label: 'Duration', value: formatTime(knownDuration) });
  }
  if (durationSec > 0) {
    rows.push({
      label: 'Progress',
      value: `${formatTime(positionSec)} / ${formatTime(durationSec)}`,
    });
  } else if (currentProgress !== null && currentProgress.durationSec > 0) {
    rows.push({
      label: 'Saved progress',
      value: `${formatTime(currentProgress.positionSec)} / ${formatTime(
        currentProgress.durationSec,
      )}`,
    });
  }
  if (
    currentItem !== null &&
    Number.isFinite(currentItem.sizeBytes) &&
    currentItem.sizeBytes >= 0
  ) {
    rows.push({ label: 'Size', value: formatSize(currentItem.sizeBytes) });
  }
  if (currentItem?.modifiedAt) {
    rows.push({
      label: 'Modified',
      value: formatModified(currentItem.modifiedAt),
    });
  }
  if (rows.length === 0) {
    rows.push({ label: 'Video', value: 'Metadata unavailable' });
  }
  return rows;
}

export function FallbackStatusView({
  fallbackState,
}: {
  fallbackState: VideoFallbackState;
}) {
  if (fallbackState.kind === 'idle') return null;
  if (fallbackState.kind === 'loading') {
    return (
      <p data-testid="fallback-status" className="mt-2 text-xs text-white/60">
        Checking fallback...
      </p>
    );
  }
  if (fallbackState.kind === 'error') {
    return (
      <p data-testid="fallback-status" className="mt-2 text-xs text-white/60">
        Fallback status unavailable. Direct play will still be attempted.
      </p>
    );
  }
  const { plan } = fallbackState;
  const text =
    plan.status === 'disabled'
      ? `Fallback unavailable: ${plan.reason}`
      : `Fallback available: ${fallbackActionLabel(plan.action)}. ${plan.reason}`;
  return (
    <p data-testid="fallback-status" className="mt-2 text-xs text-white/60">
      {text}
    </p>
  );
}

function fallbackActionLabel(action: FallbackPlan['action']): string {
  switch (action) {
    case 'remux':
      return 'remux';
    case 'audio_transcode':
      return 'audio transcode';
    case 'video_transcode':
      return 'video transcode';
    case 'disabled':
      return 'disabled';
    case 'direct':
      return 'direct play';
  }
}

function isVideoItem(item: LibraryItem): item is VideoLibraryItem {
  return item.type === 'video';
}

function useVideoWatchGesture({
  onDismiss,
}: {
  onDismiss: () => void;
}): {
  setPrimaryHost: (host: HTMLElement | null) => void;
  setSecondaryHost: (host: HTMLElement | null) => void;
  setDesktopDescriptionHost: (host: HTMLElement | null) => void;
  setFullscreenHost: (host: HTMLDivElement | null) => void;
  motionClassName: string;
  motionStyle: CSSProperties;
} {
  const [primaryHost, setPrimaryHost] = useState<HTMLElement | null>(null);
  const [secondaryHost, setSecondaryHost] = useState<HTMLElement | null>(null);
  const [desktopDescriptionHost, setDesktopDescriptionHost] =
    useState<HTMLElement | null>(null);
  const [fullscreenHost, setFullscreenHost] = useState<HTMLDivElement | null>(
    null,
  );
  const startRef = useRef<{
    allowFullscreen: boolean;
    host: HTMLElement;
    lastY: number;
    x: number;
    y: number;
  } | null>(null);
  const timerRefs = useRef<number[]>([]);
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const [exiting, setExiting] = useState(false);

  const schedule = useCallback((callback: () => void, ms: number) => {
    const id = window.setTimeout(callback, ms);
    timerRefs.current.push(id);
  }, []);

  useEffect(() => {
    return () => {
      for (const id of timerRefs.current) window.clearTimeout(id);
      timerRefs.current = [];
    };
  }, []);

  const startGesture = useCallback(
    (target: EventTarget | null, host: HTMLElement, x: number, y: number) => {
      if (
        host === desktopDescriptionHost &&
        !isLargeViewport()
      ) {
        return;
      }
      const targetNode = target instanceof Node ? target : null;
      startRef.current = {
        allowFullscreen:
          fullscreenHost !== null &&
          targetNode !== null &&
          fullscreenHost.contains(targetNode),
        host,
        lastY: y,
        x,
        y,
      };
      setSettling(false);
      setExiting(false);
    },
    [desktopDescriptionHost, fullscreenHost],
  );

  const moveGesture = useCallback(
    (x: number, y: number) => {
      const start = startRef.current;
      if (start === null) return;

      const deltaX = Math.abs(x - start.x);
      const deltaY = y - start.y;
      if (Math.abs(deltaY) <= deltaX * 1.35) {
        setOffset(0);
        start.lastY = y;
        return;
      }
      if (
        start.host === primaryHost &&
        !start.allowFullscreen &&
        !isLargeViewport() &&
        deltaY < 0 &&
        secondaryHost !== null
      ) {
        secondaryHost.scrollTop += start.lastY - y;
        start.lastY = y;
        setOffset(0);
        return;
      }
      start.lastY = y;
      setOffset(deltaY > 0 ? Math.min(deltaY, window.innerHeight || 720) : 0);
    },
    [primaryHost, secondaryHost],
  );

  const finishGesture = useCallback(
    (x: number, y: number) => {
      const start = startRef.current;
      startRef.current = null;
      if (start === null) return;

      const deltaX = Math.abs(x - start.x);
      const deltaY = y - start.y;
      const dismissThreshold = Math.min(
        180,
        Math.max(110, window.innerHeight * 0.16),
      );
      const fullscreenThreshold = Math.min(
        128,
        Math.max(72, window.innerHeight * 0.1),
      );

      if (deltaY > dismissThreshold && deltaY > deltaX * 1.35) {
        if (exitActiveFullscreen(fullscreenHost)) {
          setSettling(true);
          setOffset(0);
          schedule(() => setSettling(false), WATCH_GESTURE_SETTLE_MS);
          return;
        }
        setExiting(true);
        setOffset(window.innerHeight || 720);
        schedule(onDismiss, WATCH_GESTURE_EXIT_MS);
        return;
      }

      if (
        start.allowFullscreen &&
        -deltaY > fullscreenThreshold &&
        -deltaY > deltaX * 1.2 &&
        fullscreenHost !== null
      ) {
        requestViewportFullscreen(fullscreenHost);
      }

      setSettling(true);
      setOffset(0);
      schedule(() => setSettling(false), WATCH_GESTURE_SETTLE_MS);
    },
    [fullscreenHost, onDismiss, schedule],
  );

  const cancelGesture = useCallback(() => {
    startRef.current = null;
    setSettling(true);
    setOffset(0);
    schedule(() => setSettling(false), WATCH_GESTURE_SETTLE_MS);
  }, [schedule]);

  useEffect(() => {
    const hosts = [primaryHost, desktopDescriptionHost].filter(
      (host): host is HTMLElement => host !== null,
    );
    if (hosts.length === 0) return;

    const addHandlers = (host: HTMLElement) => {
      const onPointerDown = (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        if (event.pointerType === 'mouse') {
          if (event.button !== 0) return;
          if (isInteractiveGestureTarget(event.target)) return;
        }
        startGesture(event.target, host, event.clientX, event.clientY);
      };
      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        if (event.pointerType === 'mouse' && event.buttons !== 1) return;
        moveGesture(event.clientX, event.clientY);
      };
      const onPointerUp = (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        finishGesture(event.clientX, event.clientY);
      };
      const onTouchStart = (event: TouchEvent) => {
        const touch = event.touches[0];
        if (!touch) return;
        startGesture(event.target, host, touch.clientX, touch.clientY);
      };
      const onTouchMove = (event: TouchEvent) => {
        const start = startRef.current;
        const touch = event.touches[0];
        if (start === null || !touch) return;

        const deltaX = Math.abs(touch.clientX - start.x);
        const deltaY = touch.clientY - start.y;
        const isPrimaryInfoScroll =
          start.host === primaryHost &&
          !start.allowFullscreen &&
          !isLargeViewport() &&
          deltaY < 0;
        const shouldOwnVerticalGesture =
          isPrimaryInfoScroll ||
          deltaY > 0 ||
          (start.allowFullscreen && deltaY < 0);
        if (
          shouldOwnVerticalGesture &&
          Math.abs(deltaY) > 12 &&
          Math.abs(deltaY) > deltaX * 1.2 &&
          event.cancelable
        ) {
          event.preventDefault();
        }
        moveGesture(touch.clientX, touch.clientY);
      };
      const onTouchEnd = (event: TouchEvent) => {
        const touch = event.changedTouches[0];
        if (!touch) {
          startRef.current = null;
          return;
        }
        finishGesture(touch.clientX, touch.clientY);
      };

      host.addEventListener('pointerdown', onPointerDown, { capture: true });
      host.addEventListener('pointermove', onPointerMove, { capture: true });
      host.addEventListener('pointerup', onPointerUp, { capture: true });
      host.addEventListener('pointercancel', cancelGesture, { capture: true });
      host.addEventListener('touchstart', onTouchStart, {
        capture: true,
        passive: true,
      });
      host.addEventListener('touchmove', onTouchMove, {
        capture: true,
        passive: false,
      });
      host.addEventListener('touchend', onTouchEnd, { capture: true });
      host.addEventListener('touchcancel', cancelGesture, { capture: true });

      return () => {
        host.removeEventListener('pointerdown', onPointerDown, {
          capture: true,
        });
        host.removeEventListener('pointermove', onPointerMove, {
          capture: true,
        });
        host.removeEventListener('pointerup', onPointerUp, { capture: true });
        host.removeEventListener('pointercancel', cancelGesture, {
          capture: true,
        });
        host.removeEventListener('touchstart', onTouchStart, {
          capture: true,
        });
        host.removeEventListener('touchmove', onTouchMove, { capture: true });
        host.removeEventListener('touchend', onTouchEnd, { capture: true });
        host.removeEventListener('touchcancel', cancelGesture, {
          capture: true,
        });
      };
    };

    const cleanup = hosts.map(addHandlers);
    return () => {
      for (const removeHandlers of cleanup) removeHandlers();
    };
  }, [
    cancelGesture,
    desktopDescriptionHost,
    finishGesture,
    moveGesture,
    primaryHost,
    secondaryHost,
    startGesture,
  ]);

  return {
    setDesktopDescriptionHost,
    setFullscreenHost,
    setPrimaryHost,
    setSecondaryHost,
    motionClassName:
      settling || exiting ? 'transition-transform duration-200 ease-out' : '',
    motionStyle: { transform: `translateY(${offset}px)` },
  };
}

function requestViewportFullscreen(host: HTMLDivElement) {
  const video = host.querySelector('video') as
    | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
    | null;
  if (typeof video?.webkitEnterFullscreen === 'function') {
    video.webkitEnterFullscreen();
    return;
  }

  const target = host.querySelector('[data-testid="video-mount"]') ?? host;
  void target.requestFullscreen?.();
}

function exitActiveFullscreen(host: HTMLDivElement | null): boolean {
  if (document.fullscreenElement != null) {
    void document.exitFullscreen?.();
    return true;
  }

  const documentWithWebkit = document as Document & {
    webkitExitFullscreen?: () => void;
    webkitFullscreenElement?: Element | null;
  };
  if (documentWithWebkit.webkitFullscreenElement != null) {
    documentWithWebkit.webkitExitFullscreen?.();
    return true;
  }

  const video = host?.querySelector('video') as
    | (HTMLVideoElement & {
        webkitDisplayingFullscreen?: boolean;
        webkitExitFullscreen?: () => void;
      })
    | null;
  if (video?.webkitDisplayingFullscreen === true) {
    video.webkitExitFullscreen?.();
    return true;
  }

  return false;
}

function isLargeViewport(): boolean {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(min-width: 1024px)').matches;
  }
  return window.innerWidth >= 1024;
}

function isInteractiveGestureTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(
    [
      'a',
      'button',
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[role="button"]',
      '[role="slider"]',
      '[role="spinbutton"]',
      '[role="switch"]',
      'media-controls',
      'media-slider',
      'media-time-slider',
      'media-volume-slider',
      'media-mute-button',
      'media-play-button',
      'media-fullscreen-button',
      'media-pip-button',
      'media-seek-button',
    ].join(','),
  ) !== null;
}
