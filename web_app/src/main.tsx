import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { App } from './app/App';
import { createBackendStatusStore } from './features/settings/backendStatusStore';
import { BackendStatusProvider } from './features/settings/BackendStatusContext';
import {
  applyThemeSettings,
  readThemeSettings,
  syncThemeSettingsFromServer,
} from './features/settings/theme';
import { createLibraryStore } from './features/library/libraryStore';
import { createLocalStorageAudioLibrarySnapshotCache } from './features/library/librarySnapshotCache';
import { LibraryProvider } from './features/library/LibraryContext';
import { createPlayerStore } from './features/player/playerStore';
import { PlayerProvider } from './features/player/PlayerContext';
import { createLocalStorageProgressRepository } from './core/storage/progressRepository';
import { createSyncedProgressRepository } from './core/storage/progressSyncRepository';
import { registerServiceWorker } from './core/platform/registerServiceWorker';
import { createProgressService } from './features/progress/progressService';
import { ProgressProvider } from './features/progress/ProgressContext';
import { mostRecentResumableEntry } from './features/progress/progressPolicy';
import { buildStreamingUrl } from './core/playback/source/source';

const backendStatusStore = createBackendStatusStore();
const libraryStores = {
  audio: createLibraryStore({
    type: 'audio',
    snapshotCache: createLocalStorageAudioLibrarySnapshotCache(),
  }),
  video: createLibraryStore({ type: 'video' }),
  image: createLibraryStore({ type: 'image' }),
};
const localProgressRepository = createLocalStorageProgressRepository();
const progressRepository = createSyncedProgressRepository(localProgressRepository);
const progressService = createProgressService(progressRepository);
const playerStore = createPlayerStore({ progressService });

applyThemeSettings(readThemeSettings());
void syncThemeSettingsFromServer().catch(() => {
  // Keep the local fallback if the backend is unavailable during startup.
});
registerServiceWorker();

// Seed the mini-player with the most recent resumable progress entry, if any.
// The user clicks play (or another row) to start real playback. The seed never
// auto-loads, so the LAN backend does not receive an unsolicited request on
// every page load.
function seedMostRecentProgress() {
  const entries = progressRepository.entries();
  const recent = mostRecentResumableEntry(entries);
  if (recent === null || recent.record.source === undefined) {
    return;
  }
  const source = {
    kind: 'remote' as const,
    mediaId: recent.mediaId,
    mediaType: recent.record.source.mediaType,
    name: recent.record.source.name,
    durationSec: recent.record.durationSec,
    rootName: recent.record.source.rootName,
    relativePath: recent.record.source.relativePath,
    url: buildStreamingUrl(recent.mediaId, {
      startSec: recent.resumePositionSec,
    }),
  };
  playerStore.getState().seedSource(
    source,
    {
      positionSec: recent.resumePositionSec,
      durationSec: recent.record.durationSec,
    },
  );
}

seedMostRecentProgress();
void progressRepository.syncFromRemote().then(() => {
  seedMostRecentProgress();
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <BackendStatusProvider store={backendStatusStore}>
      <LibraryProvider stores={libraryStores}>
        <PlayerProvider store={playerStore}>
          <ProgressProvider repository={progressRepository}>
            <App />
          </ProgressProvider>
        </PlayerProvider>
      </LibraryProvider>
    </BackendStatusProvider>
  </StrictMode>,
);
