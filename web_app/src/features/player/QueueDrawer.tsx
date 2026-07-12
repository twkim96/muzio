import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { PlaybackSource } from '../../core/playback/source/source';
import { CloseGlyph, PlayGlyph } from '../../core/ui/AppIcons';
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
}: {
  open: boolean;
  onClose: () => void;
}) {
  const store = usePlayerStore();
  const queue = store((state) => state.musicQueue);
  const currentIndex = store((state) => state.musicQueueIndex);
  const playQueueTrack = store((state) => state.playQueueTrack);
  const clearMusicQueue = store((state) => state.clearMusicQueue);
  const current = currentQueueTrack(queue, currentIndex);
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

  return (
    <div
      data-testid="queue-drawer"
      className="fixed inset-0 z-[70]"
      role="presentation"
    >
      <div
        data-testid="queue-drawer-backdrop"
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onPointerDown={onClose}
      />
      <aside
        aria-label="Queue"
        data-glass
        data-allow-scroll
        data-testid="music-now-playing"
        className="absolute bottom-0 left-0 top-0 flex w-[min(24rem,92vw)] flex-col border-r border-white/16 bg-zinc-950/78 px-5 py-5 text-white shadow-2xl shadow-black/55 backdrop-blur-[34px] sm:w-[25rem]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-white/12 pb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Queue</h2>
            <p className="truncate text-sm text-white/60">
              {current === null
                ? 'Empty'
                : `${currentIndex + 1}/${queue.length} · ${current.name}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {queue.length > 1 && (
              <button
                type="button"
                data-testid="clear-music-queue"
                className="rounded-full px-3 py-1 text-sm text-accent hover:bg-white/12"
                onClick={clearMusicQueue}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              aria-label="Close queue"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-2xl leading-none text-white/70 hover:bg-white/12 hover:text-white"
              onClick={onClose}
            >
              <CloseGlyph className="h-5 w-5" />
            </button>
          </div>
        </div>

        {queue.length === 0 ? (
          <p className="text-sm text-white/60">Add music from the library.</p>
        ) : (
          <ol
            ref={listRef}
            data-testid="music-queue"
            data-total-count={queue.length}
            data-rendered-count={visibleQueue.length}
            data-allow-scroll
            className="scrollbar-none min-h-0 flex-1 overflow-y-auto pr-1"
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
    </div>
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
  const detail = track.artist ?? track.relativePath ?? track.rootName ?? 'Music';
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
            current ? 'text-accent' : 'text-white/45'
          }`}
        >
          {current ? <PlayGlyph className="mx-auto h-4 w-4" /> : index + 1}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {track.name}
          </span>
          <span className="block truncate text-xs text-white/50">{detail}</span>
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
