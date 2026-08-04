import { describe, expect, it, vi } from 'vitest';

import { fetchVideoOptimizationStatus, prepareVideoOptimization } from './videoOptimizationClient';

const responseBody = {
  state: 'eligible', mediaId: 'video id', eligible: true, layout: 'end-moov',
  cacheKind: 'faststart-mp4', estimatedOutputBytes: 100,
  requiredFreeBytes: 600, availableBytes: 1000, cacheUsedBytes: 20,
  peakCacheBytes: 620,
};

describe('videoOptimizationClient', () => {
  it('encodes media ids and parses status', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    const status = await fetchVideoOptimizationStatus('video id', { fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith('/api/video-optimization/video%20id', expect.objectContaining({ method: 'GET' }));
    expect(status?.layout).toBe('end-moov');
  });

  it('accepts eligibility errors as structured status', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ...responseBody, state: 'ineligible', eligible: false }), { status: 422 }));
    expect((await prepareVideoOptimization('video id', { fetchImpl: fetchImpl as typeof fetch }))?.state).toBe('ineligible');
  });

  it('requests and parses HLS package statistics without changing media identity', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ...responseBody,
      cacheKind: 'hls-fmp4',
      layout: 'front-moov',
      targetSegmentSeconds: 6,
      segmentCount: 12,
      gop: { count: 12, min: 5, median: 6, p95: 7, max: 8 },
    }), { status: 200 }));
    const status = await fetchVideoOptimizationStatus('video id', {
      fetchImpl: fetchImpl as typeof fetch,
      kind: 'hls-fmp4',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/video-optimization/video%20id?kind=hls-fmp4',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(status).toMatchObject({
      mediaId: 'video id', cacheKind: 'hls-fmp4', segmentCount: 12,
      gop: { median: 6, p95: 7, max: 8 },
    });
  });
});
