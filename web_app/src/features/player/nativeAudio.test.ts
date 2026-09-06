import { describe, expect, it, vi } from 'vitest';
import { connectNativeAudio, type NativePlaybackSnapshot } from './nativeAudio';
import { createPlayerStore } from './playerStore';
import type { NativeBridge } from '../../core/platform/nativeBridge';
import type { PlaybackSource } from '../../core/playback/source/source';

const track = (id: string): PlaybackSource => ({ kind: 'remote', mediaId: id, queueEntryId: `q-${id}`, mediaType: 'audio', name: id, url: `/api/media/${id}/stream` });
const a = track('a'); const b = track('b');
const snapshot: NativePlaybackSnapshot = { source: a, status: { kind: 'playing' }, positionSec: 42, durationSec: 100, queue: [a, b], index: 0, repeatMode: 'all', volume: 0.4, muted: false, stopAfterCurrent: false, sleepTimerEndsAtMs: null, sleepTimerExpired: false };
async function setup(initial = snapshot) {
  let native = { ...initial };
  let listener: Parameters<NativeBridge['subscribe']>[0] = () => {};
  const request = vi.fn(async (command: string, payload?: object) => {
    const data = payload as Partial<NativePlaybackSnapshot> & { positionSec?: number } | undefined;
    if (command === 'playback.load') native = { ...native, ...data, status: { kind: 'paused' } };
    if (command === 'playback.queue') native = { ...native, ...data };
    if (command === 'playback.settings') native = { ...native, ...data };
    if (command === 'playback.play') native = { ...native, status: { kind: 'playing' } };
    if (command === 'playback.pause') native = { ...native, status: { kind: 'paused' } };
    return command === 'playback.snapshot' ? native : undefined;
  });
  const bridge = { request, subscribe: (fn: typeof listener) => { listener = fn; return () => {}; }, dispose: vi.fn() } as NativeBridge;
  const store = createPlayerStore({ activityRepository: null, preferencesRepository: null, likedRepository: null });
  const dispose = await connectNativeAudio(store, bridge);
  request.mockClear();
  return { store, request, bridge, dispose, setNative: (value: NativePlaybackSnapshot) => { native = value; }, emit: (state: NativePlaybackSnapshot) => listener({ type: 'playback', state }) };
}
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
describe('native audio ownership', () => {
  it('restores a running service without loading or playing again', async () => {
    const { store, request, dispose } = await setup();
    expect(store.getState()).toMatchObject({ nativeAudio: true, active: 'audio', musicQueue: [a, b], musicQueueIndex: 0, audio: { source: a, positionSec: 42 } });
    expect(request).not.toHaveBeenCalled(); dispose();
  });
  it('mirrors native transitions and ended without duplicate next/load', async () => {
    const { store, request, emit, dispose } = await setup();
    emit({ ...snapshot, queue: undefined, source: b, index: 1, positionSec: 0 });
    emit({ ...snapshot, queue: undefined, source: b, index: 1, status: { kind: 'ended' } });
    await drain();
    expect(store.getState().audio.source).toEqual(b);
    expect(store.getState().musicQueue).toEqual([a, b]);
    expect(store.getState().musicQueueIndex).toBe(1);
    expect(request).not.toHaveBeenCalled(); dispose();
  });
  it('sends queue/settings changes and pauses native audio before video selection', async () => {
    const { store, request, dispose } = await setup();
    store.getState().setVolume(0.7);
    store.getState().removeQueueTrack('q-b');
    await store.getState().playSource({ ...b, mediaType: 'video' });
    expect(request.mock.calls.map(([command]) => command).filter((command) => command !== 'playback.snapshot')).toEqual(['playback.settings', 'playback.queue', 'playback.pause']);
    expect(store.getState().active).toBe('video'); dispose();
  });
  it('loads an explicitly selected duplicate queue row with its identity', async () => {
    const { store, request, dispose } = await setup();
    await store.getState().playMusicQueue([a, { ...a, queueEntryId: 'q-copy' }], 'a');
    await store.getState().playQueueTrack('q-copy');
    const loads = request.mock.calls.filter(([command]) => command === 'playback.load');
    expect(loads.length).toBeGreaterThan(0);
    expect((loads.at(-1) as unknown[])[1]).toMatchObject({ source: { queueEntryId: 'q-copy' }, index: 1 }); dispose();
  });
});

