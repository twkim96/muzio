import {
  fetchAudioResumeCacheStatus,
  requestAudioResumeCache,
  type AudioResumeCacheStatus,
} from '../../core/api/audioResumeCacheClient';
import type { PlaybackSource } from '../../core/playback/source/source';

const POLL_INTERVAL_MS = 1000;

export interface AudioResumeCacheService {
  initialize(): Promise<void>;
  prepare(mediaId: string): void;
  resolve(source: PlaybackSource): PlaybackSource;
}

export interface AudioResumeCacheServiceOptions {
  fetchStatus?: () => Promise<AudioResumeCacheStatus | null>;
  requestCache?: (mediaId: string) => Promise<AudioResumeCacheStatus | null>;
  setTimeout?: (handler: () => void, timeoutMs: number) => unknown;
}

export function createAudioResumeCacheService(
  options: AudioResumeCacheServiceOptions = {},
): AudioResumeCacheService {
  const fetchStatus = options.fetchStatus ?? (() => fetchAudioResumeCacheStatus());
  const requestCache = options.requestCache ?? ((mediaId) => requestAudioResumeCache(mediaId));
  const setTimeoutFn =
    options.setTimeout ??
    ((handler: () => void, timeoutMs: number) =>
      globalThis.setTimeout(handler, timeoutMs));
  let cachedMediaId: string | null = null;
  let cachedURL: string | null = null;
  let requestedMediaId: string | null = null;
  const unavailableMediaIds = new Set<string>();
  let requestGeneration = 0;

  const applyStatus = (status: AudioResumeCacheStatus | null) => {
    if (status === null) return;
    cachedMediaId = status.mediaId ?? null;
    cachedURL = status.url ?? null;
  };

  const poll = (mediaId: string, generation: number) => {
    setTimeoutFn(() => {
      void fetchStatus().then((status) => {
        if (generation !== requestGeneration || requestedMediaId !== mediaId) return;
        applyStatus(status);
        if (status?.state === 'ready' && status.mediaId === mediaId) {
          requestedMediaId = null;
          return;
        }
        if (status?.buildingMediaId === mediaId || status?.state === 'building') {
          poll(mediaId, generation);
          return;
        }
        requestedMediaId = null;
      });
    }, POLL_INTERVAL_MS);
  };

  return {
    async initialize() {
      applyStatus(await fetchStatus());
    },

    prepare(mediaId) {
      const trimmed = mediaId.trim();
      if (
        trimmed === '' ||
        cachedMediaId === trimmed ||
        requestedMediaId === trimmed ||
        unavailableMediaIds.has(trimmed)
      ) {
        return;
      }
      requestedMediaId = trimmed;
      const generation = ++requestGeneration;
      void requestCache(trimmed).then((status) => {
        if (generation !== requestGeneration || requestedMediaId !== trimmed) return;
        applyStatus(status);
        if (status === null) {
          unavailableMediaIds.add(trimmed);
          requestedMediaId = null;
          return;
        }
        unavailableMediaIds.delete(trimmed);
        if (status.state === 'ready' && status.mediaId === trimmed) {
          requestedMediaId = null;
          return;
        }
        poll(trimmed, generation);
      });
    },

    resolve(source) {
      if (
        source.mediaType !== 'audio' ||
        cachedMediaId !== source.mediaId ||
        cachedURL === null
      ) {
        return source;
      }
      const fragment = mediaTimeFragment(source.url);
      if (fragment === '') return source;
      return {
        ...source,
        url: `${cachedURL}${fragment}`,
        mimeType: 'audio/mp4',
      };
    },
  };
}

function mediaTimeFragment(value: string): string {
  try {
    const baseURL =
      typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const url = new URL(value, baseURL);
    return /^#t=[0-9]+(?:\.[0-9]+)?$/.test(url.hash) ? url.hash : '';
  } catch {
    return '';
  }
}
