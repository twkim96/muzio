import { expect, it, vi } from 'vitest';
import type { NativeBridge } from '../../core/platform/nativeBridge';
import { createPlayerStore } from './playerStore';
import { connectNativeVideoSession } from './nativeVideoSession';

it('publishes video state, routes explicit controls and ignores old video actions', async () => {
  const store = createPlayerStore();
  const request = vi.fn(async () => ({}));
  let receive: Parameters<NativeBridge['subscribe']>[0] = () => {};
  const bridge = { request, dispose: vi.fn(), subscribe: (fn: typeof receive) => { receive = fn; return () => {}; } } as NativeBridge;
  const dispose = await connectNativeVideoSession(store, bridge);
  const source = { kind: 'remote' as const, mediaType: 'video' as const, mediaId: 'v1', name: 'Clip', url: '/api/media/v1' };
  const pause = vi.fn(); const play = vi.fn(async () => {}); const seek = vi.fn();
  store.setState({ active: 'video', pauseActive: pause, togglePlayPause: play, seekActive: seek,
    video: { source, positionSec: 42.1, durationSec: 120, status: { kind: 'playing' } } });
  expect(request).toHaveBeenLastCalledWith('playback.videoSession', expect.objectContaining({ active: true, playing: true, positionSec: 42, source: expect.objectContaining({ mediaId: 'v1' }) }));
  const count = request.mock.calls.length;
  store.setState({ video: { ...store.getState().video, positionSec: 42.2 } });
  expect(request).toHaveBeenCalledTimes(count);
  const action = (action: string, mediaId = 'v1', positionSec?: number) => receive({ type: 'videoSessionAction', state: { action, mediaId, positionSec } });
  action('play'); expect(play).not.toHaveBeenCalled();
  action('pause'); expect(pause).toHaveBeenCalledOnce();
  action('seek', 'old', 80); expect(seek).not.toHaveBeenCalled();
  action('seek', 'v1', 200); expect(seek).toHaveBeenLastCalledWith(120);
  action('seek', 'v1', NaN); expect(seek).toHaveBeenCalledOnce();
  store.setState({ video: { ...store.getState().video, status: { kind: 'paused' } } });
  action('pause'); expect(pause).toHaveBeenCalledOnce();
  action('play'); expect(play).toHaveBeenCalledOnce();
  store.setState({ active: 'audio' });
  expect(request).toHaveBeenLastCalledWith('playback.videoSession', { active: false });
  action('seek', 'v1', 30); expect(seek).toHaveBeenCalledOnce();
  dispose();
});
it('keeps old Android and native Apple hosts on their own supported path', async () => {
  const store = createPlayerStore();
  const request = vi.fn(async () => { throw new Error('unsupported'); });
  const subscribe = vi.fn();
  await connectNativeVideoSession(store, { request, subscribe } as unknown as NativeBridge);
  expect(subscribe).not.toHaveBeenCalled();
  request.mockClear();
  await connectNativeVideoSession(store, { platform: 'ios', request, subscribe } as unknown as NativeBridge);
  expect(request).not.toHaveBeenCalled();
});
