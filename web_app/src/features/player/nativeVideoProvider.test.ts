import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AudioTrackList, HLSProviderLoader, FullscreenButton, MediaPlayer, MediaProvider, PlayButton, TextTrackList, type MediaPlayerInstance, type MediaContext, type MediaProviderAdapter } from '@vidstack/react';
import { createElement, createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NativeBridge } from '../../core/platform/nativeBridge';
import { configureAndroidShell } from '../../core/platform/androidShell';
import { NativeVideoProvider, NativeVideoProviderLoader, type NativeVideoState } from './nativeVideoProvider';
import { encodeNativeVideoSource } from './nativeVideoSource';
import { connectNativeVideoSurface } from './nativeVideoSurface';
import { createVidstackEngine } from './vidstackEngine';

function harness(audioTracks = new AudioTrackList()) {
  let listener: (event: { type: string; state?: unknown }) => void = () => {};
  const unsubscribe = vi.fn();
  const request = vi.fn(async (_command: string, _payload?: { generation?: string }) => ({}));
  const bridge = {
    request,
    subscribe: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }),
  } as unknown as NativeBridge;
  const notify = vi.fn();
  const ready = vi.fn(async (_info: { buffered: TimeRanges }) => {});
  const textTracks = new TextTrackList();
  const context = { notify, delegate: { ready }, textTracks, audioTracks } as unknown as MediaContext;
  const provider = new NativeVideoProvider(context, bridge, {} as MediaProviderAdapter['scope']);
  provider.setup();
  const generation = () => request.mock.calls.at(-1)?.[1]?.generation as string;
  const emit = (state: Partial<NativeVideoState> = {}) => listener({ type: 'video', state: {
    generation: generation(), ready: true, playing: false, ended: false,
    positionSec: 0, durationSec: 120, volume: 1, muted: false,
    rate: 1, pip: false, seeking: false, ...state,
  } });
  return { provider, request, notify, ready, emit, generation, unsubscribe, textTracks, audioTracks };
}

