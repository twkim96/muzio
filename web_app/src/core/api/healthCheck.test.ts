import { describe, expect, test, vi } from 'vitest';

import { probeHealth } from './healthCheck';

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    impl(typeof url === 'string' ? url : url.toString(), init)) as typeof fetch;
}

describe('probeHealth', () => {
  test('issues a same-origin /healthz request and returns ok on the documented response', async () => {
    let observedUrl = '';
    const fetchImpl = fakeFetch(async (url) => {
      observedUrl = url;
      return new Response(
        JSON.stringify({ status: 'ok', service: 'muzio-backend' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await probeHealth({ fetchImpl });

    expect(observedUrl).toBe('/healthz');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.service).toBe('muzio-backend');
    }
  });

  test('treats non-200 as bad response with the status code preserved', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 404 }));

    const result = await probeHealth({ fetchImpl });

    expect(result.kind).toBe('badResponse');
    if (result.kind === 'badResponse') {
      expect(result.statusCode).toBe(404);
    }
  });

  test('treats non-JSON 200 as bad response', async () => {
    const fetchImpl = fakeFetch(
      async () => new Response('hello', { status: 200 }),
    );

    const result = await probeHealth({ fetchImpl });

    expect(result.kind).toBe('badResponse');
  });

  test('treats wrong status field as bad response', async () => {
    const fetchImpl = fakeFetch(
      async () =>
        new Response(JSON.stringify({ status: 'degraded' }), { status: 200 }),
    );

    const result = await probeHealth({ fetchImpl });

    expect(result.kind).toBe('badResponse');
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

    const result = await probeHealth({ fetchImpl, timeoutMs: 10 });

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.message).toBe('connection timed out');
    }
  });

  test('reports thrown errors as unreachable', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('connection refused');
    });

    const result = await probeHealth({ fetchImpl });

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.message).toBe('connection refused');
    }
  });

  test('uses default fetch when no fetchImpl override is provided', async () => {
    const stub = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', service: 'fake' }), {
        status: 200,
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const result = await probeHealth();
      expect(result.kind).toBe('ok');
      expect(stub).toHaveBeenCalledWith(
        '/healthz',
        expect.objectContaining({ signal: expect.anything() }),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test('aborts during body read when the timeout fires after headers arrive', async () => {
    // Simulate a server that streams headers but stalls the body. The
    // production code only consumes .status and .json(), so we can hand-roll
    // a Response-shaped object whose json() promise resolves only on abort.
    const fetchImpl = fakeFetch(async (_url, init) => {
      const fakeResponse = {
        status: 200,
        json: () =>
          new Promise<unknown>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      } as unknown as Response;
      return fakeResponse;
    });

    const result = await probeHealth({ fetchImpl, timeoutMs: 20 });

    expect(result.kind).toBe('unreachable');
    if (result.kind === 'unreachable') {
      expect(result.message).toBe('connection timed out');
    }
  });
});
