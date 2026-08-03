export interface AudioResumeCacheStatus {
  state: 'empty' | 'building' | 'ready';
  mediaId?: string;
  url?: string;
  buildingMediaId?: string;
}

export interface AudioResumeCacheClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const CACHE_PATH = '/api/audio-resume-cache';
const DEFAULT_TIMEOUT_MS = 4000;

export async function fetchAudioResumeCacheStatus(
  options: AudioResumeCacheClientOptions = {},
): Promise<AudioResumeCacheStatus | null> {
  return request(options, (fetchImpl, signal) =>
    fetchImpl(CACHE_PATH, { signal }),
  );
}

export async function requestAudioResumeCache(
  mediaId: string,
  options: AudioResumeCacheClientOptions = {},
): Promise<AudioResumeCacheStatus | null> {
  const trimmed = mediaId.trim();
  if (trimmed === '') return null;
  return request(options, (fetchImpl, signal) =>
    fetchImpl(`${CACHE_PATH}/${encodeURIComponent(trimmed)}`, {
      method: 'PUT',
      signal,
    }),
  );
}

async function request(
  options: AudioResumeCacheClientOptions,
  run: (fetchImpl: typeof fetch, signal: AbortSignal) => Promise<Response>,
): Promise<AudioResumeCacheStatus | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await run(options.fetchImpl ?? fetch, controller.signal);
    if (response.status !== 200 && response.status !== 202) return null;
    return parseStatus(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseStatus(raw: unknown): AudioResumeCacheStatus | null {
  if (!isRecord(raw)) return null;
  if (raw.state !== 'empty' && raw.state !== 'building' && raw.state !== 'ready') {
    return null;
  }
  return {
    state: raw.state,
    ...(typeof raw.mediaId === 'string' && raw.mediaId !== ''
      ? { mediaId: raw.mediaId }
      : {}),
    ...(typeof raw.url === 'string' && raw.url !== '' ? { url: raw.url } : {}),
    ...(typeof raw.buildingMediaId === 'string' && raw.buildingMediaId !== ''
      ? { buildingMediaId: raw.buildingMediaId }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