describe('native Vidstack provider', () => {
  it.each([
    ['https://muzio.test/movie.mp4', false, 'ios'],
    ['https://muzio.test/playlist.m3u8?token=abc', false, 'ios'],
    ['https://muzio.test/movie.mp4', true, 'ios'],
    ['https://muzio.test/movie.mp4', false, 'macos'],
    ['/api/media/v1?v=2#t=24', false, 'ios'],
    ['/api/media/v1?v=2#t=24', false, 'macos'],
  ] as const)('loads %s through the real engine and provider (pause while loading: %s, platform: %s)', async (sourceUrl, pauseWhileLoading, platform) => {
    const proxyBase = 'http://localhost:12345/0123456789abcdef0123456789abcdef/';
    const usesProxy = sourceUrl.startsWith('/api/');
    if (usesProxy) vi.stubGlobal('MuzioNative', { platform, videoIndexBaseUrl: proxyBase, postMessage: vi.fn() });
    const expectedSourceUrl = usesProxy ? `${proxyBase}${sourceUrl.slice(1)}` : sourceUrl;
    const hlsSupported = HLSProviderLoader.supported;
    HLSProviderLoader.supported = true;
    const listeners = new Set<(event: { type: string; state?: unknown }) => void>();
    const request = vi.fn(async (_command: string, _payload?: { generation?: string }) => ({}));
    configureAndroidShell({ platform, capabilities: { nativeVideo: true }, request,
      subscribe: (listener: (event: { type: string; state?: unknown }) => void) => {
        listeners.add(listener); return () => listeners.delete(listener);
      },
    } as unknown as NativeBridge);
    const player = createRef<MediaPlayerInstance>();
    const renderPlayer = (src?: import('@vidstack/react').PlayerSrc) => createElement('div', { 'data-testid': 'player-screen' }, createElement('div', { 'data-testid': 'native-surface' }, createElement(MediaPlayer, {
      ref: player, src,
      viewType: 'video', load: 'custom', playsInline: true,
      children: [createElement(MediaProvider, { key: 'provider', loaders: [NativeVideoProviderLoader] }),
        createElement(PlayButton, { key: 'play', 'aria-label': 'Play' }),
        createElement(FullscreenButton, { key: 'fullscreen', 'aria-label': 'Fullscreen' })],
    })));
    const view = render(renderPlayer());
    let disposeSurface: (() => void) | undefined;
    let engine: ReturnType<typeof createVidstackEngine> | undefined;
    let playTask: Promise<void> | undefined;
    try {
      await waitFor(() => expect(player.current).not.toBeNull());
      engine = createVidstackEngine(player.current!, async (source) => {
        view.rerender(renderPlayer(source ? { src: encodeNativeVideoSource(source.url), type: 'video/muzio-native' } as unknown as import('@vidstack/react').PlayerSrc : undefined));
      });
      act(() => {
        engine!.load({ kind: 'remote', mediaId: 'v1', mediaType: 'video', url: sourceUrl,
          mimeType: 'video/mp4', name: 'movie.mp4', rootName: 'videos', relativePath: 'movie.mp4' });
        playTask = engine!.play();
      });
      await waitFor(() => expect(request).toHaveBeenCalledWith('video.load', expect.objectContaining({
        url: expectedSourceUrl, generation: expect.any(String),
      })));
      const generation = request.mock.calls.find(([command]) => command === 'video.load')![1]!.generation;
      const emit = (playing: boolean, positionSec: number, ready = true, seekable: number[][] = [[0, 120]]) => {
        const state = { generation, ready, playing, positionSec, durationSec: 120,
          volume: 1, muted: false, rate: 1, pip: false, seeking: false, ended: false,
          buffered: [[0, 60]], seekable,
        };
        for (const listener of listeners) listener({ type: 'video', state });
      };
      // The native engine publishes its paused loading snapshot before readiness.
      act(() => emit(false, 0, false));
      if (pauseWhileLoading) act(() => engine!.pause());
      if (platform === 'macos' || usesProxy) {
        // A host may discover duration before VLC reports that seeking is ready.
        act(() => emit(false, 0, true, []));
        await waitFor(() => expect(player.current!.state.canPlay).toBe(true));
        if (usesProxy) await act(async () => { await playTask; });
      }
      act(() => emit(false, 0));
      await waitFor(() => expect(player.current!.state.canPlay).toBe(true));
      await waitFor(() => {
        expect(player.current!.state.streamType).toBe('on-demand');
        expect(player.current!.state.duration).toBe(120);
        expect(player.current!.state.live).toBe(false);
        expect(player.current!.state.canSeek).toBe(true);
      });
      await act(async () => { await playTask; });
      if (pauseWhileLoading) {
        expect(request.mock.calls.some(([command]) => command === 'video.play')).toBe(false);
        return;
      }
      await waitFor(() => expect(request).toHaveBeenCalledWith('video.play', { generation }));
      if (usesProxy) {
        // Cold mini-player playback must send the saved position to the host,
        // even if readiness arrived before the native seekable range.
        await waitFor(() => expect(request).toHaveBeenCalledWith('video.seek', {
          generation, positionSec: 24,
        }));
      }
      act(() => emit(true, 24));
      await waitFor(() => {
        expect(player.current!.paused).toBe(false);
        expect(player.current!.currentTime).toBe(24);
        expect(view.getByRole('button', { name: 'Play' })).not.toHaveAttribute('data-paused');
      });
      if (sourceUrl.endsWith('movie.mp4')) {
        const surface = view.getByTestId('native-surface');
        const home = surface.parentElement;
        const playerElement = view.container.querySelector<HTMLElement>('[data-media-player]')!;
        disposeSurface = connectNativeVideoSurface(surface);
        const stockFullscreenRequest = vi.fn();
        playerElement.addEventListener('media-enter-fullscreen-request', stockFullscreenRequest);
        playerElement.addEventListener('media-exit-fullscreen-request', stockFullscreenRequest);
        const instance = player.current;
        await act(async () => { view.getByRole('button', { name: 'Fullscreen' }).dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })); });
        await waitFor(() => expect(player.current!.state.fullscreen).toBe(true));
        expect(surface.parentElement).toBe(document.body);
        expect(stockFullscreenRequest).not.toHaveBeenCalled();
        await act(async () => { playerElement.querySelector<HTMLElement>('[aria-label="Fullscreen"]')!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })); });
        await waitFor(() => expect(player.current!.state.fullscreen).toBe(false));
        expect(surface.parentElement).toBe(home);
        expect(stockFullscreenRequest).not.toHaveBeenCalled();
        expect(player.current).toBe(instance);
        expect(request.mock.calls.filter(([command]) => command === 'video.load')).toHaveLength(1);
        disposeSurface(); disposeSurface = undefined;
      }
      const outlet = view.container.querySelector('video');
      expect(outlet).not.toBeNull();
      expect(outlet).not.toHaveAttribute('src');
      expect(outlet!.querySelector('source')).toBeNull();
      act(() => emit(false, 24));
      await waitFor(() => expect(player.current!.paused).toBe(true));
    } finally {
      disposeSurface?.();
      engine?.release();
      view.unmount();
      configureAndroidShell(null);
      HLSProviderLoader.supported = hlsSupported;
      if (usesProxy) vi.unstubAllGlobals();
    }
  });

  it('creates an isolated disposable Vidstack scope without loading a second media engine', async () => {
    const request = vi.fn(async () => ({}));
    configureAndroidShell({ platform: 'ios', capabilities: { nativeVideo: true },
      request, subscribe: () => () => {},
    } as unknown as NativeBridge);
    const loader = new NativeVideoProviderLoader();
    const video = document.createElement('video');
    loader.target = video;
    const parentDispose = vi.fn();
    try {
      const context = { player: { scope: { dispose: parentDispose } }, textTracks: new TextTrackList(), audioTracks: new AudioTrackList() } as unknown as MediaContext;
      const provider = await loader.load(context);
      expect(provider.scope).not.toBe(context.player.scope);
      expect(video.hasAttribute('src')).toBe(false);
      expect(request).not.toHaveBeenCalled();
      provider.destroy();
      expect(() => provider.scope.dispose()).not.toThrow();
      expect(parentDispose).not.toHaveBeenCalled();
    } finally { configureAndroidShell(null); }
  });

  it('ignores old source callbacks and reports readiness only for the current source', async () => {
    const h = harness();
    await h.provider.loadSource({ src: '/first.mp4', type: 'video/mp4' });
    const first = h.generation();
    await h.provider.loadSource({ src: '/second.mp4', type: 'video/mp4' });
    h.emit({ generation: first, ended: true, error: 'stale' });
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalledWith('end');
    expect(h.notify).not.toHaveBeenCalledWith('error', expect.anything());
    h.emit({ buffered: [[0, 25]], seekable: [[0, 120]] });
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.ready.mock.calls[0][0].buffered.end(0)).toBe(25);
    expect(h.provider.currentSrc?.src).toBe('/second.mp4');
  });

  it('keeps seeking pending until the actual native seek transition completes', async () => {
    const h = harness();
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    h.emit();
    h.provider.setCurrentTime(40);
    h.emit({ positionSec: 0, seeking: false });
    expect(h.notify).not.toHaveBeenCalledWith('seeked', expect.anything());
    h.emit({ positionSec: 0, seeking: true });
    h.emit({ positionSec: 40, seeking: false });
    expect(h.notify).toHaveBeenCalledWith('seeked', 40);
    expect(h.request).toHaveBeenCalledWith('video.seek', expect.objectContaining({ positionSec: 40 }));
  });

  it('exposes PiP only after explicit native support and resets support on a new source', async () => {
    const h = harness();
    expect(h.provider.pictureInPicture.supported).toBe(false);
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    h.emit();
    expect(h.provider.pictureInPicture.supported).toBe(false);
    h.emit({ pipSupported: true });
    expect(h.provider.pictureInPicture.supported).toBe(true);
    h.emit({ pipSupported: false });
    expect(h.provider.pictureInPicture.supported).toBe(false);
    h.emit({ pipSupported: true });
    await h.provider.loadSource({ src: '/next.mp4', type: 'video/mp4' });
    expect(h.provider.pictureInPicture.supported).toBe(false);
  });

  it('routes existing settings and PiP controls to the native engine and mirrors playback events', async () => {
    const h = harness();
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    h.provider.setPlaybackRate(1.5);
    h.provider.setVolume(0.4);
    h.provider.setMuted(true);
    await h.provider.play();
    await h.provider.pictureInPicture.enter();
    expect(h.request).toHaveBeenCalledWith('video.settings', expect.objectContaining({ rate: 1.5 }));
    expect(h.request).toHaveBeenCalledWith('video.settings', expect.objectContaining({ volume: 0.4 }));
    expect(h.request).toHaveBeenCalledWith('video.settings', expect.objectContaining({ muted: true }));
    expect(h.request).toHaveBeenCalledWith('video.pip', expect.objectContaining({ active: true }));
    h.emit({ playing: true, pip: true, rate: 1.5, volume: 0.4, muted: true });
    expect(h.notify).toHaveBeenCalledWith('playing');
    expect(h.notify).toHaveBeenCalledWith('rate-change', 1.5);
    expect(h.notify).toHaveBeenCalledWith('picture-in-picture-change', true);
    expect(h.provider.pictureInPicture.active).toBe(true);
    h.emit({ ended: true });
    expect(h.notify).toHaveBeenCalledWith('end');
  });

  it('unsubscribes and clears only its own generation on disposal', async () => {
    const h = harness();
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    const generation = h.generation();
    h.provider.destroy();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith('video.clear', { generation });
    h.notify.mockClear();
    h.emit({ generation, playing: true });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('preserves the subtitle menu and off selection without echoing native snapshots', async () => {
    const h = harness();
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    h.emit({ textTracks: [{ id: 'ko', label: 'Korean', language: 'ko', selected: false }] });
    const track = h.textTracks.getById('ko')!;
    expect(track.label).toBe('Korean');
    expect(h.request).not.toHaveBeenCalledWith('video.tracks', expect.anything());
    track.setMode('showing');
    expect(h.request).toHaveBeenCalledWith('video.tracks', expect.objectContaining({ textId: 'ko' }));
    track.setMode('disabled');
    expect(h.request).toHaveBeenCalledWith('video.tracks', expect.objectContaining({ textId: null }));
    h.request.mockClear();
    h.emit({ generation: 'stale', textTracks: [] });
    expect(h.textTracks.length).toBe(1);
    await h.provider.loadSource({ src: '/next.mp4', type: 'video/mp4' });
    expect(h.textTracks.length).toBe(0);
  });

  it('uses the installed Vidstack audio list contract for selection and source cleanup', async () => {
    const h = harness();
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    h.emit({ audioTracks: [
      { id: 'en', label: 'English', language: 'en', selected: true },
      { id: 'ko', label: 'Korean', language: 'ko', selected: false },
    ] });
    expect(h.audioTracks.length).toBe(2);
    expect(h.audioTracks.selected?.id).toBe('en');
    expect(h.request).not.toHaveBeenCalledWith('video.tracks', expect.anything());
    h.audioTracks.getById('ko')!.selected = true;
    expect(h.request).toHaveBeenCalledWith('video.tracks', expect.objectContaining({ audioId: 'ko' }));
    await h.provider.loadSource({ src: '/next.mp4', type: 'video/mp4' });
    expect(h.audioTracks.length).toBe(0);
  });

  it('syncs real production audio tracks before readiness and removes only absent tracks', async () => {
    const require = createRequire(import.meta.url);
    const entry = pathToFileURL(join(dirname(require.resolve('@vidstack/react/package.json')), 'prod/vidstack.js')).href;
    const production = await import(/* @vite-ignore */ entry) as typeof import('@vidstack/react');
    const h = harness(new production.AudioTrackList());
    let tracksAtReady: string[] = [];
    h.ready.mockImplementation(async () => { tracksAtReady = h.audioTracks.toArray().map(track => track.id); });
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    const english = { id: 'en', label: 'English', language: 'en', selected: true };
    const korean = { id: 'ko', label: 'Korean', language: 'ko', selected: false };
    h.emit({ audioTracks: [english, korean] });
    expect(h.ready).toHaveBeenCalledOnce();
    expect(tracksAtReady).toEqual(['en', 'ko']);
    expect(h.audioTracks.toArray().map(track => track.id)).toEqual(['en', 'ko']);
    expect(h.audioTracks.selected?.id).toBe('en');
    expect(h.request).not.toHaveBeenCalledWith('video.tracks', expect.anything());
    h.audioTracks.getById('ko')!.selected = true;
    expect(h.request).toHaveBeenCalledWith('video.tracks', expect.objectContaining({ audioId: 'ko' }));
    h.emit({ audioTracks: [{ ...korean, selected: true }] });
    expect(h.audioTracks.toArray().map(track => track.id)).toEqual(['ko']);
    await h.provider.loadSource({ src: '/next.mp4', type: 'video/mp4' });
    expect(h.audioTracks.length).toBe(0);
  });

  it('reports incompatible audio lists as a player error instead of throwing out of the bridge callback', async () => {
    class IncompatibleAudioList extends AudioTrackList {}
    const h = harness(new IncompatibleAudioList());
    await h.provider.loadSource({ src: '/movie.mp4', type: 'video/mp4' });
    const symbols = vi.spyOn(Object, 'getOwnPropertySymbols').mockReturnValue([]);
    try {
      expect(() => h.emit({ audioTracks: [
        { id: 'en', label: 'English', language: 'en', selected: true },
      ] })).not.toThrow();
      expect(h.notify).toHaveBeenCalledWith('error', {
        code: 1, message: 'Vidstack audio track compatibility failure: safe add/remove operations are unavailable',
      });
      expect(h.ready).not.toHaveBeenCalled();
    } finally { symbols.mockRestore(); }
  });
});
