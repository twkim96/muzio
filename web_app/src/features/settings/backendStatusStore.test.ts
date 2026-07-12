import { describe, expect, test } from 'vitest';

import type { HealthCheckResult } from '../../core/api/healthCheck';
import { createBackendStatusStore } from './backendStatusStore';

describe('createBackendStatusStore', () => {
  test('initial state has no result and is not probing', () => {
    const useStore = createBackendStatusStore();
    const state = useStore.getState();
    expect(state.lastResult).toBeNull();
    expect(state.isProbing).toBe(false);
  });

  test('testConnection records an ok result', async () => {
    const probeResult: HealthCheckResult = {
      kind: 'ok',
      service: 'muzio-backend',
    };
    const useStore = createBackendStatusStore({
      probe: async () => probeResult,
    });

    await useStore.getState().testConnection();

    const state = useStore.getState();
    expect(state.lastResult).toEqual(probeResult);
    expect(state.isProbing).toBe(false);
  });

  test('testConnection toggles isProbing while waiting', async () => {
    let resolveProbe!: (value: HealthCheckResult) => void;
    const useStore = createBackendStatusStore({
      probe: () =>
        new Promise<HealthCheckResult>((resolve) => {
          resolveProbe = resolve;
        }),
    });

    const inflight = useStore.getState().testConnection();
    expect(useStore.getState().isProbing).toBe(true);

    resolveProbe({ kind: 'ok', service: 'backend' });
    await inflight;

    expect(useStore.getState().isProbing).toBe(false);
  });

  test('reset clears state', async () => {
    const useStore = createBackendStatusStore({
      probe: async () => ({ kind: 'ok', service: 'backend' }),
    });

    await useStore.getState().testConnection();
    useStore.getState().reset();

    expect(useStore.getState().lastResult).toBeNull();
    expect(useStore.getState().isProbing).toBe(false);
  });
});
