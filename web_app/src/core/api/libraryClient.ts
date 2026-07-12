/**
 * Client for the backend library listing endpoint.
 *
 * The web app talks to its own origin (see core/api/healthCheck for the
 * rationale). The backend response shape is documented in DEV_PHASE Phase 2;
 * this client only mirrors fields the web UI actually consumes today and
 * leaves room for metadata fields to land in Phase 11/13 without breaking
 * existing callers.
 */
export type LibraryMediaType = 'video' | 'audio' | 'image';

export interface LibraryItem {
  id: string;
  type: LibraryMediaType;
  rootName: string;
  relativePath: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  modifiedAt: string; // RFC3339 from the backend
  metadata?: LibraryMetadata;
  thumbnail?: LibraryThumbnail;
  subtitles?: LibrarySubtitle[];
}

export interface LibraryMetadata {
  title: string;
  artist?: string;
  album?: string;
  season?: number;
  episode?: number;
  year?: number;
  durationSec?: number;
}

export interface LibraryThumbnail {
  url: string;
  kind: string;
  status: string;
  cacheKey: string;
}

export interface LibrarySubtitle {
  relativePath: string;
  language?: string;
  label: string;
}

export type LibraryFetchResult =
  | { kind: 'ok'; items: LibraryItem[]; revision?: number; etag?: string }
  | { kind: 'notModified'; revision?: number; etag?: string }
  | { kind: 'badResponse'; statusCode: number }
  | { kind: 'unreachable'; message: string };

export type LibraryChangesResult =
  | {
      kind: 'ok';
      revision: number;
      upserts: LibraryItem[];
      deletedIds: string[];
      resetRequired: boolean;
      etag?: string;
    }
  | { kind: 'badResponse'; statusCode: number }
  | { kind: 'unreachable'; message: string };

export interface LibraryFetchOptions {
  /** Override the global fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel the fetch from the caller. */
  signal?: AbortSignal;
  /** Revision ETag used for a preserving reload. */
  ifNoneMatch?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const LIBRARY_PATH = '/api/library';

function responseHeader(response: Response, name: string): string | null {
  return response.headers?.get(name) ?? null;
}

export async function fetchLibrary(
  filter: LibraryMediaType | 'all',
  options: LibraryFetchOptions = {},
): Promise<LibraryFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Forward an external AbortSignal so a navigation away from the screen can
  // cancel an in-flight request without leaking timers.
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }

  const url = filter === 'all' ? LIBRARY_PATH : `${LIBRARY_PATH}?type=${filter}`;

  // The timeout must protect headers AND body parsing. Servers can stream
  // headers immediately and then stall the body, which would otherwise leave
  // response.json() pending forever after the AbortController was cleaned up.
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: options.ifNoneMatch
          ? { 'If-None-Match': options.ifNoneMatch }
          : undefined,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          kind: 'unreachable',
          message: 'request cancelled or timed out',
        };
      }
      return {
        kind: 'unreachable',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (response.status === 304) {
      return {
        kind: 'notModified',
        etag: responseHeader(response, 'ETag') ?? options.ifNoneMatch,
      };
    }
    if (response.status !== 200) {
      return { kind: 'badResponse', statusCode: response.status };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        return {
          kind: 'unreachable',
          message: 'request cancelled or timed out',
        };
      }
      return { kind: 'badResponse', statusCode: 200 };
    }

    if (!isRecord(body) || !Array.isArray(body.items)) {
      return { kind: 'badResponse', statusCode: 200 };
    }

    const items: LibraryItem[] = [];
    for (const raw of body.items) {
      const parsed = parseItem(raw);
      if (parsed !== null) items.push(parsed);
    }
    const result: Extract<LibraryFetchResult, { kind: 'ok' }> = {
      kind: 'ok',
      items,
    };
    if (
      typeof body.revision === 'number' &&
      Number.isSafeInteger(body.revision) &&
      body.revision >= 0
    ) {
      result.revision = body.revision;
    }
    const etag = responseHeader(response, 'ETag');
    if (etag) result.etag = etag;
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchLibraryChanges(
  filter: LibraryMediaType,
  since: number,
  options: LibraryFetchOptions = {},
): Promise<LibraryChangesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }
  const url = `/api/library/changes?since=${encodeURIComponent(String(since))}&type=${filter}`;
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (err: unknown) {
      return {
        kind: 'unreachable',
        message:
          err instanceof DOMException && err.name === 'AbortError'
            ? 'request cancelled or timed out'
            : err instanceof Error
              ? err.message
              : String(err),
      };
    }
    if (response.status !== 200) {
      return { kind: 'badResponse', statusCode: response.status };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: 'badResponse', statusCode: 200 };
    }
    if (
      !isRecord(body) ||
      typeof body.revision !== 'number' ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0 ||
      !Array.isArray(body.upserts) ||
      !Array.isArray(body.deletedIds)
    ) {
      return { kind: 'badResponse', statusCode: 200 };
    }
    const upserts: LibraryItem[] = [];
    for (const raw of body.upserts) {
      const parsed = parseItem(raw);
      if (parsed !== null) upserts.push(parsed);
    }
    const deletedIds = body.deletedIds.filter(
      (value): value is string => typeof value === 'string',
    );
    const result: Extract<LibraryChangesResult, { kind: 'ok' }> = {
      kind: 'ok',
      revision: body.revision,
      upserts,
      deletedIds,
      resetRequired: body.resetRequired === true,
    };
    const etag = responseHeader(response, 'ETag');
    if (etag) result.etag = etag;
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseItem(raw: unknown): LibraryItem | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string') return null;
  if (raw.type !== 'video' && raw.type !== 'audio' && raw.type !== 'image') {
    return null;
  }
  if (typeof raw.rootName !== 'string') return null;
  if (typeof raw.relativePath !== 'string') return null;
  if (typeof raw.name !== 'string') return null;
  if (typeof raw.sizeBytes !== 'number' || !Number.isFinite(raw.sizeBytes)) {
    return null;
  }
  if (typeof raw.modifiedAt !== 'string') return null;
  return {
    id: raw.id,
    type: raw.type,
    rootName: raw.rootName,
    relativePath: raw.relativePath,
    name: raw.name,
    mimeType:
      typeof raw.mimeType === 'string' && raw.mimeType.trim() !== ''
        ? raw.mimeType
        : undefined,
    sizeBytes: raw.sizeBytes,
    modifiedAt: raw.modifiedAt,
    metadata: parseMetadata(raw.metadata, raw.name),
    thumbnail: parseThumbnail(raw.thumbnail),
    subtitles: parseSubtitles(raw.subtitles),
  };
}

