import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { buildStreamingUrl } from '../../core/playback/source/source';
import { DownChevronIcon } from '../../core/ui/AppIcons';
import { useLibraryStores } from '../library/LibraryContext';
import { describeLibraryError } from '../library/libraryMessage';
import { useDismissGesture } from '../player/useDismissGesture';

export function ImageViewerScreen({
  mediaIdOverride,
  onCollapse,
}: {
  mediaIdOverride?: string;
  onCollapse?: () => void;
} = {}) {
  const { mediaId: routeMediaId = '' } = useParams();
  const mediaId = mediaIdOverride ?? routeMediaId;
  const navigate = useNavigate();
  const stores = useLibraryStores();
  const state = stores.image();

  useEffect(() => {
    if (state.status === 'idle') {
      void state.load();
    }
  }, [state]);

  const image = useMemo(() => {
    if (state.status !== 'ok' || state.result?.kind !== 'ok') return null;
    return state.result.items.find((item) => item.id === mediaId) ?? null;
  }, [mediaId, state.result, state.status]);

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
        className={`relative z-10 min-h-screen bg-black px-4 py-4 sm:px-6 sm:py-6 ${dismissGesture.motionClassName}`}
        style={dismissGesture.motionStyle}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/70 to-transparent" />
        <button
          type="button"
          data-testid="image-viewer-close"
          aria-label="Close image viewer"
          className="absolute left-4 top-4 z-20 inline-flex h-11 w-11 items-center justify-center rounded-full text-white/88 transition hover:bg-white/10 hover:text-white sm:left-6 sm:top-6"
          onClick={close}
        >
          <DownChevronIcon />
        </button>

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
          <main className="relative z-10 mx-auto flex min-h-[calc(100vh-2rem)] max-w-6xl flex-col justify-center gap-4 pt-12">
            <h1
              data-testid="image-viewer-title"
              className="truncate px-14 text-center text-lg font-semibold text-white sm:text-2xl"
              title={image.relativePath}
            >
              {image.metadata?.title || image.name}
            </h1>
            <img
              data-testid="image-viewer-image"
              src={buildStreamingUrl(image.id)}
              alt={image.metadata?.title || image.name}
              decoding="async"
              className="mx-auto max-h-[82vh] max-w-full rounded-2xl object-contain shadow-2xl shadow-black/40"
            />
            <p className="mx-auto max-w-5xl truncate px-4 text-center text-sm text-white/60">
              {image.rootName} · {image.relativePath}
            </p>
          </main>
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
