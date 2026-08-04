import {
  cancelVideoOptimization,
  clearVideoOptimization,
  fetchVideoOptimizationStatus,
  prepareVideoOptimization,
  type VideoOptimizationKind,
  type VideoOptimizationStatus,
} from '../../core/api/videoOptimizationClient';
import type { PlaybackSource } from '../../core/playback/source/source';
import { buildStreamingUrl } from '../../core/playback/source/source';

export interface VideoOptimizationService {
  status(mediaId: string, refresh?: boolean, kind?: VideoOptimizationKind): Promise<VideoOptimizationStatus | null>;
  prepare(mediaId: string, kind?: VideoOptimizationKind): Promise<VideoOptimizationStatus | null>;
  cancel(mediaId: string, kind?: VideoOptimizationKind): Promise<VideoOptimizationStatus | null>;
  clear(mediaId: string, cacheKey: string, kind?: VideoOptimizationKind): Promise<VideoOptimizationStatus | null>;
  invalidate(mediaId: string, kind?: VideoOptimizationKind): void;
  supportsNativeHLS(): boolean;
  preferOriginal(mediaId: string): void;
  resolve(source: PlaybackSource): PlaybackSource;
}

export interface VideoOptimizationServiceOptions {
  fetchStatus?: (mediaId: string, kind: VideoOptimizationKind) => Promise<VideoOptimizationStatus | null>;
  prepare?: (mediaId: string, kind: VideoOptimizationKind) => Promise<VideoOptimizationStatus | null>;
  cancel?: (mediaId: string, kind: VideoOptimizationKind) => Promise<VideoOptimizationStatus | null>;
  clear?: (mediaId: string, cacheKey: string, kind: VideoOptimizationKind) => Promise<VideoOptimizationStatus | null>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  canPlayHLS?: () => boolean;
}

const READY_STORAGE_KEY = 'muzio.videoOptimization.ready.v1';

export function createVideoOptimizationService(options: VideoOptimizationServiceOptions = {}): VideoOptimizationService {
  const fetchStatus = options.fetchStatus ?? ((id, kind) => fetchVideoOptimizationStatus(id, { kind }));
  const prepare = options.prepare ?? ((id, kind) => prepareVideoOptimization(id, { kind }));
  const cancel = options.cancel ?? ((id, kind) => cancelVideoOptimization(id, { kind }));
  const clear = options.clear ?? ((id, key, kind) => clearVideoOptimization(id, key, { kind }));
  const canPlayHLS = options.canPlayHLS ?? canPlayNativeHLS;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const statuses = new Map<string, VideoOptimizationStatus>();
  const preferOriginalOnce = new Set<string>();
  const storedReady = readStoredReady(storage);
  if (storedReady !== null) statuses.set(statusKey(storedReady.mediaId, storedReady.cacheKind), storedReady);
  const apply = (mediaId: string, kind: VideoOptimizationKind, status: VideoOptimizationStatus | null) => {
    if (status?.state === 'ready' && status.url !== undefined && status.cacheKey !== undefined) {
      statuses.clear();
      statuses.set(statusKey(status.mediaId, status.cacheKind), status);
      persistReady(storage, status);
    } else {
      statuses.delete(statusKey(mediaId, kind));
      const stored = readStoredReady(storage);
      if (stored?.mediaId === mediaId && stored.cacheKind === kind) storage?.removeItem(READY_STORAGE_KEY);
    }
    return status;
  };
  return {
    async status(mediaId, refresh = false, kind = 'faststart-mp4') {
      const id = mediaId.trim();
      if (id === '') return null;
      const key = statusKey(id, kind);
      if (!refresh && statuses.has(key)) return statuses.get(key) ?? null;
      return apply(id, kind, await fetchStatus(id, kind));
    },
    async prepare(mediaId, kind = 'faststart-mp4') { return apply(mediaId, kind, await prepare(mediaId, kind)); },
    async cancel(mediaId, kind = 'faststart-mp4') { return apply(mediaId, kind, await cancel(mediaId, kind)); },
    async clear(mediaId, cacheKey, kind = 'faststart-mp4') { return apply(mediaId, kind, await clear(mediaId, cacheKey, kind)); },
    invalidate(mediaId, kind) {
      if (kind === undefined) {
        statuses.delete(statusKey(mediaId, 'faststart-mp4'));
        statuses.delete(statusKey(mediaId, 'hls-fmp4'));
      } else {
        statuses.delete(statusKey(mediaId, kind));
      }
      const stored = readStoredReady(storage);
      if (stored?.mediaId === mediaId && (kind === undefined || stored.cacheKind === kind)) storage?.removeItem(READY_STORAGE_KEY);
    },
    supportsNativeHLS: canPlayHLS,
    preferOriginal(mediaId) { preferOriginalOnce.add(mediaId); },
    resolve(source) {
      if (source.mediaType !== 'video') return source;
      if (preferOriginalOnce.delete(source.mediaId)) return source;
      const hlsStatus = canPlayHLS() ? statuses.get(statusKey(source.mediaId, 'hls-fmp4')) : undefined;
      const status = hlsStatus?.state === 'ready'
        ? hlsStatus
        : statuses.get(statusKey(source.mediaId, 'faststart-mp4'));
      if (status?.state !== 'ready' || status.url === undefined || status.cacheKey === undefined) return source;
      return {
        ...source,
        url: `${status.url}${mediaTimeFragment(source.url)}`,
        mimeType: status.cacheKind === 'hls-fmp4' ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        optimizationKind: status.cacheKind,
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

function statusKey(mediaId: string, kind: VideoOptimizationKind): string {
  return `${kind}:${mediaId}`;
}

function canPlayNativeHLS(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const video = document.createElement('video');
    return video.canPlayType('application/vnd.apple.mpegurl') !== '' || video.canPlayType('application/x-mpegURL') !== '';
  } catch {
    return false;
  }
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
      (parsed.cacheKind !== 'faststart-mp4' && parsed.cacheKind !== 'hls-fmp4') ||
      typeof parsed.eligible !== 'boolean' ||
      typeof parsed.estimatedOutputBytes !== 'number' ||
      typeof parsed.requiredFreeBytes !== 'number' ||
      typeof parsed.availableBytes !== 'number' ||
      typeof parsed.cacheUsedBytes !== 'number' ||
      typeof parsed.peakCacheBytes !== 'number'
    ) {
      return null;
    }
    const expectedPrefix = parsed.cacheKind === 'hls-fmp4'
      ? '/api/video-optimization/hls/'
      : '/api/video-optimization/media/';
    if (!parsed.url.startsWith(expectedPrefix)) return null;
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
    optimizationKind: _optimizationKind,
    ...rest
  } = source;
  void _optimizationKind;
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
