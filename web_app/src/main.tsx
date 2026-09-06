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
import { createAudioResumeCacheService } from './features/player/audioResumeCacheService';
import { videoOptimizationService } from './features/player/videoOptimizationService';

import { createNativeBridge } from './core/platform/nativeBridge';
import { configureAndroidShell, migrateNativePreferences } from './core/platform/androidShell';
import { createLocalAwareLibraryStore, startLocalLibraryProgressSync, useNativeLocalLibrary } from './features/library/nativeLocalLibrary';
import { AndroidServerSetup } from './core/platform/AndroidServerSetup';
import { connectNativeAudio } from './features/player/nativeAudio';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');
const root = createRoot(rootElement);
const bridge = createNativeBridge();
configureAndroidShell(bridge);
applyThemeSettings(readThemeSettings());

if (bridge) {
  const syncSystemBars = () => {
    const channels = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim().split(/\s+/).map(Number);
    if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return;
    const backgroundColor = '#' + channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
    const dark = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 128;
    void bridge.request('shell.appearance', { backgroundColor, dark }).catch(() => {});
  };
  new MutationObserver(syncSystemBars).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  syncSystemBars();
}

async function startApp() {
  if (bridge) {
    const profile = await bridge.request<{ setup: boolean }>('shell.profile');
    if (profile.setup) {
      root.render(<AndroidServerSetup bridge={bridge} />);
      return;
    }
    await migrateNativePreferences(bridge);
  }
  const backendStatusStore = createBackendStatusStore();
  const libraryStores = {
    audio: createLibraryStore({
      type: 'audio',
      snapshotCache: createLocalStorageAudioLibrarySnapshotCache(),
    }),
    video: createLibraryStore({ type: 'video' }),
    image: createLibraryStore({ type: 'image' }),
  };
  if (bridge) {
    libraryStores.audio = createLocalAwareLibraryStore(libraryStores.audio);
    void useNativeLocalLibrary.getState().run('list');
    const stopLocalProgressSync = startLocalLibraryProgressSync();
    if (import.meta.hot) import.meta.hot.dispose(stopLocalProgressSync);
  }
  const localProgressRepository = createLocalStorageProgressRepository();
  const progressRepository = createSyncedProgressRepository(localProgressRepository);
  const progressService = createProgressService(progressRepository);
  const audioResumeCache = createAudioResumeCacheService();
  void audioResumeCache.initialize();
  const playerStore = createPlayerStore({ progressService, audioResumeCache, videoOptimization: videoOptimizationService });

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
      ...(recent.mediaId.startsWith('local:') ? { location: 'local' as const } : {}),
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

  await connectNativeAudio(playerStore, bridge);
  seedMostRecentProgress();
  void progressRepository.syncFromRemote().then(() => {
    seedMostRecentProgress();
  });

  root.render(
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
}

void startApp().catch((error: unknown) => {
  root.render(
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 px-6">
      <h1 className="text-2xl font-semibold">Muzio를 시작하지 못했습니다</h1>
      <p role="alert" className="text-sm text-muted">{error instanceof Error ? error.message : String(error)}</p>
      <button className="rounded-xl border border-current/20 px-4 py-3" onClick={() => window.location.reload()}>다시 시도</button>
      {bridge && <button className="rounded-xl border border-current/20 px-4 py-3" onClick={() => void bridge.request('shell.editServer')}>서버 연결 설정</button>}
    </main>,
  );
});
