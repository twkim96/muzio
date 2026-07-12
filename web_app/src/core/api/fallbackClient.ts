import type { Playability } from '../playback/capabilities/canPlayMime';

export type FallbackAction =
  | 'direct'
  | 'remux'
  | 'audio_transcode'
  | 'video_transcode'
  | 'disabled';

export type BrowserSupport = 'unknown' | Playability;

export interface FallbackPlan {
  mediaId: string;
  mimeType: string;
  browserSupport: BrowserSupport;
  action: FallbackAction;
  status: string;
  reason: string;
  directUrl: string;
  ffmpeg: {
    available: boolean;
    path?: string;
    version?: string;
    reason?: string;
  };
  policy: {
    systemFfmpegPreferred: boolean;
    nativeBundling: string;
    docker: string;
    remux: string;
    transcode: string;
    limits: {
      maxConcurrentJobs: number;
      maxInputBytes: number;
      jobTimeoutSeconds: number;
    };
  };
}

export type FallbackFetchResult =
  | { kind: 'ok'; plan: FallbackPlan }
  | { kind: 'badResponse'; statusCode: number }
  | { kind: 'unreachable'; message: string };

export interface FallbackFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 4000;
const FALLBACK_BASE_PATH = '/api/fallback/';

export async function fetchFallbackPlan(
  mediaId: string,
  browserSupport: BrowserSupport,
  options: FallbackFetchOptions = {},
): Promise<FallbackFetchResult> {
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

  const url =
    `${FALLBACK_BASE_PATH}${encodeURIComponent(mediaId)}` +
    `?browserSupport=${encodeURIComponent(browserSupport)}`;

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
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

    const plan = parseFallbackPlan(body);
    if (plan === null) return { kind: 'badResponse', statusCode: 200 };
    return { kind: 'ok', plan };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseFallbackPlan(raw: unknown): FallbackPlan | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.mediaId !== 'string') return null;
  if (typeof raw.mimeType !== 'string') return null;
  if (!isBrowserSupport(raw.browserSupport)) return null;
  if (!isFallbackAction(raw.action)) return null;
  if (typeof raw.status !== 'string') return null;
  if (typeof raw.reason !== 'string') return null;
  if (typeof raw.directUrl !== 'string') return null;
  if (!isRecord(raw.ffmpeg)) return null;
  if (!isRecord(raw.policy)) return null;
  if (!isRecord(raw.policy.limits)) return null;
  if (typeof raw.ffmpeg.available !== 'boolean') return null;
  if (typeof raw.policy.systemFfmpegPreferred !== 'boolean') return null;
  return {
    mediaId: raw.mediaId,
    mimeType: raw.mimeType,
    browserSupport: raw.browserSupport,
    action: raw.action,
    status: raw.status,
    reason: raw.reason,
    directUrl: raw.directUrl,
    ffmpeg: {
      available: raw.ffmpeg.available,
      path: optionalString(raw.ffmpeg.path),
      version: optionalString(raw.ffmpeg.version),
      reason: optionalString(raw.ffmpeg.reason),
    },
    policy: {
      systemFfmpegPreferred: raw.policy.systemFfmpegPreferred,
      nativeBundling: stringOrEmpty(raw.policy.nativeBundling),
      docker: stringOrEmpty(raw.policy.docker),
      remux: stringOrEmpty(raw.policy.remux),
      transcode: stringOrEmpty(raw.policy.transcode),
      limits: {
        maxConcurrentJobs: finiteNumber(raw.policy.limits.maxConcurrentJobs),
        maxInputBytes: finiteNumber(raw.policy.limits.maxInputBytes),
        jobTimeoutSeconds: finiteNumber(raw.policy.limits.jobTimeoutSeconds),
      },
    },
  };
}

function isFallbackAction(value: unknown): value is FallbackAction {
  return (
    value === 'direct' ||
    value === 'remux' ||
    value === 'audio_transcode' ||
    value === 'video_transcode' ||
    value === 'disabled'
  );
}

function isBrowserSupport(value: unknown): value is BrowserSupport {
  return (
    value === 'unknown' ||
    value === 'no' ||
    value === 'maybe' ||
    value === 'probably'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
