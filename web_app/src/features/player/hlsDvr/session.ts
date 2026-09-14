import type Hls from 'hls.js';
import { isHLSProvider, type MediaProviderAdapter, type MediaPlayerInstance } from '@vidstack/react';
import { sweepLegacyHlsCache } from './legacyCache';
export interface DvrStatus { kind: 'recording' | 'unavailable' | 'idle'; seconds: number }

/** Runs even without a new stream, so a crashed session cannot leave permanent files. */
export function cleanAbandonedHlsDvr(): (() => void) | undefined {
  if (typeof indexedDB === 'undefined') return;
  const sweep = () => { void sweepLegacyHlsCache().catch(() => {}); };
  sweep();
  const timer = setInterval(sweep, 60_000);
  return () => clearInterval(timer);
}

export function configureHlsDvr(provider: MediaProviderAdapter, report: (status: DvrStatus) => void, player?: MediaPlayerInstance | null): () => void {
  if (!isHLSProvider(provider)) {
    report({ kind: 'idle', seconds: 0 });
    return () => {};
  }
  let disposed = false;
  let attachDestroy: ((instance: Hls) => void) | undefined;
  const hide = (event: PageTransitionEvent) => { if (!event.persisted) close(); };
  const close = () => {
    if (disposed) return;
    disposed = true; window.removeEventListener('pagehide', hide);
  };
  provider.library = async () => {
    const module = await import('hls.js');
    attachDestroy = instance => {
      instance.on(module.Events.DESTROYING, close);
      instance.on(module.Events.LEVEL_UPDATED, (_event, data) => {
        // Vidstack 1.15 infers the full playlist duration, but its seekable end
        // is HLS's delayed live-sync position. That disables seeking throughout
        // a growing DVR window. Apply the playable span after its own listener.
        const start = data.details.fragments[0]?.start;
        report({ kind: data.details.live ? 'recording' : 'idle', seconds: data.details.totalduration });
        queueMicrotask(() => {
          if (disposed || !player || start === undefined) return;
          const end = instance.liveSyncPosition;
          if (end !== null && Number.isFinite(end)) player.$state.inferredLiveDVRWindow.set(Math.max(0, end - start));
        });
      });
    };
    if (!disposed) provider.config = {
      ...provider.config,
      lowLatencyMode: false,
      backBufferLength: 30,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: Infinity,
    };
    return module;
  };
  const unsubscribe = provider.onInstance(instance => attachDestroy?.(instance));
  window.addEventListener('pagehide', hide);
  return () => { unsubscribe(); close(); };
}
