import { useAndroidBack } from '../../core/platform/androidShell';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from '@phosphor-icons/react';

import type { PlaybackSource } from '../../core/playback/source/source';
import { PlayGlyph } from '../../core/ui/AppIcons';
import { currentQueueTrack, queueTrackKey } from './musicQueue';
import { usePlayerStore } from './PlayerContext';

const QUEUE_ROW_HEIGHT = 56;
const QUEUE_OVERSCAN_ROWS = 6;
const QUEUE_DEFAULT_VIEWPORT_ROWS = 12;

interface QueueRange {
  start: number;
  end: number;
}

export function QueueDrawer({
  open,
  onClose,
  onBack,
}: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
}) {
  useAndroidBack(open, onClose, 50);
  const store = usePlayerStore();
  const queue = store((state) => state.musicQueue);
  const currentIndex = store((state) => state.musicQueueIndex);
  const playQueueTrack = store((state) => state.playQueueTrack);
  const clearMusicQueue = store((state) => state.clearMusicQueue);
  const current = currentQueueTrack(queue, currentIndex);
  const drawerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const [range, setRange] = useState<QueueRange>(() =>
    initialQueueRange(queue.length, currentIndex),
  );

  const updateRange = useCallback(() => {
    const list = listRef.current;
    if (list === null) return;
    const viewportHeight =
      list.clientHeight || QUEUE_ROW_HEIGHT * QUEUE_DEFAULT_VIEWPORT_ROWS;
    const start = clampQueueIndex(
      Math.floor(list.scrollTop / QUEUE_ROW_HEIGHT) - QUEUE_OVERSCAN_ROWS,
      queue.length,
    );
    const end = clampQueueIndex(
      Math.ceil((list.scrollTop + viewportHeight) / QUEUE_ROW_HEIGHT) +
        QUEUE_OVERSCAN_ROWS,
      queue.length,
    );
    setRange((currentRange) =>
      currentRange.start === start && currentRange.end === end
        ? currentRange
        : { start, end: Math.max(start, end) },
    );
  }, [queue.length]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!open || drawer === null) return;
    const previousFocus = document.activeElement;
    drawer.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
        drawer.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === drawer || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.removeEventListener('keydown', trapFocus);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || queue.length === 0) return;
    const next = initialQueueRange(queue.length, currentIndex);
    setRange(next);
    if (listRef.current !== null && currentIndex >= 0) {
      listRef.current.scrollTop = Math.max(
        0,
        (currentIndex - QUEUE_OVERSCAN_ROWS) * QUEUE_ROW_HEIGHT,
      );
    }
  }, [currentIndex, open, queue.length]);

  if (!open) return null;
  const safeStart = Math.min(range.start, queue.length);
  const safeEnd = Math.min(Math.max(range.end, safeStart), queue.length);
  const visibleQueue = queue.slice(safeStart, safeEnd);

  return createPortal(
    <div
      data-testid="queue-drawer"
      className="fixed inset-0 z-[70]"
      role="presentation"
    >
      <div
        data-testid="queue-drawer-backdrop"
        className="absolute inset-0 bg-black/35"
        onPointerDown={onClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label="Queue"
        data-glass
        data-allow-scroll
        data-testid="music-now-playing"
        className="muzio-sidebar muzio-side-sheet flex flex-col overflow-hidden rounded-2xl outline-none border border-zinc-200/70 bg-white/88 px-5 py-5 text-zinc-950 shadow-2xl shadow-black/20 backdrop-blur-xl dark:border-white/10 dark:bg-surface/94 dark:text-foreground"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex shrink-0 flex-col items-start gap-3">
          <div className="flex w-full items-start justify-between gap-3">
            <h2 className="h-[46.4px] w-fit text-left [--title-scale:1.45] sm:[--title-scale:1.16]">
              <span className="muzio-title relative flex h-8 w-fit origin-top-left scale-[var(--title-scale)] items-center px-4 text-lg font-semibold tracking-tight sm:h-10 sm:text-xl">
                <span className="scale-[calc(1/var(--title-scale))]">Queue</span>
              </span>
            </h2>
            {onBack && (
              <button
                type="button"
                aria-label="Back to sidebar"
                className="muzio-settings-button h-[46.4px] w-[46.4px] shrink-0 flex items-center justify-center"
                onClick={onBack}
              >
                <ArrowLeft className="h-[21.1px] w-[21.1px]" />
              </button>
            )}
          </div>
          <div className="flex h-12 w-full min-w-0 items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm text-muted">
              {current === null
                ? 'Empty'
                : `${currentIndex + 1}/${queue.length} · ${current.name}`}
            </p>
            {queue.length > 1 && (
              <button
                type="button"
                data-testid="clear-music-queue"
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold text-accent hover:bg-zinc-200/70 dark:hover:bg-white/10"
                onClick={clearMusicQueue}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {queue.length === 0 ? (
          <p className="text-sm text-muted">Add music from the library.</p>
        ) : (
          <ol
            ref={listRef}
            data-testid="music-queue"
            data-total-count={queue.length}
            data-rendered-count={visibleQueue.length}
            data-allow-scroll
            className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
            onScroll={updateRange}
          >
            {safeStart > 0 && (
              <li
                aria-hidden
                style={{ height: safeStart * QUEUE_ROW_HEIGHT }}
              />
            )}
            {visibleQueue.map((track, offset) => {
              const index = safeStart + offset;
              return (
              <QueueRow
                key={queueTrackKey(track)}
                current={index === currentIndex}
                index={index}
                onPlay={() => {
                  void playQueueTrack(queueTrackKey(track));
                }}
                track={track}
              />
              );
            })}
            {safeEnd < queue.length && (
              <li
                aria-hidden
                style={{ height: (queue.length - safeEnd) * QUEUE_ROW_HEIGHT }}
              />
            )}
          </ol>
        )}
      </aside>
    </div>,
    document.body,
  );
}

function QueueRow({
  current,
  index,
  onPlay,
  track,
}: {
  current: boolean;
  index: number;
  onPlay: () => void;
  track: PlaybackSource;
}) {
  const detail = [track.artist, track.album].filter(Boolean).join(' · ') ||
    (track.relativePath ?? track.rootName ?? 'Music');
  return (
    <li>
      <button
        type="button"
        aria-label={`Play ${track.name}`}
        className="grid w-full grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/12"
        onClick={onPlay}
      >
        <span
          className={`text-center text-sm tabular-nums ${
            current ? 'text-accent' : 'text-muted'
          }`}
        >
          {current ? <PlayGlyph className="mx-auto h-4 w-4" /> : index + 1}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {track.name}
          </span>
          <span className="block truncate text-xs text-muted">{detail}</span>
        </span>
      </button>
    </li>
  );
}

function initialQueueRange(total: number, currentIndex: number): QueueRange {
  const renderedRows =
    QUEUE_DEFAULT_VIEWPORT_ROWS + QUEUE_OVERSCAN_ROWS * 2;
  if (total <= renderedRows) {
    return { start: 0, end: total };
  }
  const centeredIndex =
    currentIndex >= 0 ? currentIndex : 0;
  const start = clampQueueIndex(
    centeredIndex - Math.floor(renderedRows / 2),
    total - renderedRows,
  );
  return {
    start,
    end: Math.min(total, start + renderedRows),
  };
}

function clampQueueIndex(index: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, index));
}
