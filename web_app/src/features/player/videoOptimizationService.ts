import {
  cancelVideoOptimization,
  clearVideoOptimization,
  fetchVideoOptimizationStatus,
  prepareVideoOptimization,
  type VideoOptimizationStatus,
} from '../../core/api/videoOptimizationClient';
import type { PlaybackSource } from '../../core/playback/source/source';
import { buildStreamingUrl } from '../../core/playback/source/source';

export interface VideoOptimizationService {
  status(mediaId: string, refresh?: boolean): Promise<VideoOptimizationStatus | null>;
  prepare(mediaId: string): Promise<VideoOptimizationStatus | null>;
  cancel(mediaId: string): Promise<VideoOptimizationStatus | null>;
  clear(mediaId: string, cacheKey: string): Promise<VideoOptimizationStatus | null>;
  invalidate(mediaId: string): void;
  preferOriginal(mediaId: string): void;
  resolve(source: PlaybackSource): PlaybackSource;
}

export interface VideoOptimizationServiceOptions {
  fetchStatus?: (mediaId: string) => Promise<VideoOptimizationStatus | null>;
  prepare?: (mediaId: string) => Promise<VideoOptimizationStatus | null>;
  cancel?: (mediaId: string) => Promise<VideoOptimizationStatus | null>;
  clear?: (mediaId: string, cacheKey: string) => Promise<VideoOptimizationStatus | null>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

const READY_STORAGE_KEY = 'muzio.videoOptimization.ready.v1';

export function createVideoOptimizationService(options: VideoOptimizationServiceOptions = {}): VideoOptimizationService {
  const fetchStatus = options.fetchStatus ?? ((id) => fetchVideoOptimizationStatus(id));
  const prepare = options.prepare ?? ((id) => prepareVideoOptimization(id));
  const cancel = options.cancel ?? ((id) => cancelVideoOptimization(id));
  const clear = options.clear ?? ((id, key) => clearVideoOptimization(id, key));
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const statuses = new Map<string, VideoOptimizationStatus>();
  const preferOriginalOnce = new Set<string>();
  const storedReady = readStoredReady(storage);
  if (storedReady !== null) statuses.set(storedReady.mediaId, storedReady);
  const apply = (mediaId: string, status: VideoOptimizationStatus | null) => {
    if (status?.state === 'ready' && status.url !== undefined && status.cacheKey !== undefined) {
      statuses.clear();
      statuses.set(status.mediaId, status);
      persistReady(storage, status);
    } else {
      statuses.delete(mediaId);
      const stored = readStoredReady(storage);
      if (stored?.mediaId === mediaId) storage?.removeItem(READY_STORAGE_KEY);
    }
    return status;
  };
  return {
    async status(mediaId, refresh = false) {
      const id = mediaId.trim();
      if (id === '') return null;
      if (!refresh && statuses.has(id)) return statuses.get(id) ?? null;
      return apply(id, await fetchStatus(id));
    },
    async prepare(mediaId) { return apply(mediaId, await prepare(mediaId)); },
    async cancel(mediaId) { return apply(mediaId, await cancel(mediaId)); },
    async clear(mediaId, cacheKey) { return apply(mediaId, await clear(mediaId, cacheKey)); },
    invalidate(mediaId) {
      statuses.delete(mediaId);
      const stored = readStoredReady(storage);
      if (stored?.mediaId === mediaId) storage?.removeItem(READY_STORAGE_KEY);
    },
    preferOriginal(mediaId) { preferOriginalOnce.add(mediaId); },
    resolve(source) {
      if (source.mediaType !== 'video') return source;
      if (preferOriginalOnce.delete(source.mediaId)) return source;
      const status = statuses.get(source.mediaId);
      if (status?.state !== 'ready' || status.url === undefined || status.cacheKey === undefined) return source;
      return {
        ...source,
        url: `${status.url}${mediaTimeFragment(source.url)}`,
        mimeType: 'video/mp4',
        optimizationOriginalUrl: source.optimizationOriginalUrl ?? source.url,
        ...(source.optimizationOriginalMimeType !== undefined
          ? { optimizationOriginalMimeType: source.optimizationOriginalMimeType }
          : source.mimeType !== undefined
            ? { optimizationOriginalMimeType: source.mimeType }
            : {}),
      };
    },
  };
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStoredReady(
  storage: Pick<Storage, 'getItem'> | null,
): VideoOptimizationStatus | null {
  if (storage === null) return null;
  try {
    const parsed = JSON.parse(storage.getItem(READY_STORAGE_KEY) ?? 'null') as Partial<VideoOptimizationStatus> | null;
    if (
      parsed?.state !== 'ready' ||
      typeof parsed.mediaId !== 'string' || parsed.mediaId === '' ||
      typeof parsed.cacheKey !== 'string' || parsed.cacheKey === '' ||
      typeof parsed.url !== 'string' || parsed.url === '' ||
      parsed.cacheKind !== 'faststart-mp4' ||
      typeof parsed.eligible !== 'boolean' ||
      typeof parsed.estimatedOutputBytes !== 'number' ||
      typeof parsed.requiredFreeBytes !== 'number' ||
      typeof parsed.availableBytes !== 'number' ||
      typeof parsed.cacheUsedBytes !== 'number' ||
      typeof parsed.peakCacheBytes !== 'number'
    ) {
      return null;
    }
    return parsed as VideoOptimizationStatus;
  } catch {
    return null;
  }
}

function persistReady(
  storage: Pick<Storage, 'setItem'> | null,
  status: VideoOptimizationStatus,
): void {
  try {
    storage?.setItem(READY_STORAGE_KEY, JSON.stringify(status));
  } catch {
    // Storage is an optimization hint only; direct playback remains valid.
  }
}

function mediaTimeFragment(value: string): string {
  try {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const hash = new URL(value, base).hash;
    return /^#t=[0-9]+(?:\.[0-9]+)?$/.test(hash) ? hash : '';
  } catch { return ''; }
}

export const videoOptimizationService = createVideoOptimizationService();

export function restoreOriginalVideoSource(
  source: PlaybackSource,
  positionSec: number,
): PlaybackSource {
  const {
    optimizationOriginalUrl,
    optimizationOriginalMimeType,
    ...rest
  } = source;
  const originalUrl = optimizationOriginalUrl ?? buildStreamingUrl(source.mediaId);
  return {
    ...rest,
    url: withMediaTime(originalUrl, positionSec),
    ...(optimizationOriginalMimeType !== undefined
      ? { mimeType: optimizationOriginalMimeType }
      : {}),
  };
}

function withMediaTime(value: string, positionSec: number): string {
  if (!Number.isFinite(positionSec) || positionSec <= 0) return value;
  const rounded = Math.round(positionSec * 10) / 10;
  const hashIndex = value.indexOf('#');
  const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  return `${base}#t=${rounded}`;
}
