import { create } from 'zustand';
import type { LibraryItem } from '../../core/api/libraryClient';
import { androidShellBridge } from '../../core/platform/androidShell';
import type { LibraryState, LibraryStoreApi } from './libraryStore';

export interface LocalMusicRoot { id: string; name: string; uri: string; available: boolean; error?: string }
export interface LocalMusicSnapshot { roots: LocalMusicRoot[]; items: LibraryItem[] }
interface LocalMusicState extends LocalMusicSnapshot {
  busy: boolean;
  error: string;
  run(command: 'list' | 'add' | 'refresh' | 'remove', payload?: object): Promise<void>;
}

export const useNativeLocalLibrary = create<LocalMusicState>((set, get) => ({
  roots: [], items: [], busy: false, error: '',
  async run(command, payload) {
    const bridge = androidShellBridge();
    if (!bridge || get().busy) return;
    set({ busy: true, error: '' });
    try {
      const snapshot = await bridge.request<LocalMusicSnapshot>(`localLibrary.${command}`, payload);
      set({ roots: snapshot.roots, items: snapshot.items.filter((item) => item.type === 'audio' && item.location === 'local' && item.id.startsWith('local:')) });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally { set({ busy: false }); }
  },
}));

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
