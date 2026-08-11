import {
  useEffect,
  memo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';

import type { BackgroundLocationState } from '../../app/backgroundLocation';
import type { LibraryItem } from '../../core/api/libraryClient';
import { contentKeyForLibraryItem, contentKeysForLibraryItem } from '../../core/media/contentIdentity';
import {
  buildStreamingUrl,
  isPlayableLibraryItem,
  playbackSourceFromLibraryItem,
  type PlaybackSource,
} from '../../core/playback/source/source';
import {
  ImageGlyph,
  LikeGlyph,
  MoreGlyph,
  MusicGlyph,
  VideoGlyph,
} from '../../core/ui/AppIcons';
import { usePlayerStore } from '../player/PlayerContext';
import { useOptionalPlayerOverlay } from '../player/PlayerOverlayContext';
import {
  useProgressRecord,
  useProgressRepository,
} from '../progress/ProgressContext';
import {
  progressFractionFor,
  resumePositionFor,
} from '../progress/progressPolicy';
import {
  formatModified,
  formatDuration,
  formatSize,
  splitPath,
} from './formatLibraryItem';
import { useLibraryThumbnail } from './LibraryContext';

const LONG_PRESS_DELAY_MS = 760;
const MOUSE_LONG_PRESS_DELAY_MS = 480;
const LONG_PRESS_MOVE_TOLERANCE_PX = 12;

/**
 * Single dense list row. The play button hands the source to the player
 * store; for video it opens the full-player overlay when that surface is
 * available.
 *
 * The progress bar appears for video rows only; music does not need a
 * visual cue per Apple Music conventions and a per-track stripe would
 * crowd the row.
 */
function LibraryItemRowComponent({
  item,
  onLongPress,
  onOpenAddToPlaylist,
  onToggleSelected,
  queueItems = [item],
  selected = false,
  selectionMode = false,
  style,
}: {
  item: LibraryItem;
  onLongPress?: (item: LibraryItem) => void;
  onOpenAddToPlaylist?: (items: LibraryItem[]) => void;
  onToggleSelected?: (item: LibraryItem) => void;
  queueItems?: readonly LibraryItem[];
  selected?: boolean;
  selectionMode?: boolean;
  style?: CSSProperties;
}) {
  const { directory, filename } = splitPath(item.relativePath);
  const metadata = item.metadata;
  const displayTitle = metadata?.title || filename;
  const details = metadataDetails(item);
  const store = usePlayerStore();
  const playSource = store((s) => s.playSource);
  const prefetchVideoOptimization = store((s) => s.prefetchVideoOptimization);
  const playMusicQueue = store((s) => s.playMusicQueue);
  const insertQueueItemAfterCurrentAndPlay = store(
    (s) => s.insertQueueItemAfterCurrentAndPlay,
  );
  const musicQueue = store((s) => s.musicQueue);
  const toggleLike = store((s) => s.toggleLike);
  const likedMediaIds = store((s) => s.likedMediaIds);
  const playerOverlay = useOptionalPlayerOverlay();
  const navigate = useNavigate();
  const location = useLocation();
  const progressRepo = useProgressRepository();
  const progressRecord = useProgressRecord(item.id);
  const resolvedThumbnail = useLibraryThumbnail(item);
  const likeKey = contentKeyForLibraryItem(item);
  const liked = contentKeysForLibraryItem(item).some((key) => likedMediaIds.includes(key)) || likedMediaIds.includes(item.id);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!optionsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-row-options-shell]')
      ) {
        return;
      }
      setOptionsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOptionsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [optionsOpen]);

  const handlePrimaryAction = () => {
    clearLongPress();
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    if (selectionMode) {
      onToggleSelected?.(item);
      return;
    }
    if (item.type === 'image') {
      navigate(`/image/${encodeURIComponent(item.id)}`, {
        state: {
          backgroundLocation: location,
        } satisfies BackgroundLocationState,
      });
      return;
    }
    if (!isPlayableLibraryItem(item)) return;

    const record =
      item.type === 'video' ? progressRecord : progressRepo.read(item.id);
    const startSec = resumePositionFor(record) ?? undefined;
    const playbackItem =
      resolvedThumbnail === undefined
        ? item
        : { ...item, thumbnail: resolvedThumbnail };
    const source = playbackSourceFromLibraryItem(playbackItem);
    if (startSec !== undefined && source.kind === 'remote') {
      // Start the request directly at the resume offset via media fragment
      // so the browser does not first load byte 0 and then re-buffer for
      // a JS-driven seek.
      source.url = buildStreamingUrl(item.id, { startSec });
    }
    if (item.type === 'audio') {
      if (musicQueue.length === 0) {
        const queueSources: PlaybackSource[] = [];
        for (const queueItem of queueItems) {
          if (!isPlayableLibraryItem(queueItem) || queueItem.type !== 'audio') {
            continue;
          }
          queueSources.push(
            queueItem.id === item.id
              ? source
              : playbackSourceFromLibraryItem(queueItem),
          );
        }
        void playMusicQueue(queueSources, item.id);
      } else {
        void insertQueueItemAfterCurrentAndPlay(source);
      }
    } else {
      void playSource(source);
    }
    if (item.type === 'video') {
      if (playerOverlay !== null) {
        playerOverlay.open();
      } else {
        navigate('/player');
      }
    }
  };

  const prefetchVideoSidecar = () => {
    if (item.type === 'video') prefetchVideoOptimization(item.id);
  };

  const fraction =
    item.type === 'video'
      ? progressFractionFor(progressRecord)
      : null;
  const progressPercent = fraction === null ? 0 : Math.round(fraction * 100);
  const progressLabel =
    item.type === 'video' && fraction !== null
      ? fraction >= 1
        ? 'Watched'
        : `${progressPercent}%`
      : '';
  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  };
  const beginLongPress = (event: {
    target: EventTarget | null;
    clientX: number;
    clientY: number;
    pointerType: string;
  }) => {
    if (item.type === 'image') return;
    if (selectionMode) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-row-action]')) return;
    clearLongPress();
    longPressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onLongPress?.(item);
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
    }, event.pointerType === 'mouse' ? MOUSE_LONG_PRESS_DELAY_MS : LONG_PRESS_DELAY_MS);
  };
  const handlePointerMove = (event: { clientX: number; clientY: number }) => {
    const start = longPressStartRef.current;
    if (start === null) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > LONG_PRESS_MOVE_TOLERANCE_PX) clearLongPress();
  };
  const openAddToPlaylist = () => {
    setOptionsOpen(false);
    onOpenAddToPlaylist?.([item]);
  };

  return (
    <li
      data-testid="library-item"
      data-media-id={item.id}
      data-media-type={item.type}
      style={style}
      className={`group relative overflow-hidden border-b border-zinc-200/70 last:border-b-0 hover:bg-zinc-950/[0.035] dark:border-white/10 dark:hover:bg-white/[0.055] xl:h-[54px] ${
        selected ? 'bg-accent/10 dark:bg-accent/18' : ''
      }`}
      onFocusCapture={prefetchVideoSidecar}
      onPointerEnter={prefetchVideoSidecar}
      onPointerCancel={clearLongPress}
      onPointerDown={(event) => {
        prefetchVideoSidecar();
        beginLongPress(event);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={clearLongPress}
      onTouchMove={clearLongPress}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
    >
      <div className="grid min-h-[54px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-[5px] sm:px-5 xl:h-full xl:min-h-0 xl:py-0">
        {item.type !== 'audio' && (
          <div
            data-testid={`${item.type}-row-layout`}
            className="col-span-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2"
          >
            <button
              type="button"
              onClick={handlePrimaryAction}
              aria-label={`${item.type === 'image' ? 'Open' : 'Play'} ${item.name}`}
              className="block min-w-0 text-left sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-x-3"
            >
              <span
                aria-hidden
                className="float-left mr-3 h-[68px] w-[4.875rem] pt-6 [shape-outside:polygon(0_0,0_1.5rem,100%_1.5rem,100%_100%,0_100%)] sm:float-none sm:mr-0 sm:h-11 sm:pt-0 sm:[shape-outside:none]"
              >
                <LibraryThumbnail item={item} />
              </span>
              <div className="min-w-0">
                <p
                  data-testid={`${item.type}-responsive-title`}
                  className="max-h-12 overflow-clip whitespace-normal text-base font-medium leading-6 tracking-normal text-zinc-950 dark:text-foreground sm:max-h-none sm:truncate sm:whitespace-nowrap sm:leading-normal"
                  title={item.relativePath}
                >
                  {directory && <span className="text-muted">{directory}</span>}
                  {displayTitle}
                </p>
                <p
                  data-testid={`${item.type}-row-metadata`}
                  className="truncate text-xs text-muted"
                >
                  {item.type === 'video' && progressLabel !== '' && (
                    <>
                      <span>{progressLabel}</span>
                      <span aria-hidden> · </span>
                    </>
                  )}
                  {item.type === 'video' && details !== '' && (
                    <>
                      <span className="hidden sm:inline">{details}</span>
                      <span className="hidden sm:inline" aria-hidden> · </span>
                    </>
                  )}
                  {item.type === 'image' && (
                    <>
                      <span>{item.rootName}</span>
                      <span aria-hidden> · </span>
                    </>
                  )}
                  <span>{formatSize(item.sizeBytes)}</span>
                  <span aria-hidden> · </span>
                  <span>{formatModified(item.modifiedAt)}</span>
                </p>
              </div>
            </button>
            {(item.type === 'video' || item.type === 'image') && (
              <div
                data-row-options-shell
                className={`relative w-[6.75rem] shrink-0 items-center justify-end gap-0.5 ${item.type === 'image' ? 'flex' : 'hidden sm:flex'}`}
              >
                <LibraryRowActions
                  item={item}
                  liked={liked}
                  likeKey={likeKey}
                  optionsOpen={optionsOpen}
                  onOpenAddToPlaylist={openAddToPlaylist}
                  setOptionsOpen={setOptionsOpen}
                  toggleLike={toggleLike}
                />
              </div>
            )}
          </div>
        )}
        {item.type === 'audio' && (
          <button
            type="button"
            data-testid="library-item-play"
            onClick={handlePrimaryAction}
            aria-label={`Play ${item.name}`}
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 text-left xl:grid-cols-[auto_minmax(11rem,1fr)_minmax(8rem,0.72fr)_6rem_7.5rem_minmax(6rem,0.6fr)]"
          >
            <LibraryThumbnail item={item} />
            <div className="min-w-0">
              <p
                className="truncate text-base font-medium tracking-normal text-zinc-950 dark:text-foreground"
                title={item.relativePath}
              >
                {directory && <span className="text-muted">{directory}</span>}
                {displayTitle}
              </p>
              <p
                data-testid="audio-mobile-metadata"
                className="truncate text-sm text-muted xl:hidden"
              >
                {metadata?.artist && (
                  <>
                    <span>{metadata.artist}</span>
                    <span aria-hidden> · </span>
                  </>
                )}
                <span>{formatSize(item.sizeBytes)}</span>
                <span aria-hidden> · </span>
                <span>{formatModified(item.modifiedAt)}</span>
                <span aria-hidden> · </span>
                <span>{item.rootName}</span>
              </p>
            </div>
            <p className="hidden min-w-0 truncate text-sm text-muted xl:block">
              {metadata?.artist}
            </p>
            <p className="hidden min-w-0 text-right text-sm tabular-nums text-muted xl:block">
              {formatSize(item.sizeBytes)}
            </p>
            <p className="hidden min-w-0 text-right text-sm tabular-nums text-muted xl:block">
              {formatModified(item.modifiedAt)}
            </p>
            <p className="hidden min-w-0 truncate text-sm text-muted xl:block">
              {item.rootName}
            </p>
          </button>
        )}
        {item.type === 'audio' && (
          <div
            data-row-options-shell
            className="relative flex w-[5.75rem] shrink-0 items-center justify-end gap-0.5 sm:w-[6.75rem]"
          >
            <LibraryRowActions
              item={item}
              liked={liked}
              likeKey={likeKey}
              optionsOpen={optionsOpen}
              onOpenAddToPlaylist={openAddToPlaylist}
              setOptionsOpen={setOptionsOpen}
              toggleLike={toggleLike}
            />
          </div>
        )}
      </div>
      {item.type === 'video' && (
        <div
          data-testid="library-item-progress"
          aria-hidden
          className="absolute bottom-0 left-3 right-3 h-0.5 bg-zinc-200/70 dark:bg-white/10 sm:left-5 sm:right-5"
        >
          <div
            className={
              fraction !== null && fraction >= 1
                ? 'h-full bg-zinc-400 dark:bg-zinc-500'
                : 'h-full bg-accent'
            }
            style={{ width: `${progressPercent}%` }}
            data-progress-fraction={fraction ?? 0}
          />
        </div>
      )}
    </li>
  );
}

type LibraryItemRowProps = Parameters<typeof LibraryItemRowComponent>[0];

// The virtualized list rebuilds the `style` object every render to position the
// row, so a shallow prop compare would always miss. Compare the style fields
// that actually change (height/transform) and the remaining props by reference;
// parent handlers and `queueItems` are stabilized by the caller.
export function rowPropsEqual(
  previous: LibraryItemRowProps,
  next: LibraryItemRowProps,
): boolean {
  return (
    previous.item === next.item &&
    previous.selected === next.selected &&
    previous.selectionMode === next.selectionMode &&
    previous.queueItems === next.queueItems &&
    previous.onLongPress === next.onLongPress &&
    previous.onOpenAddToPlaylist === next.onOpenAddToPlaylist &&
    previous.onToggleSelected === next.onToggleSelected &&
    previous.style?.height === next.style?.height &&
    previous.style?.transform === next.style?.transform
  );
}

export const LibraryItemRow = memo(LibraryItemRowComponent, rowPropsEqual);

function LibraryRowActions({
  item,
  liked,
  likeKey,
  optionsOpen,
  onOpenAddToPlaylist,
  setOptionsOpen,
  toggleLike,
}: {
  item: LibraryItem;
  liked: boolean;
  likeKey: string;
  optionsOpen: boolean;
  onOpenAddToPlaylist: () => void;
  setOptionsOpen: Dispatch<SetStateAction<boolean>>;
  toggleLike: (key: string) => void;
}) {
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    if (!optionsOpen) return;
    const closeOnViewportChange = () => setOptionsOpen(false);
    document.addEventListener('scroll', closeOnViewportChange, true);
    window.addEventListener('resize', closeOnViewportChange);
    return () => {
      document.removeEventListener('scroll', closeOnViewportChange, true);
      window.removeEventListener('resize', closeOnViewportChange);
    };
  }, [optionsOpen, setOptionsOpen]);

  const toggleOptions = () => {
    if (optionsOpen) {
      setOptionsOpen(false);
      return;
    }
    const rect = moreButtonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const menuWidth = 176;
    const menuHeight = 48;
    const viewportPadding = 12;
    const left = Math.min(
      Math.max(rect.right - menuWidth, viewportPadding),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= menuHeight + viewportPadding
        ? rect.bottom + 6
        : Math.max(viewportPadding, rect.top - menuHeight - 6);
    setMenuPosition({ left, top });
    setOptionsOpen(true);
  };

  return (
    <>
      {(item.type === 'audio' || item.type === 'image') && (
        <button
          type="button"
          data-row-action
          data-testid="library-item-like"
          aria-label={`${liked ? 'Unlike' : 'Like'} ${item.name}`}
          aria-pressed={liked}
          title={liked ? 'Unlike' : 'Like'}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-lg text-muted hover:bg-zinc-200/70 hover:text-accent aria-pressed:text-accent dark:hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            toggleLike(likeKey);
          }}
        >
          <LikeGlyph liked={liked} className="h-5 w-5" />
        </button>
      )}
      {item.type !== 'image' && (
        <button
          ref={moreButtonRef}
          type="button"
          data-row-action
          data-testid="library-item-more"
          aria-label={`More options for ${item.name}`}
          title="More"
          className="relative hidden h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-muted hover:bg-zinc-200/70 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-foreground sm:inline-flex"
          onClick={(event) => {
            event.stopPropagation();
            toggleOptions();
          }}
        >
          <MoreGlyph className="h-5 w-5" />
        </button>
      )}
      {optionsOpen &&
        menuPosition !== null &&
        createPortal(
          <div
            data-testid="library-row-menu"
            data-row-action
            data-row-options-shell
            className="fixed z-[80] min-w-44 rounded-xl border border-white/14 bg-[#111113]/96 p-1 text-sm text-white shadow-2xl shadow-black/40 backdrop-blur-[34px]"
            style={menuPosition}
          >
            <button
              type="button"
              className="flex w-full rounded-lg px-3 py-2 text-left font-semibold hover:bg-white/10"
              onClick={(event) => {
                event.stopPropagation();
                onOpenAddToPlaylist();
              }}
            >
              Add to Playlist
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

function LibraryThumbnail({ item }: { item: LibraryItem }) {
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
      <img
        src={thumbnailUrl}
        alt=""
        aria-hidden
        decoding="async"
        loading="lazy"
        className={
          item.type === 'audio'
            ? 'h-11 w-11 rounded-md bg-zinc-100 object-cover shadow-sm dark:bg-white/[0.08]'
            : 'h-11 w-[4.875rem] rounded-md bg-zinc-100 object-cover shadow-sm dark:bg-white/[0.08]'
        }
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={
        item.type === 'audio'
          ? 'flex h-11 w-11 items-center justify-center rounded-md bg-zinc-200/70 text-lg text-muted shadow-sm dark:bg-white/[0.08]'
          : 'flex h-11 w-[4.875rem] items-center justify-center rounded-md bg-zinc-200/70 text-lg text-muted shadow-sm dark:bg-white/[0.08]'
      }
    >
      {item.type === 'audio' ? (
        <MusicGlyph className="h-5 w-5" />
      ) : item.type === 'video' ? (
        <VideoGlyph className="h-5 w-5" />
      ) : (
        <ImageGlyph className="h-5 w-5" />
      )}
    </span>
  );
}

function metadataDetails(item: LibraryItem): string {
  const metadata = item.metadata;
  const parts: string[] = [];
  if (item.type === 'audio') {
    if (metadata?.artist) parts.push(metadata.artist);
    if (metadata?.album) parts.push(metadata.album);
  } else if (item.type === 'video') {
    if (metadata?.season && metadata?.episode) {
      parts.push(`S${metadata.season} E${metadata.episode}`);
    }
    const subtitleCount = item.subtitles?.length ?? 0;
    if (subtitleCount > 0) parts.push(`${subtitleCount} subtitles`);
  } else {
    parts.push(formatModified(item.modifiedAt));
  }
  const duration = formatDuration(metadata?.durationSec);
  if (duration !== '') parts.push(duration);
  return parts.join(' · ');
}
