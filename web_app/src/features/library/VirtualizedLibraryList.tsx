import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { LibraryItem } from '../../core/api/libraryClient';
import { LibraryItemRow } from './LibraryItemRow';

const ROW_HEIGHT = 54;
const COMFORTABLE_MEDIA_ROW_HEIGHT = 78;
const OVERSCAN_ROWS = 8;
const IMAGE_OVERSCAN_ROWS = 3;
const NON_MOBILE_QUERY = '(min-width: 640px)';

interface VisibleRange {
  start: number;
  end: number;
}

export function VirtualizedLibraryList({
  items,
  onLongPressItem,
  onOpenAddToPlaylist,
  onToggleSelected,
  selectedIds = new Set<string>(),
  selectionMode = false,
  selectionAnchorId,
  onAddSelection,
  onQueueSelection,
  onClearSelection,
}: {
  items: readonly LibraryItem[];
  onLongPressItem?: (item: LibraryItem) => void;
  onOpenAddToPlaylist?: (items: LibraryItem[]) => void;
  onToggleSelected?: (item: LibraryItem) => void;
  selectedIds?: Set<string>;
  selectionMode?: boolean;
  selectionAnchorId?: string;
  onAddSelection?: () => void;
  onQueueSelection?: () => void;
  onClearSelection?: () => void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const compactRowHeight = useLibraryRowHeight(items[0]?.type);
  const videoCards = items[0]?.type === 'video';
  const [listWidth, setListWidth] = useState(() => typeof window === 'undefined' ? 1024 : Math.max(1, window.innerWidth - 32));
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !videoCards) return;
    const measure = () => setListWidth(list.getBoundingClientRect().width || Math.max(1, window.innerWidth - 32));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(list);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [videoCards]);
  const columns = videoCards ? Math.max(1, Math.floor((listWidth + 24) / 344)) : 1;
  const cardWidth = (listWidth - (columns - 1) * 24) / columns;
  const rowHeight = videoCards ? Math.ceil(cardWidth * 9 / 16) + 112 : compactRowHeight;
  const overscanRows =
    items[0]?.type === 'image' ? IMAGE_OVERSCAN_ROWS : OVERSCAN_ROWS;
  const [range, setRange] = useState<VisibleRange>(() =>
    initialRange(items.length, overscanRows, rowHeight),
  );

  const updateRange = useCallback(() => {
    const list = listRef.current;
    if (list === null || typeof window === 'undefined') {
      setRange(initialRange(items.length, overscanRows, rowHeight));
      return;
    }

    const rect = list.getBoundingClientRect();
    const listTop = window.scrollY + rect.top;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const start = clampIndex(
      (Math.floor((viewportTop - listTop) / rowHeight) - overscanRows) * columns,
      items.length,
    );
    const end = clampIndex(
      (Math.ceil((viewportBottom - listTop) / rowHeight) + overscanRows) * columns,
      items.length,
    );

    setRange((current) =>
      current.start === start && current.end === end
        ? current
        : { start, end: Math.max(start, end) },
    );
  }, [items.length, overscanRows, rowHeight, columns]);

  const scheduleRangeUpdate = useCallback(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      updateRange();
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updateRange();
    });
  }, [updateRange]);

  useLayoutEffect(() => {
    updateRange();
  }, [updateRange]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('scroll', scheduleRangeUpdate, { passive: true });
    window.addEventListener('resize', scheduleRangeUpdate);
    return () => {
      window.removeEventListener('scroll', scheduleRangeUpdate);
      window.removeEventListener('resize', scheduleRangeUpdate);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [scheduleRangeUpdate]);

  const safeRange = useMemo(() => {
    if (items.length === 0) return { start: 0, end: 0 };
    const start = Math.floor(Math.min(range.start, items.length - 1) / columns) * columns;
    const end = Math.min(Math.max(range.end, start + 1), items.length);
    return { start, end };
  }, [items.length, range.end, range.start, columns]);
  const visibleItems = items.slice(safeRange.start, safeRange.end);
  const totalHeight = Math.ceil(items.length / columns) * rowHeight;

  return (
    <ul
      ref={listRef}
      data-testid="library-list"
      data-total-count={items.length}
      data-rendered-count={visibleItems.length}
      data-row-height={rowHeight}
      data-columns={columns}
      data-layout={videoCards ? "video-cards" : "rows"}
      className="relative"
      style={{ height: totalHeight }}
    >
      {visibleItems.map((item, offset) => {
        const index = safeRange.start + offset;
        return (
          <LibraryItemRow
            key={item.id}
            item={item}
            videoCard={videoCards}
            onLongPress={onLongPressItem}
            onOpenAddToPlaylist={onOpenAddToPlaylist}
            onToggleSelected={onToggleSelected}
            queueItems={items}
            selected={selectedIds.has(item.id)}
            selectionMode={selectionMode}
            showSelectionActions={selectionMode && item.id === selectionAnchorId}
            selectionCount={item.id === selectionAnchorId ? selectedIds.size : 0}
            onQueueSelection={onQueueSelection}
            onAddSelection={onAddSelection}
            onClearSelection={onClearSelection}
            style={{
              height: videoCards ? rowHeight - 24 : rowHeight,
              width: videoCards ? cardWidth : undefined,
              left: videoCards ? (index % columns) * (cardWidth + 24) : 0,
              position: 'absolute',
              right: videoCards ? undefined : 0,
              top: 0,
              transform: `translateY(${Math.floor(index / columns) * rowHeight}px)`,
            }}
          />
        );
      })}
    </ul>
  );
}

function initialRange(
  total: number,
  overscanRows: number,
  rowHeight: number = ROW_HEIGHT,
): VisibleRange {
  if (typeof window === 'undefined') {
    return { start: 0, end: Math.min(total, 32) };
  }
  const count = Math.ceil(window.innerHeight / rowHeight) + overscanRows * 2;
  return { start: 0, end: Math.min(total, count) };
}

function useLibraryRowHeight(type: LibraryItem['type'] | undefined): number {
  const [nonMobile, setNonMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(NON_MOBILE_QUERY).matches;
  });

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setNonMobile(false);
      return;
    }
    const media = window.matchMedia(NON_MOBILE_QUERY);
    const update = () => setNonMobile(media.matches);
    update();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  if ((type === 'video' || type === 'image') && !nonMobile) {
    return COMFORTABLE_MEDIA_ROW_HEIGHT;
  }
  return ROW_HEIGHT;
}

function clampIndex(index: number, total: number): number {
  return Math.max(0, Math.min(total, index));
}
