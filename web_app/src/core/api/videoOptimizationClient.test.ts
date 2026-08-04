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
});
