export type VideoOptimizationState =
  | 'eligible'
  | 'building'
  | 'ready'
  | 'ineligible'
  | 'insufficient-space'
  | 'failed'
  | 'unavailable';

export interface VideoOptimizationStatus {
  state: VideoOptimizationState;
  mediaId: string;
  eligible: boolean;
  reason?: string;
  layout?: 'unknown' | 'front-moov' | 'end-moov' | 'fragmented';
  cacheKind: 'faststart-mp4';
  cacheKey?: string;
  url?: string;
  buildingMediaId?: string;
  estimatedOutputBytes: number;
  requiredFreeBytes: number;
  availableBytes: number;
  cacheUsedBytes: number;
  peakCacheBytes: number;
  movieIndexBytes?: number;
}

export interface VideoOptimizationClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const BASE_PATH = '/api/video-optimization';
const DEFAULT_TIMEOUT_MS = 8000;

export function fetchVideoOptimizationStatus(mediaId: string, options: VideoOptimizationClientOptions = {}) {
  return request(mediaId, '', 'GET', options);
}

export function prepareVideoOptimization(mediaId: string, options: VideoOptimizationClientOptions = {}) {
  return request(mediaId, '', 'PUT', options);
}

export function cancelVideoOptimization(mediaId: string, options: VideoOptimizationClientOptions = {}) {
  return request(mediaId, '/build', 'DELETE', options);
}

export function clearVideoOptimization(mediaId: string, cacheKey: string, options: VideoOptimizationClientOptions = {}) {
  const key = cacheKey.trim();
  if (key === '') return Promise.resolve(null);
  return request(mediaId, `/cache?v=${encodeURIComponent(key)}`, 'DELETE', options);
}

async function request(
  mediaId: string,
  suffix: string,
  method: string,
  options: VideoOptimizationClientOptions,
): Promise<VideoOptimizationStatus | null> {
  const id = mediaId.trim();
  if (id === '') return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${BASE_PATH}/${encodeURIComponent(id)}${suffix}`, {
      method,
      signal: controller.signal,
    });
    if (![200, 202, 422, 507].includes(response.status)) return null;
    return parseVideoOptimizationStatus(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function parseVideoOptimizationStatus(raw: unknown): VideoOptimizationStatus | null {
  if (!isRecord(raw) || !isState(raw.state) || typeof raw.mediaId !== 'string' ||
      typeof raw.eligible !== 'boolean' || raw.cacheKind !== 'faststart-mp4') return null;
  const numeric = ['estimatedOutputBytes', 'requiredFreeBytes', 'availableBytes', 'cacheUsedBytes', 'peakCacheBytes'] as const;
  if (numeric.some((key) => typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0)) return null;
  return {
    state: raw.state,
    mediaId: raw.mediaId,
    eligible: raw.eligible,
    cacheKind: 'faststart-mp4',
    estimatedOutputBytes: raw.estimatedOutputBytes as number,
    requiredFreeBytes: raw.requiredFreeBytes as number,
    availableBytes: raw.availableBytes as number,
    cacheUsedBytes: raw.cacheUsedBytes as number,
    peakCacheBytes: raw.peakCacheBytes as number,
    ...(typeof raw.reason === 'string' && raw.reason !== '' ? { reason: raw.reason } : {}),
    ...(isLayout(raw.layout) ? { layout: raw.layout } : {}),
    ...(typeof raw.cacheKey === 'string' && raw.cacheKey !== '' ? { cacheKey: raw.cacheKey } : {}),
    ...(typeof raw.url === 'string' && raw.url !== '' ? { url: raw.url } : {}),
    ...(typeof raw.buildingMediaId === 'string' && raw.buildingMediaId !== '' ? { buildingMediaId: raw.buildingMediaId } : {}),
    ...(typeof raw.movieIndexBytes === 'number' && Number.isFinite(raw.movieIndexBytes) && raw.movieIndexBytes >= 0 ? { movieIndexBytes: raw.movieIndexBytes } : {}),
  };
}

function isState(value: unknown): value is VideoOptimizationState {
  return ['eligible', 'building', 'ready', 'ineligible', 'insufficient-space', 'failed', 'unavailable'].includes(String(value));
}
function isLayout(value: unknown): value is NonNullable<VideoOptimizationStatus['layout']> {
  return ['unknown', 'front-moov', 'end-moov', 'fragmented'].includes(String(value));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
