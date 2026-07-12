import {
  Suspense,
  createContext,
  lazy,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { usePlayerStore } from './PlayerContext';

interface VideoSurfaceContextValue {
  setHost(host: HTMLElement | null): void;
  theaterMode: boolean;
  toggleTheaterMode(): void;
}

const VideoSurfaceContext = createContext<VideoSurfaceContextValue | null>(null);
const PersistentVidstackPlayer = lazy(() =>
  import('./PersistentVidstackPlayer').then((module) => ({
    default: module.PersistentVidstackPlayer,
  })),
);

/**
 * Loads Vidstack only when video becomes the active playback kind. Once
 * loaded, the player remains mounted while paused, collapsed, or parked.
 */
export function VideoSurfaceProvider({ children }: { children: ReactNode }) {
  const store = usePlayerStore();
  const active = store((state) => state.active);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [theaterMode, setTheaterMode] = useState(false);
  const portalRoot = useMemo(() => {
    const root = document.createElement('div');
    root.dataset.testid = 'video-surface-root';
    return root;
  }, []);
  const value = useMemo(
    () => ({
      setHost,
      theaterMode,
      toggleTheaterMode: () => setTheaterMode((value) => !value),
    }),
    [theaterMode],
  );

  return (
    <VideoSurfaceContext.Provider value={value}>
      {active === 'video' && (
        <Suspense fallback={null}>
          <PersistentVidstackPlayer
            host={host}
            portalRoot={portalRoot}
            theaterMode={theaterMode}
            onToggleTheaterMode={value.toggleTheaterMode}
          />
        </Suspense>
      )}
      {children}
    </VideoSurfaceContext.Provider>
  );
}

export function useVideoTheaterMode() {
  const surface = useContext(VideoSurfaceContext);
  return {
    theaterMode: surface?.theaterMode ?? false,
  };
}

export function VideoViewport({
  className,
  onHostChange,
}: {
  className?: string;
  onHostChange?: (host: HTMLDivElement | null) => void;
}) {
  const surface = useContext(VideoSurfaceContext);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (surface === null) return;
    const host = ref.current;
    surface.setHost(host);
    onHostChange?.(host);
    return () => {
      surface.setHost(null);
      onHostChange?.(null);
    };
  }, [onHostChange, surface]);

  return (
    <div
      ref={ref}
      data-testid="video-viewport"
      className={className}
    />
  );
}
