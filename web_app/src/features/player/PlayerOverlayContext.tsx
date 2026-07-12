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
}

const PlayerOverlayContext = createContext<PlayerOverlayState | null>(null);

export function PlayerOverlayProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <PlayerOverlayContext.Provider value={{ isOpen, open, close }}>
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
