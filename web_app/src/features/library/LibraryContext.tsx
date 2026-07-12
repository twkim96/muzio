import { createContext, useContext, type ReactNode } from 'react';
import type {
  LibraryItem,
  LibraryThumbnail,
} from '../../core/api/libraryClient';
import type { LibraryStoreApi } from './libraryStore';

/**
 * Three stores live alongside the app: music, video, and image. We pass
 * them through context rather than recreating them inside each screen so the
 * cached result survives a navigation away and back without re-fetching on
 * every mount.
 */
export interface LibraryStores {
  video: LibraryStoreApi;
  audio: LibraryStoreApi;
  image: LibraryStoreApi;
}

const LibraryStoresContext = createContext<LibraryStores | null>(null);

export function LibraryProvider({
  stores,
  children,
}: {
  stores: LibraryStores;
  children: ReactNode;
}) {
  return (
    <LibraryStoresContext.Provider value={stores}>
      {children}
    </LibraryStoresContext.Provider>
  );
}

export function useLibraryStores(): LibraryStores {
  const stores = useContext(LibraryStoresContext);
  if (!stores) {
    throw new Error(
      'useLibraryStores must be used inside LibraryProvider',
    );
  }
  return stores;
}

export function useLibraryThumbnail(
  item: LibraryItem,
): LibraryThumbnail | undefined {
  const stores = useLibraryStores();
  const store =
    item.type === 'audio'
      ? stores.audio
      : item.type === 'video'
        ? stores.video
        : stores.image;
  return store(
    (state) => state.presentation.get(item.id) ?? item.thumbnail,
  );
}