function parseMetadata(raw: unknown, fallbackName: string): LibraryMetadata {
  if (!isRecord(raw)) return { title: fallbackTitle(fallbackName) };
  const metadata: LibraryMetadata = {
    title:
      typeof raw.title === 'string' && raw.title.trim() !== ''
        ? raw.title
        : fallbackTitle(fallbackName),
  };
  if (typeof raw.artist === 'string' && raw.artist.trim() !== '') {
    metadata.artist = raw.artist;
  }
  if (typeof raw.album === 'string' && raw.album.trim() !== '') {
    metadata.album = raw.album;
  }
  if (isPositiveInteger(raw.season)) metadata.season = raw.season;
  if (isPositiveInteger(raw.episode)) metadata.episode = raw.episode;
  if (isPositiveInteger(raw.year)) metadata.year = raw.year;
  if (typeof raw.durationSec === 'number' && raw.durationSec > 0) {
    metadata.durationSec = raw.durationSec;
  }
  return metadata;
}

function parseThumbnail(raw: unknown): LibraryThumbnail {
  if (!isRecord(raw)) return emptyThumbnail();
  return {
    url: typeof raw.url === 'string' ? raw.url : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    status: typeof raw.status === 'string' ? raw.status : 'missing',
    cacheKey: typeof raw.cacheKey === 'string' ? raw.cacheKey : '',
  };
}

function parseSubtitles(raw: unknown): LibrarySubtitle[] {
  if (!Array.isArray(raw)) return [];
  const subtitles: LibrarySubtitle[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.relativePath !== 'string') continue;
    subtitles.push({
      relativePath: item.relativePath,
      language: typeof item.language === 'string' ? item.language : undefined,
      label: typeof item.label === 'string' ? item.label : 'Subtitle',
    });
  }
  return subtitles;
}

function emptyThumbnail(): LibraryThumbnail {
  return { url: '', kind: '', status: 'missing', cacheKey: '' };
}

function fallbackTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
