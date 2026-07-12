import { describe, expect, test } from 'vitest';

import {
  deleteProgressRecord,
  fetchProgressRecords,
  putProgressRecord,
} from './progressClient';

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    impl(typeof url === 'string' ? url : url.toString(), init)) as typeof fetch;
}

describe('progressClient', () => {
  test('fetches and parses server progress records', async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(
        JSON.stringify({
          records: [
            {
              mediaId: 'm1',
              positionSec: 45,
              durationSec: 600,
              lastPlayedAt: '2026-06-01T10:00:00Z',
              completed: false,
              source: {
                mediaType: 'video',
                name: 'clip.mp4',
                rootName: 'video',
                relativePath: 'clip.mp4',
              },
            },
            { mediaId: '', positionSec: 0, durationSec: 0 },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchProgressRecords({ fetchImpl });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].source?.name).toBe('clip.mp4');
    }
  });

  test('puts a progress record to the media-specific route', async () => {
    let observedUrl = '';
    let observedBody: Record<string, unknown> = {};
    const fetchImpl = fakeFetch(async (url, init) => {
      observedUrl = url;
      observedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(observedBody), { status: 200 });
    });

    const result = await putProgressRecord(
      'm 1',
      {
        positionSec: 590,
        durationSec: 600,
        lastPlayedAt: '2026-06-01T10:00:00Z',
      },
      { fetchImpl },
    );

    expect(observedUrl).toBe('/api/progress/m%201');
    expect(observedBody.completed).toBe(true);
    expect(result.kind).toBe('ok');
  });

  test('deletes a progress record', async () => {
    let observedMethod = '';
    const fetchImpl = fakeFetch(async (_url, init) => {
      observedMethod = init?.method ?? '';
      return new Response(null, { status: 204 });
    });

    const result = await deleteProgressRecord('m1', { fetchImpl });

    expect(observedMethod).toBe('DELETE');
    expect(result.kind).toBe('ok');
  });

  test('returns badResponse for non-200 fetches', async () => {
    const fetchImpl = fakeFetch(async () => new Response('boom', { status: 500 }));
    const result = await fetchProgressRecords({ fetchImpl });
    expect(result).toEqual({ kind: 'badResponse', statusCode: 500 });
  });

  test('returns unreachable for thrown network errors', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('offline');
    });
    const result = await fetchProgressRecords({ fetchImpl });
    expect(result.kind).toBe('unreachable');
  });
});