it('prepares a boot seed with a singleton queue and retains resume fields', async () => {
  const { store, request, emit, dispose } = await setup({ ...snapshot, source: null, queue: [], index: -1, status: { kind: 'idle' } });
  store.getState().seedSource(a, { positionSec: 23 });
  emit({ ...snapshot, source: null, queue: [], index: -1, status: { kind: 'idle' } });
  expect(store.getState().audio.source?.mediaId).toBe('a');
  store.getState().prepareSeededSource('audio');
  await drain();
  const load = request.mock.calls.find(([command]) => command === 'playback.load')?.[1];
  expect(load).toMatchObject({ index: 0, source: { url: expect.stringContaining('#t=23') }, queue: [{ mediaId: 'a', url: expect.stringContaining('#t=23') }], positionSec: 23 });
  dispose();
});
it('keeps pending edits through old events then reconciles authoritative service state', async () => {
  const { store, request, emit, setNative, dispose } = await setup();
  let finish!: () => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(undefined); }));
  store.getState().setVolume(0.8);
  await Promise.resolve();
  emit(snapshot);
  expect(store.getState().volume).toBe(0.8);
  setNative({ ...snapshot, volume: 0.8 });
  finish(); await drain();
  expect(store.getState().volume).toBe(0.8);
  expect(request.mock.calls.some(([command]) => command === 'playback.snapshot')).toBe(true);
  dispose();
});
it('preserves video timer across periodic audio snapshots and reconciles on resume', async () => {
  const { store, request, emit, setNative, dispose } = await setup();
  await store.getState().playSource({ ...b, mediaType: 'video' });
  await drain();
  store.getState().startSleepTimer(10);
  await drain();
  const timer = store.getState().sleepTimer;
  emit({ ...snapshot, status: { kind: 'paused' } });
  expect(store.getState().sleepTimer).toEqual(timer);
  expect(store.getState().active).toBe('video');
  setNative({ ...snapshot, source: b, index: 1, status: { kind: 'paused' }, positionSec: 67 });
  request.mockClear();
  window.dispatchEvent(new Event('muzio-resume'));
  await drain();
  expect(store.getState().audio.positionSec).toBe(67);
  expect(request).toHaveBeenCalledWith('playback.snapshot');
  store.getState().cancelSleepTimer(); dispose();
});
it('keeps the shared shell bridge usable after initialization failure', async () => {
  const bridge = { request: vi.fn().mockRejectedValue(new Error('offline')), subscribe: () => () => {}, dispose: vi.fn() } as NativeBridge;
  await expect(connectNativeAudio(createPlayerStore(), bridge)).rejects.toThrow('offline');
  expect(bridge.dispose).not.toHaveBeenCalled();
});

it('does not overwrite restored paused audio with a boot continue seed', async () => {
  const { store, request, dispose } = await setup({ ...snapshot, status: { kind: 'paused' } });
  store.getState().seedSource(b, { positionSec: 5 });
  expect(store.getState().audio.source).toEqual(a);
  expect(store.getState().audio.positionSec).toBe(42);
  expect(request).not.toHaveBeenCalled(); dispose();
});
it('does not play the previous source after a native load failure', async () => {
  const { store, request, dispose } = await setup();
  const normal = request.getMockImplementation()!;
  request.mockImplementation((command, payload) => command === 'playback.load' ? Promise.reject(new Error('load failed')) : normal(command, payload));
  await expect(store.getState().playSource(b)).rejects.toThrow('load failed');
  expect(request.mock.calls.some(([command]) => command === 'playback.play')).toBe(false);
  dispose();
});
it('does not revert a newly selected queue row while native commands are in flight', async () => {
  const { store, request, emit, dispose } = await setup();
  let finish!: () => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(undefined); }));
  const playing = store.getState().playQueueTrack('q-b');
  await Promise.resolve();
  emit({ ...snapshot, status: { kind: 'paused' } });
  expect(store.getState().audio.source?.mediaId).toBe('b');
  expect(store.getState().musicQueueIndex).toBe(1);
  finish(); await playing; await drain();
  expect(store.getState().audio.source?.mediaId).toBe('b');
  expect(store.getState().musicQueueIndex).toBe(1);
  dispose();
});
it('allocates a distinct duplicate row after restoring a previous WebView queue', async () => {
  const restored = { ...a, queueEntryId: 'queue-1-a' };
  const { store, dispose } = await setup({ ...snapshot, source: restored, queue: [restored], index: 0 });
  const { queueEntryId: _restoredId, ...librarySource } = a;
  await store.getState().insertQueueItemAfterCurrentAndPlay(librarySource);
  await drain();
  const queue = store.getState().musicQueue;
  expect(queue).toHaveLength(2);
  expect(queue[0].queueEntryId).toBe('queue-1-a');
  expect(queue[1].queueEntryId).toBe('queue-2-a');
  expect(store.getState().musicQueueIndex).toBe(1);
  expect(store.getState().audio.source?.queueEntryId).toBe(queue[1].queueEntryId);
  store.getState().removeQueueTrack('queue-1-a');
  await drain();
  expect(store.getState().musicQueue.map((item) => item.queueEntryId)).toEqual(['queue-2-a']);
  expect(store.getState().musicQueueIndex).toBe(0);
  dispose();
});
it('reserves supplied queue IDs before assigning IDs to other rows in a batch', async () => {
  const { store, dispose } = await setup({ ...snapshot, source: null, queue: [], index: -1, status: { kind: 'idle' } });
  const { queueEntryId: _id, ...librarySource } = a;
  await store.getState().playMusicQueue([librarySource, { ...a, queueEntryId: 'queue-1-a' }, librarySource], 'a');
  await drain();
  expect(store.getState().musicQueue.map((item) => item.queueEntryId)).toEqual(['queue-2-a', 'queue-1-a', 'queue-3-a']);
  dispose();
});
