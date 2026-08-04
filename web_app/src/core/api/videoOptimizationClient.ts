export type VideoOptimizationState =
  | 'eligible'
  | 'building'
  | 'ready'
  | 'ineligible'
  | 'insufficient-space'
  | 'failed'
  | 'unavailable';

export type VideoOptimizationKind = 'faststart-mp4' | 'hls-fmp4';

export interface VideoOptimizationStatus {
  state: VideoOptimizationState;
  mediaId: string;
  eligible: boolean;
  reason?: string;
  layout?: 'unknown' | 'front-moov' | 'end-moov' | 'fragmented';
  cacheKind: VideoOptimizationKind;
  cacheKey?: string;
  url?: string;
  buildingMediaId?: string;
  buildProgress?: number;
  estimatedOutputBytes: number;
  requiredFreeBytes: number;
  availableBytes: number;
  cacheUsedBytes: number;
  peakCacheBytes: number;
  movieIndexBytes?: number;
  durationSeconds?: number;
  targetSegmentSeconds?: number;
  segmentCount?: number;
  gop?: DurationStats;
  segmentDuration?: DurationStats;
  randomAccessVerified?: boolean;
}

export interface DurationStats {
  count: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

export interface VideoOptimizationClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  kind?: VideoOptimizationKind;
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
    const kindSuffix = options.kind === 'hls-fmp4'
      ? `${suffix.includes('?') ? '&' : '?'}kind=hls-fmp4`
      : '';
    const response = await (options.fetchImpl ?? fetch)(`${BASE_PATH}/${encodeURIComponent(id)}${suffix}${kindSuffix}`, {
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
      typeof raw.eligible !== 'boolean' || !isKind(raw.cacheKind)) return null;
  const numeric = ['estimatedOutputBytes', 'requiredFreeBytes', 'availableBytes', 'cacheUsedBytes', 'peakCacheBytes'] as const;
  if (numeric.some((key) => typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0)) return null;
  return {
    state: raw.state,
    mediaId: raw.mediaId,
    eligible: raw.eligible,
    cacheKind: raw.cacheKind,
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
    ...(finiteNonNegative(raw.buildProgress) && raw.buildProgress <= 1 ? { buildProgress: raw.buildProgress } : {}),
    ...(typeof raw.movieIndexBytes === 'number' && Number.isFinite(raw.movieIndexBytes) && raw.movieIndexBytes >= 0 ? { movieIndexBytes: raw.movieIndexBytes } : {}),
    ...(finiteNonNegative(raw.durationSeconds) ? { durationSeconds: raw.durationSeconds } : {}),
    ...(finiteNonNegative(raw.targetSegmentSeconds) ? { targetSegmentSeconds: raw.targetSegmentSeconds } : {}),
    ...(Number.isInteger(raw.segmentCount) && Number(raw.segmentCount) >= 0 ? { segmentCount: Number(raw.segmentCount) } : {}),
    ...(parseDurationStats(raw.gop) !== null ? { gop: parseDurationStats(raw.gop)! } : {}),
    ...(parseDurationStats(raw.segmentDuration) !== null ? { segmentDuration: parseDurationStats(raw.segmentDuration)! } : {}),
    ...(typeof raw.randomAccessVerified === 'boolean' ? { randomAccessVerified: raw.randomAccessVerified } : {}),
  };
}

function isKind(value: unknown): value is VideoOptimizationKind {
  return value === 'faststart-mp4' || value === 'hls-fmp4';
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseDurationStats(value: unknown): DurationStats | null {
  if (!isRecord(value) || !Number.isInteger(value.count) || Number(value.count) < 0) return null;
  if (![value.min, value.median, value.p95, value.max].every(finiteNonNegative)) return null;
  return {
    count: Number(value.count), min: value.min as number, median: value.median as number,
    p95: value.p95 as number, max: value.max as number,
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
