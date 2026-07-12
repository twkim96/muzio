import { useEffect } from 'react';

import { startLibraryLiveSync } from '../../core/api/libraryEventsClient';
import { useLibraryStores } from './LibraryContext';

export function useLibraryLiveSync() {
  const stores = useLibraryStores();
  useEffect(() => startLibraryLiveSync({ stores }), [stores]);
  return stores;
}
