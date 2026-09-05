import { useCallback, useEffect, useRef, useState } from 'react';

const VIDEO_ITEMS_BATCH_SIZE = 24;
const SENTINEL_ROOT_MARGIN = '0px 0px 160px';

function normalizedItemCount(itemCount: number): number {
  if (!Number.isFinite(itemCount)) return 0;
  return Math.max(0, Math.floor(itemCount));
}

export interface IncrementalVideoItems {
  visibleCount: number;
  hasMore: boolean;
  loadMore: () => void;
  sentinelRef: (node: HTMLElement | null) => void;
}

/**
 * Keeps the video list small until its trailing sentinel enters the viewport.
 * The observer deliberately uses the viewport as its root: browser intersection
 * calculations still clip the target against any overflow ancestors, including
 * the desktop side-list scrollport.
 */
export function useIncrementalVideoItems(
  itemCount: number,
): IncrementalVideoItems {
  const count = normalizedItemCount(itemCount);
  const itemCountRef = useRef(count);
  itemCountRef.current = count;

  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(VIDEO_ITEMS_BATCH_SIZE, count),
  );
  const [sentinelNode, setSentinelNode] = useState<HTMLElement | null>(null);

  const hasMore = visibleCount < count;

  const loadMore = useCallback(() => {
    setVisibleCount((previousCount) =>
      Math.min(
        previousCount + VIDEO_ITEMS_BATCH_SIZE,
        itemCountRef.current,
      ),
    );
  }, []);

  const sentinelRef = useCallback((node: HTMLElement | null) => {
    setSentinelNode(node);
  }, []);

  // A list that was empty while its source was loading should still receive
  // its initial batch when the source first provides items. Subsequent source
  // changes keep the current count so selecting another video does not reset
  // the list.
  useEffect(() => {
    if (count === 0) return;
    setVisibleCount((previousCount) =>
      previousCount === 0 ? Math.min(VIDEO_ITEMS_BATCH_SIZE, count) : previousCount,
    );
  }, [count]);

  useEffect(() => {
    if (
      sentinelNode === null ||
      !hasMore ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    let active = true;
    let loadedFromThisObserver = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !active ||
          loadedFromThisObserver ||
          !entries.some((entry) => entry.isIntersecting)
        ) {
          return;
        }
        loadedFromThisObserver = true;
        loadMore();
      },
      {
        root: null,
        rootMargin: SENTINEL_ROOT_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(sentinelNode);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasMore, loadMore, sentinelNode, visibleCount]);

  return { visibleCount, hasMore, loadMore, sentinelRef };
}
