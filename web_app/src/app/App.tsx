import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import { AppShell } from './AppShell';
import { backgroundLocationFrom } from './backgroundLocation';
import { BackendStatusScreen } from '../features/settings/BackendStatusScreen';
import { ImageViewerScreen } from '../features/image/ImageViewerScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { LibraryScreen } from '../features/library/LibraryScreen';
import { AudioMount } from '../features/player/AudioMount';
import { FullPlayerScreen } from '../features/player/FullPlayerScreen';
import { MediaSessionSync } from '../features/player/MediaSessionSync';
import { MiniPlayer } from '../features/player/MiniPlayer';
import { PlaylistProvider } from '../features/playlists/PlaylistContext';
import { VideoSurfaceProvider } from '../features/player/VideoMount';
import {
  PlayerOverlayProvider,
  usePlayerOverlay,
} from '../features/player/PlayerOverlayContext';

export function App() {
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <AudioMount />
      <MediaSessionSync />
      <PlayerOverlayProvider>
        <VideoSurfaceProvider>
          <PlaylistProvider>
            <AppShell>
              <RoutedContent />
              <RouteAwareMiniPlayer />
            </AppShell>
          </PlaylistProvider>
        </VideoSurfaceProvider>
      </PlayerOverlayProvider>
    </BrowserRouter>
  );
}

function RoutedContent() {
  const { isOpen, close } = usePlayerOverlay();
  const location = useLocation();
  const navigate = useNavigate();
  const backgroundLocation = backgroundLocationFrom(location);
  const showImageViewerOverlay =
    backgroundLocation !== null && location.pathname.startsWith('/image/');
  const imageViewerMediaId = showImageViewerOverlay
    ? decodeURIComponent(location.pathname.slice('/image/'.length))
    : '';

  return (
    <>
      <Routes location={backgroundLocation ?? location}>
        <Route path="/" element={<Navigate to="/library/music" replace />} />
        <Route path="/library/music" element={<LibraryScreen type="audio" />} />
        <Route path="/library/video" element={<LibraryScreen type="video" />} />
        <Route path="/library/image" element={<LibraryScreen type="image" />} />
        <Route path="/image/:mediaId" element={<ImageViewerScreen />} />
        <Route path="/player" element={<FullPlayerScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/settings/backend" element={<BackendStatusScreen />} />
      </Routes>
      {isOpen && (
        <div
          data-testid="player-overlay"
          data-no-menu-swipe
          className="fixed inset-0 z-50"
        >
          <FullPlayerScreen onCollapse={close} />
        </div>
      )}
      {showImageViewerOverlay && (
        <div data-testid="image-viewer-overlay" className="fixed inset-0 z-50">
          <ImageViewerScreen
            mediaIdOverride={imageViewerMediaId}
            onCollapse={() => navigate(-1)}
          />
        </div>
      )}
    </>
  );
}

function RouteAwareMiniPlayer() {
  const location = useLocation();
  const { isOpen } = usePlayerOverlay();
  if (isOpen) return null;
  if (location.pathname.startsWith('/player')) return null;
  if (location.pathname.startsWith('/image/')) return null;
  return <MiniPlayer />;
}
