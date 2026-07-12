import { createContext, useContext, type ReactNode } from 'react';
import type { BackendStatusStoreApi } from './backendStatusStore';

const BackendStatusContext = createContext<BackendStatusStoreApi | null>(null);

export function BackendStatusProvider({
  store,
  children,
}: {
  store: BackendStatusStoreApi;
  children: ReactNode;
}) {
  return (
    <BackendStatusContext.Provider value={store}>
      {children}
    </BackendStatusContext.Provider>
  );
}

export function useBackendStatusStore(): BackendStatusStoreApi {
  const store = useContext(BackendStatusContext);
  if (!store) {
    throw new Error(
      'useBackendStatusStore must be used inside BackendStatusProvider',
    );
  }
  return store;
}
