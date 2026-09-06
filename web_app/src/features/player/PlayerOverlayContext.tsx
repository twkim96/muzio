import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

interface PlayerOverlayState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  playlistsOpen: boolean;
  openPlaylists: () => void;
  closePlaylists: () => void;
}

const PlayerOverlayContext = createContext<PlayerOverlayState | null>(null);

export function PlayerOverlayProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [playlistsOpen, setPlaylistsOpen] = useState(false);
  const openPlaylists = useCallback(() => setPlaylistsOpen(true), []);
  const closePlaylists = useCallback(() => setPlaylistsOpen(false), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <PlayerOverlayContext.Provider value={{ isOpen, open, close, playlistsOpen, openPlaylists, closePlaylists }}>
      {children}
    </PlayerOverlayContext.Provider>
  );
}

export function usePlayerOverlay(): PlayerOverlayState {
  const state = useContext(PlayerOverlayContext);
  if (state === null) {
    throw new Error('usePlayerOverlay must be used inside PlayerOverlayProvider');
  }
  return state;
}

export function useOptionalPlayerOverlay(): PlayerOverlayState | null {
  return useContext(PlayerOverlayContext);
}
