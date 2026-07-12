import { describe, expect, test, vi } from 'vitest';

import { fetchFallbackPlan } from './fallbackClient';

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    impl(typeof url === 'string' ? url : url.toString(), init)) as typeof fetch;
}

const samplePlan = {
  mediaId: 'v/1',
  mimeType: 'video/x-matroska',
  browserSupport: 'no',
  action: 'remux',
  status: 'available',
  reason: 'container fallback can try remux before transcode',
  directUrl: '/api/media/v%2F1',
  ffmpeg: {
    available: true,
    path: '/usr/bin/ffmpeg',
    version: 'ffmpeg version 7.0',
  },
  policy: {
    systemFfmpegPreferred: true,
    nativeBundling: 'disabled',
    docker: 'allowed with license notes',
    remux: 'container-only remux is preferred',
    transcode: 'bounded jobs only',
    limits: {
      maxConcurrentJobs: 1,
      maxInputBytes: 8589934592,
      jobTimeoutSeconds: 1800,
    },
  },
};

describe('fetchFallbackPlan', () => {
  test('requests a same-origin fallback plan for the media id', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(JSON.stringify(samplePlan), { status: 200 });
    });

    const result = await fetchFallbackPlan('v/1', 'no', { fetchImpl });

    expect(observedUrl).toBe('/api/fallback/v%2F1?browserSupport=no');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.plan.action).toBe('remux');
      expect(result.plan.policy.limits.maxConcurrentJobs).toBe(1);
    }
  });

  test('returns badResponse for non-200 responses', async () => {
    const fetchImpl = fakeFetch(async () => new Response('nope', { status: 404 }));
    const result = await fetchFallbackPlan('missing', 'no', { fetchImpl });
    expect(result).toEqual({ kind: 'badResponse', statusCode: 404 });
  });

  test('returns badResponse for malformed plan JSON', async () => {
    const fetchImpl = fakeFetch(
      async () => new Response(JSON.stringify({ mediaId: 'x' }), { status: 200 }),
    );
    const result = await fetchFallbackPlan('x', 'no', { fetchImpl });
    expect(result).toEqual({ kind: 'badResponse', statusCode: 200 });
  });

  test('reports timeouts as unreachable', async () => {
    const fetchImpl = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const result = await fetchFallbackPlan('slow', 'no', {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result.kind).toBe('unreachable');
  });

  test('reports thrown errors as unreachable', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('net down');
    });
    const result = await fetchFallbackPlan('v1', 'no', { fetchImpl });
    expect(result).toEqual({ kind: 'unreachable', message: 'net down' });
  });

  test('forwards an external AbortSignal', async () => {
    const externalController = new AbortController();
    const fetchImpl = vi.fn(
      fakeFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );

    const promise = fetchFallbackPlan('v1', 'no', {
      fetchImpl,
      signal: externalController.signal,
    });
    externalController.abort();

    await expect(promise).resolves.toMatchObject({ kind: 'unreachable' });
    expect(fetchImpl).toHaveBeenCalled();
  });
});
