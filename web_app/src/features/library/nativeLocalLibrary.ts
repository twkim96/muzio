import { create } from 'zustand';
import type { LibraryItem } from '../../core/api/libraryClient';
import { androidShellBridge } from '../../core/platform/androidShell';
import type { LibraryState, LibraryStoreApi } from './libraryStore';

export interface LocalMusicRoot { id: string; name: string; uri: string; available: boolean; error?: string }
export interface LocalMusicSnapshot { roots: LocalMusicRoot[]; items: LibraryItem[]; enrichment?: { pending: number; total: number; scanning?: boolean } }
interface LocalMusicState extends LocalMusicSnapshot {
  busy: boolean;
  error: string;
  run(command: 'list' | 'add' | 'refresh' | 'remove', payload?: object, background?: boolean): Promise<void>;
}

export const useNativeLocalLibrary = create<LocalMusicState>((set, get) => {
  let generation = 0;
  let polling = false;
  return {
    roots: [], items: [], busy: false, error: '',
    async run(command, payload, background = false) {
      const bridge = androidShellBridge();
      if (!bridge || get().busy || (background && polling)) return;
      const requestGeneration = ++generation;
      if (background) polling = true;
      else set({ busy: true, error: '' });
      try {
        const snapshot = await bridge.request<LocalMusicSnapshot>(`localLibrary.${command}`, payload);
        // A late background read must never restore a folder removed in the meantime.
        if (generation !== requestGeneration || androidShellBridge() !== bridge) return;
        set({ roots: snapshot.roots, enrichment: snapshot.enrichment, error: '',
          items: snapshot.items.filter((item) => item.type === 'audio' && item.location === 'local' && item.id.startsWith('local:')) });
      } catch (error) {
        if (generation === requestGeneration && androidShellBridge() === bridge) {
          set({ error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (background) polling = false;
        else set({ busy: false });
      }
    },
  };
});

/** Native work survives the screen; only pull progress while this WebView is visible. */
export function startLocalLibraryProgressSync() {
  const poll = () => {
    if (document.visibilityState === 'hidden') return;
    const enrichment = useNativeLocalLibrary.getState().enrichment;
    if ((enrichment?.pending ?? 0) > 0 || enrichment?.scanning) {
      void useNativeLocalLibrary.getState().run('list', undefined, true);
    }
  };
  const resume = () => {
    if (document.visibilityState !== 'hidden') void useNativeLocalLibrary.getState().run('list', undefined, true);
  };
  const timer = setInterval(poll, 2000);
  document.addEventListener('visibilitychange', resume);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
}

/** Keep server revision/delta/cache state independent from the device's library. */
export function createLocalAwareLibraryStore(network: LibraryStoreApi, local = useNativeLocalLibrary): LibraryStoreApi {
  let lastRemote: LibraryState['result'] = null;
  let lastLocal: LibraryItem[] | null = null;
  let mergedResult: LibraryState['result'] = null;
  const project = (): LibraryState => {
    const remote = network.getState();
    const items = local.getState().items;
    if (items.length === 0) return remote;
    if (lastRemote === remote.result && lastLocal === items) return { ...remote, result: mergedResult };
    lastRemote = remote.result; lastLocal = items;
    const networkItems = remote.result?.kind === 'ok' ? remote.result.items : [];
    const merged = [...networkItems, ...items].sort((a, b) =>
      (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0) || a.id.localeCompare(b.id));
    mergedResult = { kind: 'ok', items: merged, revision: remote.revision, etag: remote.etag };
    return { ...remote, result: mergedResult };
  };
  const combined = create<LibraryState>(() => project());
  const sync = () => combined.setState(project(), true);
  network.subscribe(sync);
  local.subscribe((state, previous) => { if (state.items !== previous.items) sync(); });
  return combined;
}
