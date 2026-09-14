import { HLSProviderLoader, type MediaProviderAdapter } from '@vidstack/react';
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureAndroidShell } from '../../core/platform/androidShell';
import type { PlaybackSource } from '../../core/playback/source/source';
import { PlayerProvider } from './PlayerContext';
import { createPlayerStore } from './playerStore';
import { PersistentVidstackPlayer } from './PersistentVidstackPlayer';
import {
  configureEmbeddedHLSProvider,
  supportsEmbeddedHLSPlayback,
} from './hlsPlaybackSupport';

describe('PersistentVidstackPlayer HLS support', () => {
  const originalSupported = HLSProviderLoader.supported;

  afterEach(() => {
    HLSProviderLoader.supported = originalSupported;
    configureAndroidShell(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts MediaSource-backed HLS even without native video HLS', () => {
    HLSProviderLoader.supported = true;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');

    expect(supportsEmbeddedHLSPlayback()).toBe(true);
  });

  it('keeps native HLS support when the HLS.js provider is unavailable', () => {
    HLSProviderLoader.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');

    expect(supportsEmbeddedHLSPlayback()).toBe(true);
  });

  it('uses the bundled HLS.js loader for Vidstack HLS providers', async () => {
    const provider = {
      $$PROVIDER_TYPE: 'HLS',
      library: null,
    } as unknown as MediaProviderAdapter & {
      library: (() => Promise<unknown>) | null;
    };

    configureEmbeddedHLSProvider(provider);

    expect(provider.library).toBeTypeOf('function');
    const module = await provider.library!();
    expect(module).toHaveProperty('default');
  });

  it.each([
    ['missing', { nativeAudio: true }],
    ['false', { nativeAudio: true, nativeVideo: false }],
  ] as const)(
    'keeps iOS native audio while rendering HTML video when nativeVideo is %s',
    async (_label, capabilities) => {
      const request = vi.fn(async (_command: string, _payload?: object) => ({}));
      configureAndroidShell({
        platform: 'ios',
        capabilities,
        request: async <T>(command: string, payload?: object) => await request(command, payload) as T,
        subscribe: vi.fn(() => () => {}),
      });
      const cacheBase = 'http://127.0.0.1:12345/0123456789abcdef0123456789abcdef/';
      vi.stubGlobal('MuzioNative', {
        platform: 'ios',
        capabilities,
        videoIndexBaseUrl: cacheBase,
        postMessage: vi.fn(),
      });

      const source: PlaybackSource = {
        kind: 'remote',
        mediaId: 'video1',
        mediaType: 'video',
        url: '/api/media/video1?v=2',
        mimeType: 'video/mp4',
        name: 'clip.mp4',
      };
      const store = createPlayerStore({ activityRepository: null, likedRepository: null });
      store.getState().seedSource(source, { positionSec: 21600, durationSec: 44898 });
      const host = document.createElement('div');
      const portalRoot = document.createElement('div');
      document.body.append(host);
      const view = render(
        createElement(PlayerProvider, {
          store,
          children: createElement(PersistentVidstackPlayer, {
            host,
            portalRoot,
            theaterMode: false,
            onToggleTheaterMode: vi.fn(),
          }),
        }),
      );

      try {
        await waitFor(() => expect(portalRoot.querySelector('video')).not.toBeNull());
        const video = portalRoot.querySelector<HTMLVideoElement>('video')!;
        const expected = `${cacheBase}api/media/video1?v=2#t=21600`;
        await waitFor(() => expect(video.querySelector<HTMLSourceElement>('source')?.src).toBe(expected));
        expect(video).toBeInstanceOf(HTMLVideoElement);
        expect(document.querySelector('[data-native-video-clear], [data-native-video-expanded], [data-native-video-covered]')).toBeNull();
        expect(request.mock.calls.some(([command]) => command.startsWith('video.'))).toBe(false);
      } finally {
        view.unmount();
        store.getState().detachEngine('video');
        host.remove();
      }
    },
  );
  it.each(['ios', 'macos'] as const)('%s sends temporary HLS to HTML video, then restores native library playback', async platform => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(mime => mime === 'application/vnd.apple.mpegurl' ? 'maybe' : '');
    const request = vi.fn(async (_command: string, _payload?: object) => ({}));
    configureAndroidShell({ platform, capabilities: { nativeVideo: true },
      request: async <T>(command: string, payload?: object) => await request(command, payload) as T,
      subscribe: vi.fn(() => () => {}) });
    const source: PlaybackSource = { kind: 'remote', mediaId: 'temporary-hls:test', mediaType: 'video',
      transient: true, url: 'https://example.com/stream.m3u8?sig=a%2Bb', mimeType: 'application/vnd.apple.mpegurl', name: 'HLS' };
    const store = createPlayerStore({ activityRepository: null, likedRepository: null });
    store.getState().seedSource(source);
    const host = document.createElement('div'), portalRoot = document.createElement('div');
    document.body.append(host);
    const view = render(createElement(PlayerProvider, { store, children: createElement(PersistentVidstackPlayer, {
      host, portalRoot, theaterMode: false, onToggleTheaterMode: vi.fn(),
    }) }));
    try {
      await waitFor(() => expect(portalRoot.querySelector('video source')?.getAttribute('src')).toBe(source.url));
      expect(request.mock.calls.some(([command]) => command === 'video.load')).toBe(false);
      expect(document.querySelector('[data-native-video-clear]')).toBeNull();
      act(() => { void store.getState().playSource({ ...source, transient: false, mediaId: 'v1', url: '/api/media/v1', mimeType: 'video/mp4' }); });
      await waitFor(() => expect(request.mock.calls.some(([command]) => command === 'video.load')).toBe(true));
      expect(request.mock.calls.find(([command]) => command === 'video.load')?.[1]).toMatchObject({ url: '/api/media/v1' });
      act(() => { void store.getState().playSource(source); });
      await waitFor(() => expect(portalRoot.querySelector('video source')?.getAttribute('src')).toBe(source.url));
      expect(request.mock.calls.filter(([command]) => command === 'video.load')).toHaveLength(1);
    } finally {
      view.unmount(); store.getState().detachEngine('video'); host.remove();
    }
  });

});
