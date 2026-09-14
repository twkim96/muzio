import Hls, { type HlsConfig, type LevelUpdatedData } from 'hls.js';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import type { MediaProviderAdapter, MediaPlayerInstance } from '@vidstack/react';
import { configureHlsDvr } from './session';
afterEach(() => vi.unstubAllGlobals());

test('supplies a valid real HLS configuration before instance creation and releases the session', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const unsubscribe = vi.fn();
  let onInstance: (instance: Hls) => void = () => {};
  const provider = { type: 'hls', $$PROVIDER_TYPE: 'HLS', config: {} as Partial<HlsConfig>, library: async () => ({ default: Hls }),
    onInstance: (callback: typeof onInstance) => { onInstance = callback; return unsubscribe; } };
  const setWindow = vi.fn();
  const player = { $state: { inferredLiveDVRWindow: { set: setWindow } } } as unknown as MediaPlayerInstance;
  const cleanup = configureHlsDvr(provider as unknown as MediaProviderAdapter, vi.fn(), player);
  let instance: Hls | undefined;
  try {
    await provider.library();
    instance = new Hls(provider.config);
    // Exercise the adapter with the event fields it consumes; unrelated HLS
    // controllers require a fully parsed playlist and are covered by browser QA.
    instance.removeAllListeners(Hls.Events.LEVEL_UPDATED);
    onInstance(instance);
    expect(instance.config.loader).toBe(Hls.DefaultConfig.loader);
    expect(instance.config.backBufferLength).toBeLessThan(120);
    expect(instance.config.liveMaxLatencyDurationCount).toBe(Infinity);
    Object.defineProperty(instance, 'liveSyncPosition', { get: () => 64 });
    instance.trigger(Hls.Events.LEVEL_UPDATED, { details: { fragments: [{ start: 10 }], totalduration: 60 } } as LevelUpdatedData);
    await Promise.resolve();
    expect(setWindow).toHaveBeenLastCalledWith(54);
    instance.destroy(); instance = undefined;
  } finally { instance?.destroy(); cleanup(); }
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test('native-only providers use the same server playlist without a custom loader', () => {
  const report = vi.fn();
  configureHlsDvr({ type: 'video' } as MediaProviderAdapter, report)();
  expect(report).toHaveBeenCalledWith({ kind: 'idle', seconds: 0 });
});
