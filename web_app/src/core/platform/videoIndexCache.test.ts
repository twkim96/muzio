// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../public/video-index-cache.js', import.meta.url), 'utf8');
const context = { Request, Response, Headers, URL, Blob, ReadableStream, AbortController, fetch, console };
runInNewContext(source, context);
const { create, retain } = (context as any).MuzioVideoIndexCache;
const manifest = { eligible: true, revision: 'r1', fileSize: 10, indexBytes: 4, mimeType: 'video/mp4', modifiedAt: 'Mon, 07 Sep 2026 01:00:00 GMT' };
function setup(stale = false) {
  const current = { ...manifest };
  const entries = new Map<string, { revision: string; blob: Blob }>();
  const store = {
    touch: vi.fn(async (id: string) => {
      const entry = entries.get(id);
      return entry ? { indexBytes: entry.blob.size, revision: entry.revision } : undefined;
    }),
    delete: vi.fn(async (id: string) => { entries.delete(id); }),
    get: vi.fn(async (id: string, revision: string) => {
      const entry = entries.get(id);
      if (entry?.revision !== revision) { entries.delete(id); return undefined; }
      return entry.blob;
    }),
    put: vi.fn(async (id: string, revision: string, blob: Blob) => { entries.set(id, { revision, blob }); }),
  };
  const fetcher = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.searchParams.get('index') === 'manifest') return Response.json(current);
    if (url.searchParams.get('index') === 'data') return new Response('0123', { headers: { 'Content-Length': '4' } });
    if (url.searchParams.has('index_revision')) return stale ? new Response(null, { status: 409 }) : new Response('456789', { status: 206, headers: { 'Content-Range': 'bytes 4-9/10', 'Content-Length': '6', 'X-Muzio-Revision': 'r1' } });
    return new Response('direct');
  });
  return { cache: create({ store, fetcher }), store, fetcher, current, entries };
}
const request = (range = 'bytes=0-') => new Request('https://muzio.test/api/media/video?v=2', { headers: { Range: range } });
describe('persistent video index worker', () => {
  it('keeps two entries, promotes reads and replaces old revisions', () => {
    const entry = (identity: string, revision: string, used: number) => ({ identity, key: identity + revision, revision, used, bytes: 3 });
    let entries = retain([], entry('a', '1', 1));
    entries = retain(entries, entry('b', '1', 2));
    entries = retain(entries, entry('a', '1', 3));
    entries = retain(entries, entry('c', '1', 4));
    expect(entries.map((item: any) => item.identity)).toEqual(['c', 'a']);
    entries = retain(entries, entry('a', '2', 5));
    expect(entries.map((item: any) => item.key)).toEqual(['a2', 'c1']);
  });
  it('streams index bytes plus validated tail and reuses cached bytes', async () => {
    const { cache, fetcher, store } = setup();
    const response = await cache.handle(request());
    expect(response.status).toBe(206);
    expect(response.headers.get('X-Muzio-Index-Cache')).toBe('miss');
    expect(response.headers.get('Content-Range')).toBe('bytes 0-9/10');
    expect(await response.text()).toBe('0123456789');
    const warm = await cache.handle(request('bytes=2-3'));
    expect(warm.headers.get('X-Muzio-Index-Cache')).toBe('hit');
    expect(await warm.text()).toBe('23');
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.filter(([req]) => new URL(req.url).searchParams.get('index') === 'manifest')).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([req]) => new URL(req.url).searchParams.get('index') === 'data')).toHaveLength(1);
  });
  it('revalidates the manifest and replaces a cached old revision', async () => {
    const { cache, store, current } = setup();
    expect(await (await cache.handle(request('bytes=0-3'))).text()).toBe('0123');
    current.revision = 'r2';
    expect(await (await cache.handle(request('bytes=0-3'))).text()).toBe('0123');
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(store.put.mock.calls.at(-1)?.[1]).toBe('r2');
  });
  it('uses index bytes for a matching If-Range date and passes other validators through', async () => {
    const { cache, fetcher } = setup();
    const conditional = (value: string) => {
      const req = request('bytes=0-3');
      req.headers.set('If-Range', value);
      return req;
    };
    expect(await (await cache.handle(conditional(manifest.modifiedAt))).text()).toBe('0123');
    for (const value of ['Sun, 06 Sep 2026 01:00:00 GMT', 'W/"r1"', '"r1"', 'invalid']) {
      expect(await (await cache.handle(conditional(value))).text()).toBe('direct');
      expect(fetcher.mock.calls.at(-1)?.[0].headers.get('If-Range')).toBe(value);
    }
  });
  it('touches cached entries for probes and tail seeks without fetching manifests', async () => {
    const { cache, store, fetcher } = setup();
    await (await cache.handle(request('bytes=0-3'))).text();
    fetcher.mockClear();
    store.touch.mockClear();
    for (const range of ['bytes=0-1', 'bytes=4-9', 'bytes=134217728-']) {
      expect(await (await cache.handle(request(range))).text()).toBe('direct');
    }
    expect(store.touch).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([req]) => !new URL(req.url).searchParams.has('index'))).toBe(true);
  });
  it('deletes corrupted cached bytes and refills the current revision', async () => {
    const { cache, store, entries } = setup();
    entries.set('https://muzio.test/api/media/video', { revision: 'r1', blob: new Blob(['bad']) });
    expect(await (await cache.handle(request('bytes=0-3'))).text()).toBe('0123');
    expect(store.delete).toHaveBeenCalledWith('https://muzio.test/api/media/video', 'r1');
    expect(store.put).toHaveBeenCalledTimes(1);
  });
  it('never mixes cached bytes with a stale tail', async () => {
    const { cache, fetcher } = setup(true);
    expect(await (await cache.handle(request())).text()).toBe('direct');
    expect(fetcher.mock.calls.at(-1)?.[0].url).toBe(request().url);
  });
  it('passes legacy no-CORS media directly through without touching the index', async () => {
    const { cache, store, fetcher } = setup();
    const legacy = new Request(request(), { mode: 'no-cors' });
    // Browser-owned destination cannot be set by the Request constructor.
    Object.defineProperty(legacy, 'destination', { value: 'video' });
    expect(await (await cache.handle(legacy)).text()).toBe('direct');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(legacy);
    expect(store.touch).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous fills and bypasses probes and unsupported ranges', async () => {
    const { cache, store, fetcher } = setup();
    const responses = await Promise.all([cache.handle(request('bytes=0-3')), cache.handle(request('bytes=0-3'))]);
    expect(await Promise.all(responses.map((response: Response) => response.text()))).toEqual(['0123', '0123']);
    expect(store.put).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    for (const range of ['bytes=0-1', 'bytes=-4', 'bytes=0-3,8-9']) expect(await (await cache.handle(request(range))).text()).toBe('direct');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
