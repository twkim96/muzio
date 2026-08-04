import { describe, expect, it, vi } from 'vitest';

import type { VideoOptimizationStatus } from '../../core/api/videoOptimizationClient';
import type { PlaybackSource } from '../../core/playback/source/source';
import {
  createVideoOptimizationService,
  restoreOriginalVideoSource,
} from './videoOptimizationService';

const source: PlaybackSource = {
  kind: 'remote', mediaId: 'video', mediaType: 'video', name: 'movie.mp4',
  mimeType: 'video/mp4', url: '/api/media/video#t=45',
};

const ready: VideoOptimizationStatus = {
  state: 'ready', mediaId: 'video', eligible: true, layout: 'end-moov',
  cacheKind: 'faststart-mp4', cacheKey: 'key',
  url: '/api/video-optimization/media/video?v=key',
  estimatedOutputBytes: 100, requiredFreeBytes: 600, availableBytes: 1000,
  cacheUsedBytes: 100, peakCacheBytes: 200,
};

describe('videoOptimizationService', () => {
  it('keeps direct playback until an immutable ready status is known', async () => {
    const fetchStatus = vi.fn(async () => ready);
    const service = createVideoOptimizationService({ fetchStatus, storage: null });
    expect(service.resolve(source)).toEqual(source);
    await service.status('video', true);
    expect(service.resolve(source)).toEqual({
      ...source,
      mimeType: 'video/mp4',
      url: '/api/video-optimization/media/video?v=key#t=45',
      optimizationKind: 'faststart-mp4',
      optimizationOriginalUrl: '/api/media/video#t=45',
      optimizationOriginalMimeType: 'video/mp4',
    });
  });

  it('keeps audio and failed status requests unchanged', async () => {
    const service = createVideoOptimizationService({ fetchStatus: async () => null, storage: null });
    await service.status('video', true);
    expect(service.resolve(source)).toEqual(source);
    const audio = { ...source, mediaType: 'audio' as const };
    expect(service.resolve(audio)).toEqual(audio);
  });

  it('drops a cached sidecar when a refresh becomes unavailable', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(null);
    const service = createVideoOptimizationService({ fetchStatus, storage: null });
    await service.status('video', true);
    expect(service.resolve(source).url).toContain('/api/video-optimization/media/');
    await service.status('video', true);
    expect(service.resolve(source)).toEqual(source);
  });

  it('updates cached selection after prepare and clear', async () => {
    const eligible = { ...ready, state: 'eligible' as const, cacheKey: undefined, url: undefined };
    const service = createVideoOptimizationService({
      prepare: async () => ready,
      clear: async () => eligible,
      storage: null,
    });
    await service.prepare('video');
    expect(service.resolve(source).url).toContain('/api/video-optimization/media/');
    await service.clear('video', 'key');
    expect(service.resolve(source)).toEqual(source);
  });

  it('allows one explicit switch back to the original source', async () => {
    const service = createVideoOptimizationService({ fetchStatus: async () => ready, storage: null });
    await service.status('video', true);
    service.preferOriginal('video');
    expect(service.resolve(source)).toEqual(source);
    expect(service.resolve(source).url).toContain('/api/video-optimization/media/');
  });

  it('restores a MOV original URL and MIME at the current position', () => {
    const optimized: PlaybackSource = {
      ...source,
      name: 'movie.mov',
      url: '/api/video-optimization/media/video?v=key#t=45',
      mimeType: 'video/mp4',
      optimizationOriginalUrl: '/api/media/video#t=45',
      optimizationOriginalMimeType: 'video/quicktime',
    };
    expect(restoreOriginalVideoSource(optimized, 90.25)).toEqual({
      ...source,
      name: 'movie.mov',
      url: '/api/media/video#t=90.3',
      mimeType: 'video/quicktime',
    });
  });

  it('restores a persisted ready selection and invalidates a failed sidecar', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const first = createVideoOptimizationService({ prepare: async () => ready, storage });
    await first.prepare('video');

    const restored = createVideoOptimizationService({ storage });
    expect(restored.resolve(source).url).toContain('/api/video-optimization/media/');
    restored.invalidate('video');
    expect(restored.resolve(source)).toEqual(source);
    expect(values.size).toBe(0);
  });

  it('selects native HLS with the original identity and resume fragment', async () => {
    const hlsReady: VideoOptimizationStatus = {
      ...ready,
      layout: 'front-moov',
      cacheKind: 'hls-fmp4',
      cacheKey: 'hls-key',
      url: '/api/video-optimization/hls/video/hls-key/index.m3u8',
    };
    const service = createVideoOptimizationService({
      fetchStatus: async () => hlsReady,
      canPlayHLS: () => true,
      storage: null,
    });
    await service.status('video', true, 'hls-fmp4');
    expect(service.resolve(source)).toEqual({
      ...source,
      url: '/api/video-optimization/hls/video/hls-key/index.m3u8#t=45',
      mimeType: 'application/vnd.apple.mpegurl',
      optimizationKind: 'hls-fmp4',
      optimizationOriginalUrl: source.url,
      optimizationOriginalMimeType: source.mimeType,
    });
  });

  it('keeps non-native HLS browsers on the direct source', async () => {
    const service = createVideoOptimizationService({
      fetchStatus: async () => ({
        ...ready,
        cacheKind: 'hls-fmp4',
        url: '/api/video-optimization/hls/video/key/index.m3u8',
      }),
      canPlayHLS: () => false,
      storage: null,
    });
    await service.status('video', true, 'hls-fmp4');
    expect(service.resolve(source)).toEqual(source);
  });
});
