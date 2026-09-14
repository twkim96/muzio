import { CaretLeft } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import type { LibraryItem } from '../../core/api/libraryClient';
import { libraryRootLabel } from '../../core/media/libraryRootLabel';
import { useIncrementalVideoItems } from '../player/useIncrementalVideoItems';
import { MediaCollapseButton } from '../../core/ui/MediaCollapseButton';
import { useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { buildStreamingUrl } from '../../core/playback/source/source';
import { LikeGlyph } from '../../core/ui/AppIcons';
import { contentKeyForLibraryItem, contentKeysForLibraryItem } from '../../core/media/contentIdentity';
import { useLibraryStores, useLibraryThumbnail } from '../library/LibraryContext';
import { describeLibraryError } from '../library/libraryMessage';
import { useDismissGesture } from '../player/useDismissGesture';
import { usePlayerStore } from '../player/PlayerContext';

export function ImageViewerScreen({
  mediaIdOverride,
  onCollapse,
}: {
  mediaIdOverride?: string;
  onCollapse?: () => void;
} = {}) {
  const { mediaId: routeMediaId = '' } = useParams();
  const incomingId = mediaIdOverride ?? routeMediaId;
  const [mediaId, setMediaId] = useState(incomingId);
  useEffect(() => setMediaId(incomingId), [incomingId]);
  const navigate = useNavigate();
  const stores = useLibraryStores();
  const state = stores.image();
  const playerStore = usePlayerStore();
  const likedMediaIds = playerStore((current) => current.likedMediaIds);
  const toggleLike = playerStore((current) => current.toggleLike);

  useEffect(() => {
    if (state.status === 'idle') {
      void state.load();
    }
  }, [state]);

  const image = useMemo(() => {
    if (state.status !== 'ok' || state.result?.kind !== 'ok') return null;
    return state.result.items.find((item) => item.id === mediaId) ?? null;
  }, [mediaId, state.result, state.status]);

  const imageLiked = image !== null && (contentKeysForLibraryItem(image).some(key => likedMediaIds.includes(key)) || likedMediaIds.includes(image.id));
  const items = state.result?.kind === 'ok' ? state.result.items : [];
  const currentIndex = items.findIndex(item => item.id === mediaId);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (target instanceof Element && target.closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"]'))) return;
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 0;
      if (!direction || currentIndex < 0) return;
      event.preventDefault();
      if (event.repeat) return;
      const next = currentIndex + direction;
      if (next >= 0 && next < items.length) setMediaId(items[next].id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [currentIndex, items]);
  const imageAreaRef = useRef<HTMLDivElement>(null);
  const wheelState = useRef({ total: 0, last: 0, switched: -Infinity });
  useEffect(() => {
    const area = imageAreaRef.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return; // Preserve pinch/browser zoom.
      event.preventDefault();
      const now = performance.now();
      const wheel = wheelState.current;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY)
        * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1);
      if (now - wheel.last > 180 || Math.sign(delta) !== Math.sign(wheel.total)) wheel.total = 0;
      wheel.last = now;
      if (now - wheel.switched < 500) return;
      wheel.total += delta;
      if (Math.abs(wheel.total) < 45) return;
      const next = currentIndex + Math.sign(wheel.total);
      wheel.total = 0;
      if (next >= 0 && next < items.length) {
        wheel.switched = now;
        setMediaId(items[next].id);
      }
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, [currentIndex, items]);
  const { visibleCount, hasMore, loadMore, sentinelRef } = useIncrementalVideoItems(items.length);
  useEffect(() => {
    if (currentIndex >= visibleCount && hasMore) loadMore();
  }, [currentIndex, visibleCount, hasMore, loadMore]);
  const close = () => {
    if (onCollapse !== undefined) {
      onCollapse();
      return;
    }
    navigate('/library/image');
  };
  const dismissGesture = useDismissGesture({ onDismiss: close });

  return (
    <div
      data-testid="image-viewer"
      className="relative min-h-screen touch-pan-x overflow-hidden overscroll-y-contain bg-transparent text-white"
      {...dismissGesture.bind}
    >
      <div
        data-testid="image-viewer-motion-layer"
        className={`relative z-10 min-h-screen bg-black px-1 pt-[max(4px,env(safe-area-inset-top))] pb-[max(4px,env(safe-area-inset-bottom))] ${dismissGesture.motionClassName}`}
        style={dismissGesture.motionStyle}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/70 to-transparent" />

        <MediaCollapseButton label="Close image viewer" testId="image-viewer-close" onCollapse={close} />
        {image !== null && (
          <button
            type="button"
            data-testid="image-viewer-favorite"
            aria-label={`${imageLiked ? 'Remove from' : 'Add to'} favorites`}
            aria-pressed={imageLiked}
            className="absolute right-4 top-4 z-20 inline-flex h-11 w-11 items-center justify-center rounded-full text-white/88 transition hover:bg-white/10 hover:text-white aria-pressed:text-accent sm:right-6 sm:top-6"
            onClick={() => toggleLike(contentKeyForLibraryItem(image))}
          >
            <LikeGlyph
              liked={imageLiked}
              className="h-6 w-6"
            />
          </button>
        )}

        {state.status === 'loading' && (
          <StatusMessage>Loading image...</StatusMessage>
        )}
        {state.status === 'error' && state.result !== null && (
          <StatusMessage>{describeLibraryError(state.result)}</StatusMessage>
        )}
        {state.status === 'ok' && state.result?.kind === 'ok' && image === null && (
          <StatusMessage>
            Image not found.
            <Link className="ml-2 underline" to="/library/image">
              Back to images
            </Link>
          </StatusMessage>
        )}
        {image !== null && (
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_320px]">
          <main className="relative z-10 flex min-w-0 flex-col justify-center gap-1">
            <div ref={imageAreaRef} data-testid="image-navigation-area" onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('button,a')) return;
              if (event.altKey || event.ctrlKey || event.shiftKey || dismissGesture.motionClassName) return;
              const next = currentIndex + (event.metaKey ? -1 : 1);
              if (next >= 0 && next < items.length) setMediaId(items[next].id);
            }} className="relative flex h-[calc(100svh-32px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-40 w-full items-center justify-center">
            <img
              data-testid="image-viewer-image"
              src={buildStreamingUrl(image.id)}
              alt={image.metadata?.title || image.name}
              decoding="async"
              className="mx-auto h-full w-full object-contain"
            />
            <button type="button" aria-label="Previous image" disabled={currentIndex <= 0} onClick={() => setMediaId(items[currentIndex - 1].id)} className="muzio-selection-round absolute left-3 top-1/2 z-20 -translate-y-1/2 disabled:opacity-30"><CaretLeft aria-hidden className="h-6 w-6" /></button>
            <button type="button" aria-label="Next image" disabled={currentIndex < 0 || currentIndex >= items.length - 1} onClick={() => setMediaId(items[currentIndex + 1].id)} className="muzio-selection-round absolute right-3 top-1/2 z-20 -translate-y-1/2 disabled:opacity-30"><CaretRight aria-hidden className="h-6 w-6" /></button>
            </div>
            <p className="mx-auto w-full truncate px-1 text-center text-xs leading-4 text-white/60">
              {libraryRootLabel(image)} · {image.relativePath}
            </p>
          </main>
          <aside aria-label="Image list" data-no-dismiss-gesture className="scrollbar-none max-h-[65svh] overflow-y-auto overscroll-contain rounded-2xl bg-white/5 p-2 touch-pan-y lg:sticky lg:top-1 lg:max-h-[calc(100svh-8px)]">
            <ol className="grid gap-2">
              {items.slice(0, visibleCount).map(item => <ImageListRow key={item.id} item={item} current={item.id === mediaId} onSelect={() => setMediaId(item.id)} />)}
            </ol>
            {hasMore && <button ref={sentinelRef} type="button" onClick={loadMore} className="mt-3 w-full rounded-xl py-3 text-sm text-white/70">Load more images</button>}
          </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-white/70">
      <p>{children}</p>
    </div>
  );
}

function ImageListRow({ item, current, onSelect }: { item: LibraryItem; current: boolean; onSelect: () => void }) {
  const thumbnail = useLibraryThumbnail(item);
  return <li><button type="button" aria-current={current ? 'true' : undefined} onClick={onSelect} className={`grid w-full grid-cols-[96px_minmax(0,1fr)] items-center gap-3 rounded-xl p-2 text-left hover:bg-white/10 ${current ? 'bg-white/10 ring-1 ring-accent' : ''}`}>
    {thumbnail?.url ? <img src={thumbnail.url} alt="" loading="lazy" className="aspect-video w-24 rounded-lg object-cover" /> : <span className="aspect-video w-24 rounded-lg bg-white/10" />}
    <span className="line-clamp-2 text-sm">{item.metadata?.title || item.name}</span>
  </button></li>;
}
