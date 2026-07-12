import { create } from 'zustand';

import type {
  HealthCheckOptions,
  HealthCheckResult,
} from '../../core/api/healthCheck';
import { probeHealth } from '../../core/api/healthCheck';

/**
 * State for the backend connection screen.
 *
 * The web app probes its own origin (see core/api/healthCheck), so this store
 * does not own a server URL and does not persist anything. Phase 9 Android
 * will add server-profile selection in its own native module.
 */
export interface BackendStatusState {
  lastResult: HealthCheckResult | null;
  isProbing: boolean;
  testConnection: () => Promise<void>;
  reset: () => void;
}

export interface BackendStatusStoreOptions {
  probe?: typeof probeHealth;
  probeOptions?: HealthCheckOptions;
}

export function createBackendStatusStore({
  probe = probeHealth,
  probeOptions,
}: BackendStatusStoreOptions = {}) {
  return create<BackendStatusState>((set) => ({
    lastResult: null,
    isProbing: false,

    async testConnection() {
      set({ isProbing: true, lastResult: null });
      const result = await probe(probeOptions);
      set({ isProbing: false, lastResult: result });
    },

    reset() {
      set({ lastResult: null, isProbing: false });
    },
  }));
}

export type BackendStatusStoreApi = ReturnType<typeof createBackendStatusStore>;
