import { createContext, useContext, type ReactNode } from 'react';
import type { PlayerStoreApi } from './playerStore';

const PlayerStoreContext = createContext<PlayerStoreApi | null>(null);

export function PlayerProvider({
  store,
  children,
}: {
  store: PlayerStoreApi;
  children: ReactNode;
}) {
  return (
    <PlayerStoreContext.Provider value={store}>
      {children}
    </PlayerStoreContext.Provider>
  );
}

export function usePlayerStore(): PlayerStoreApi {
  const store = useContext(PlayerStoreContext);
  if (!store) {
    throw new Error('usePlayerStore must be used inside PlayerProvider');
  }
  return store;
}
