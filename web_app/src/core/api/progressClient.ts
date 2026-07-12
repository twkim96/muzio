import type { ProgressRecord } from '../storage/progressRepository';

export interface RemoteProgressRecord extends ProgressRecord {
  mediaId: string;
  completed: boolean;
}

export type ProgressSyncResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'badResponse'; statusCode: number }
  | { kind: 'unreachable'; message: string };

export interface ProgressClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 4000;
const PROGRESS_PATH = '/api/progress';

export async function fetchProgressRecords(
  options: ProgressClientOptions = {},
): Promise<ProgressSyncResult<RemoteProgressRecord[]>> {
  return requestProgress(options, async (fetchImpl, signal) => {
    const response = await fetchImpl(PROGRESS_PATH, { signal });
    if (response.status !== 200) {
      return { kind: 'badResponse', statusCode: response.status };
    }
    const body = await response.json();
    if (!isRecord(body) || !Array.isArray(body.records)) {
      return { kind: 'badResponse', statusCode: 200 };
    }
    const records = body.records
      .map(parseRemoteProgressRecord)
      .filter((record): record is RemoteProgressRecord => record !== null);
    return { kind: 'ok', value: records };
  });
}

export async function putProgressRecord(
  mediaId: string,
  record: ProgressRecord,
  options: ProgressClientOptions = {},
): Promise<ProgressSyncResult<RemoteProgressRecord>> {
  const trimmed = mediaId.trim();
  if (trimmed === '') {
    return { kind: 'badResponse', statusCode: 400 };
  }
  return requestProgress(options, async (fetchImpl, signal) => {
    const body = {
      mediaId: trimmed,
      positionSec: record.positionSec,
      durationSec: record.durationSec,
      lastPlayedAt: record.lastPlayedAt,
      completed: isComplete(record),
      ...(record.source !== undefined ? { source: record.source } : {}),
    };
    const response = await fetchImpl(
      `${PROGRESS_PATH}/${encodeURIComponent(trimmed)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(body),
      },
    );
    if (response.status !== 200) {
      return { kind: 'badResponse', statusCode: response.status };
    }
    const responseBody = await response.json();
    const parsed = parseRemoteProgressRecord(responseBody);
    if (parsed === null) {
      return { kind: 'badResponse', statusCode: 200 };
    }
    return { kind: 'ok', value: parsed };
  });
}

export async function deleteProgressRecord(
  mediaId: string,
  options: ProgressClientOptions = {},
): Promise<ProgressSyncResult<null>> {
  const trimmed = mediaId.trim();
  if (trimmed === '') {
    return { kind: 'badResponse', statusCode: 400 };
  }
  return requestProgress(options, async (fetchImpl, signal) => {
    const response = await fetchImpl(
      `${PROGRESS_PATH}/${encodeURIComponent(trimmed)}`,
      {
        method: 'DELETE',
        signal,
      },
    );
    if (response.status !== 204) {
      return { kind: 'badResponse', statusCode: response.status };
    }
    return { kind: 'ok', value: null };
  });
}

async function requestProgress<T>(
  options: ProgressClientOptions,
  run: (
    fetchImpl: typeof fetch,
    signal: AbortSignal,
  ) => Promise<ProgressSyncResult<T>>,
): Promise<ProgressSyncResult<T>> {
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

  try {
    try {
      return await run(fetchImpl, controller.signal);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { kind: 'unreachable', message: 'request cancelled or timed out' };
      }
      return {
        kind: 'unreachable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseRemoteProgressRecord(raw: unknown): RemoteProgressRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.mediaId !== 'string' || raw.mediaId.trim() === '') return null;
  if (typeof raw.positionSec !== 'number' || raw.positionSec < 0) return null;
  if (typeof raw.durationSec !== 'number' || raw.durationSec < 0) return null;
  if (typeof raw.lastPlayedAt !== 'string') return null;
  const record: RemoteProgressRecord = {
    mediaId: raw.mediaId,
    positionSec: raw.positionSec,
    durationSec: raw.durationSec,
    lastPlayedAt: raw.lastPlayedAt,
    completed: raw.completed === true,
  };
  if (isRecord(raw.source)) {
    const source = parseSource(raw.source);
    if (source !== null) record.source = source;
  }
  return record;
}

function parseSource(raw: Record<string, unknown>): ProgressRecord['source'] | null {
  if (raw.mediaType !== 'audio' && raw.mediaType !== 'video') return null;
  if (typeof raw.name !== 'string') return null;
  if (typeof raw.rootName !== 'string') return null;
  if (typeof raw.relativePath !== 'string') return null;
  return {
    mediaType: raw.mediaType,
    name: raw.name,
    rootName: raw.rootName,
    relativePath: raw.relativePath,
  };
}

function isComplete(record: ProgressRecord): boolean {
  if (record.durationSec <= 0) return false;
  if (record.positionSec >= record.durationSec * 0.95) return true;
  return record.durationSec - record.positionSec < 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
