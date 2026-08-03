import { describe, expect, test, vi } from 'vitest';

import type { PlaybackSource } from '../../core/playback/source/source';
import { createAudioResumeCacheService } from './audioResumeCacheService';

const resumedAAC: PlaybackSource = {
  kind: 'remote',
  mediaId: 'aac-1',
  mediaType: 'audio',
  url: '/api/media/aac-1#t=120.5',
  mimeType: 'audio/aac',
  name: 'long.aac',
};

describe('audioResumeCacheService', () => {
  test('routes only the ready cached song through the remux stream', async () => {
    const service = createAudioResumeCacheService({
      fetchStatus: async () => ({
        state: 'ready',
        mediaId: 'aac-1',
        url: '/api/audio-resume-cache/media/aac-1',
      }),
    });
    await service.initialize();

    expect(service.resolve(resumedAAC)).toEqual({
      ...resumedAAC,
      url: '/api/audio-resume-cache/media/aac-1#t=120.5',
      mimeType: 'audio/mp4',
    });
    expect(
      service.resolve({ ...resumedAAC, mediaId: 'aac-2', url: '/api/media/aac-2#t=30' }),
    ).toMatchObject({ url: '/api/media/aac-2#t=30' });
    expect(service.resolve({ ...resumedAAC, url: '/api/media/aac-1' })).toEqual(
      expect.objectContaining({ url: '/api/media/aac-1' }),
    );
  });

  test('deduplicates preparation while the latest cache is building', async () => {
    let resolveRequest!: (status: {
      state: 'building';
      buildingMediaId: string;
    }) => void;
    const requestCache = vi.fn(
      () =>
        new Promise<{ state: 'building'; buildingMediaId: string }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const service = createAudioResumeCacheService({
      fetchStatus: async () => ({ state: 'empty' }),
      requestCache,
      setTimeout: () => 0,
    });

    service.prepare('aac-1');
    service.prepare('aac-1');
    expect(requestCache).toHaveBeenCalledTimes(1);
    resolveRequest({ state: 'building', buildingMediaId: 'aac-1' });
    await Promise.resolve();
  });
});
