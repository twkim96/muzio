import { createContext, useContext, useState, type ReactNode } from 'react';

import {
  createLocalStoragePlaylistRepository,
  type PlaylistRecord,
  type PlaylistRepository,
} from '../../core/storage/playlistRepository';

interface PlaylistContextValue {
  playlists: PlaylistRecord[];
  createPlaylist(name: string): PlaylistRecord[];
  addItem(playlistId: string, contentKey: string): PlaylistRecord[];
  addItems(playlistId: string, contentKeys: readonly string[]): PlaylistRecord[];
  removeItems(playlistId: string, contentKeys: readonly string[]): PlaylistRecord[];
  moveItem(playlistId: string, contentKey: string, direction: 'up' | 'down'): PlaylistRecord[];
  renamePlaylist(playlistId: string, name: string): PlaylistRecord[];
  deletePlaylist(playlistId: string): PlaylistRecord[];
  refreshPlaylists(): PlaylistRecord[];
}

const PlaylistContext = createContext<PlaylistContextValue | null>(null);

export function PlaylistProvider({
  children,
  repository,
}: {
  children: ReactNode;
  repository?: PlaylistRepository;
}) {
  const [playlistRepository] = useState(
    () => repository ?? createLocalStoragePlaylistRepository(),
  );
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>(() =>
    playlistRepository.list(),
  );

  const replace = (next: PlaylistRecord[]) => {
    setPlaylists(next);
    return next;
  };

  return (
    <PlaylistContext.Provider
      value={{
        playlists,
        createPlaylist(name) {
          return replace(playlistRepository.create(name));
        },
        addItem(playlistId, contentKey) {
          return replace(playlistRepository.addItem(playlistId, contentKey));
        },
        addItems(playlistId, contentKeys) {
          return replace(playlistRepository.addItems(playlistId, contentKeys));
        },
        removeItems(playlistId, contentKeys) {
          return replace(playlistRepository.removeItems(playlistId, contentKeys));
        },
        moveItem(playlistId, contentKey, direction) {
          return replace(playlistRepository.moveItem(playlistId, contentKey, direction));
        },
        renamePlaylist(playlistId, name) {
          return replace(playlistRepository.rename(playlistId, name));
        },
        deletePlaylist(playlistId) {
          return replace(playlistRepository.delete(playlistId));
        },
        refreshPlaylists() {
          return replace(playlistRepository.list());
        },
      }}
    >
      {children}
    </PlaylistContext.Provider>
  );
}

export function usePlaylists(): PlaylistContextValue {
  const value = useContext(PlaylistContext);
  if (value === null) {
    throw new Error('usePlaylists must be used inside PlaylistProvider');
  }
  return value;
}

export function useOptionalPlaylists(): PlaylistContextValue | null {
  return useContext(PlaylistContext);
}
