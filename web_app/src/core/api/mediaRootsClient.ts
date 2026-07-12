export interface MediaRootsSettings {
  audioRoots: string[];
  videoRoots: string[];
  imageRoots: string[];
  itemCount?: number;
  persistent: boolean;
  degradedRoots: Array<{ name: string; path: string; error: string }>;
  index: {
    enabled: boolean;
    loadedItems: number;
    lastVerifiedAt?: string;
    lastError?: string;
  };
  watcher: {
    enabled: boolean;
    backend?: string;
    lastError?: string;
    roots: Array<{
      path: string;
      enabled: boolean;
      backend?: string;
      reason?: string;
    }>;
  };
}

export type MediaRootsResult =
  | { kind: 'ok'; settings: MediaRootsSettings }
  | { kind: 'badResponse'; statusCode: number; message?: string }
  | { kind: 'unreachable'; message: string };

export interface MediaRootsOptions {
  fetchImpl?: typeof fetch;
}

const MEDIA_ROOTS_PATH = '/api/settings/media-roots';

export async function fetchMediaRoots(
  options: MediaRootsOptions = {},
): Promise<MediaRootsResult> {
  return requestMediaRoots('GET', undefined, options);
}

export async function updateMediaRoots(
  settings: Pick<MediaRootsSettings, 'audioRoots' | 'videoRoots' | 'imageRoots'>,
  options: MediaRootsOptions = {},
): Promise<MediaRootsResult> {
  return requestMediaRoots('PUT', settings, options);
}

export async function refreshMediaRoots(
  options: MediaRootsOptions = {},
): Promise<MediaRootsResult> {
  return requestMediaRoots('POST', undefined, options);
}

async function requestMediaRoots(
  method: 'GET' | 'PUT' | 'POST',
  body: Pick<MediaRootsSettings, 'audioRoots' | 'videoRoots' | 'imageRoots'> | undefined,
  options: MediaRootsOptions,
): Promise<MediaRootsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(MEDIA_ROOTS_PATH, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: unknown) {
    return {
      kind: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (response.status !== 200) {
    return {
      kind: 'badResponse',
      statusCode: response.status,
      message: await response.text().catch(() => ''),
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { kind: 'badResponse', statusCode: 200 };
  }
  const parsed = parseSettings(raw);
  if (parsed === null) {
    return { kind: 'badResponse', statusCode: 200 };
  }
  return { kind: 'ok', settings: parsed };
}

function parseSettings(raw: unknown): MediaRootsSettings | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.audioRoots) || !Array.isArray(raw.videoRoots)) {
    return null;
  }
  return {
    audioRoots: raw.audioRoots.filter((value): value is string => typeof value === 'string'),
    videoRoots: raw.videoRoots.filter((value): value is string => typeof value === 'string'),
    imageRoots: Array.isArray(raw.imageRoots)
      ? raw.imageRoots.filter((value): value is string => typeof value === 'string')
      : [],
    itemCount:
      typeof raw.itemCount === 'number' && Number.isFinite(raw.itemCount)
        ? raw.itemCount
        : undefined,
    persistent: raw.persistent === true,
    degradedRoots: Array.isArray(raw.degradedRoots)
      ? raw.degradedRoots.flatMap((value) => {
          if (!isRecord(value)) return [];
          if (
            typeof value.name !== 'string' ||
            typeof value.path !== 'string' ||
            typeof value.error !== 'string'
          ) {
            return [];
          }
          return [{ name: value.name, path: value.path, error: value.error }];
        })
      : [],
    index: parseIndexStatus(raw.index),
    watcher: parseWatcherStatus(raw.watcher),
  };
}

function parseWatcherStatus(raw: unknown): MediaRootsSettings['watcher'] {
  if (!isRecord(raw)) {
    return { enabled: false, roots: [] };
  }
  const status: MediaRootsSettings['watcher'] = {
    enabled: raw.enabled === true,
    roots: Array.isArray(raw.roots)
      ? raw.roots.flatMap((value) => {
          if (!isRecord(value) || typeof value.path !== 'string') return [];
          return [{
            path: value.path,
            enabled: value.enabled === true,
            backend: typeof value.backend === 'string' ? value.backend : undefined,
            reason: typeof value.reason === 'string' ? value.reason : undefined,
          }];
        })
      : [],
  };
  if (typeof raw.backend === 'string' && raw.backend !== '') {
    status.backend = raw.backend;
  }
  if (typeof raw.lastError === 'string' && raw.lastError !== '') {
    status.lastError = raw.lastError;
  }
  return status;
}

function parseIndexStatus(raw: unknown): MediaRootsSettings['index'] {
  if (!isRecord(raw)) {
    return { enabled: false, loadedItems: 0 };
  }
  const status: MediaRootsSettings['index'] = {
    enabled: raw.enabled === true,
    loadedItems:
      typeof raw.loadedItems === 'number' && Number.isFinite(raw.loadedItems)
        ? raw.loadedItems
        : 0,
    lastVerifiedAt:
      typeof raw.lastVerifiedAt === 'string' && raw.lastVerifiedAt !== ''
        ? raw.lastVerifiedAt
        : undefined,
  };
  if (typeof raw.lastError === 'string' && raw.lastError !== '') {
    status.lastError = raw.lastError;
  }
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
