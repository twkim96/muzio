import { describe, expect, it, vi } from 'vitest';
import { createPlayerStore } from '../../features/player/playerStore';
import { createLocalStoragePlaybackActivityRepository } from '../storage/playbackActivityRepository';
import { createLocalStorageProgressRepository } from '../storage/progressRepository';
import { createSyncedProgressRepository } from '../storage/progressSyncRepository';
import type { NativeBridge } from './nativeBridge';
import { connectNativePlaybackHistory, mergeNativePlaybackHistory } from './nativePlaybackHistory';

const source = { kind: 'remote' as const, mediaType: 'audio' as const, mediaId: 'track', name: 'Song', url: '/track' };
const entry = { id: 'revision1', source, startedAtMs: 1000, updatedAtMs: 2000, positionSec: 40, durationSec: 100, completed: false };
function setup() {
  localStorage.clear();
  const activity = createLocalStoragePlaybackActivityRepository();
  const store = createPlayerStore({ activityRepository: activity, preferencesRepository: null, likedRepository: null });
  return { store, progress: createLocalStorageProgressRepository() };
}
describe('native playback history', () => {
  it('routes remote progress to the server but keeps local progress on this device', () => {
    const { store } = setup();
    const local = createLocalStorageProgressRepository();
    const put = vi.fn(async () => {});
    const progress = createSyncedProgressRepository(local, { list: async () => [], put, delete: async () => {} });
    const localEntry = {
      ...entry,
      id: 'local-revision',
      source: { ...source, mediaId: 'local:track', location: 'local' as const, rootName: 'Phone', relativePath: 'Music/Song.mp3' },
    };
    mergeNativePlaybackHistory(store, { pending: [localEntry] }, progress);
    expect(local.read('local:track')).toMatchObject({ positionSec: 40, durationSec: 100 });
    expect(put).not.toHaveBeenCalled();

    const remoteEntry = { ...entry, id: 'remote-revision', updatedAtMs: 3000,
      source: { ...source, rootName: 'Server Music', relativePath: 'Album/Song.mp3' } };
    mergeNativePlaybackHistory(store, { pending: [remoteEntry] }, progress);
    expect(local.read('track')).toMatchObject({ positionSec: 40, durationSec: 100 });
    expect(put).toHaveBeenCalledWith('track', expect.objectContaining({ positionSec: 40, durationSec: 100 }));
  });
  it('replays an acknowledged session after reload without counting it again', () => {
    const { store, progress } = setup();
    expect(mergeNativePlaybackHistory(store, { pending: [entry] }, progress)).toEqual(['revision1']);
    const reloaded = createPlayerStore({ activityRepository: createLocalStoragePlaybackActivityRepository(), preferencesRepository: null, likedRepository: null });
    mergeNativePlaybackHistory(reloaded, { pending: [{ ...entry, id: 'revision2', updatedAtMs: 3000, positionSec: 100, completed: true }] }, progress);
    expect(reloaded.getState().activityRecords[0]).toMatchObject({ playCount: 1, completed: true, lastPositionSec: 100 });
  });
  it('keeps newer progress while recovering a missing historical play', () => {
    const { store, progress } = setup();
    progress.write('track', { positionSec: 70, durationSec: 100, lastPlayedAt: new Date(5000).toISOString() });
    mergeNativePlaybackHistory(store, { pending: [entry] }, progress);
    expect(progress.read('track')?.positionSec).toBe(70);
    expect(store.getState().activityRecords[0].playCount).toBe(1);
  });
  it('counts repeated sessions once even beyond retained activity events', () => {
    const { store, progress } = setup();
    const pending = Array.from({ length: 205 }, (_, i) => ({ ...entry, id: String(i), startedAtMs: 1000 + i, updatedAtMs: 2000 + i }));
    mergeNativePlaybackHistory(store, { pending }, progress);
    mergeNativePlaybackHistory(store, { pending }, progress);
    expect(store.getState().activityRecords[0].playCount).toBe(205);
    expect(store.getState().activityRecords[0].events).toHaveLength(200);
  });
});

it('keeps Android local progress in the native outbox after importing it to device storage', async () => {
  const { store, progress } = setup();
  const localEntry = {
    ...entry,
    id: 'local-revision',
    source: { ...source, mediaId: 'local:track', location: 'local' as const, rootName: 'Phone', relativePath: 'Music/Song.mp3' },
  };
  const request = vi.fn(async (command: string) => command === 'playback.history'
    ? { pending: [localEntry], retainLocal: true }
    : {});
  // Current Android hosts predate explicit capability metadata, so fallback support is intentional.
  const bridge = { request, subscribe: () => () => {} } as unknown as NativeBridge;
  const disconnect = connectNativePlaybackHistory(store, bridge, progress);
  await vi.waitFor(() => expect(progress.read('local:track')?.positionSec).toBe(40));
  expect(request).toHaveBeenCalledWith('playback.history');
  expect(request).not.toHaveBeenCalledWith('playback.ackHistory', expect.anything());
  disconnect();
});

it('keeps remote native history until the server accepts the progress update', async () => {
  const { store } = setup();
  const local = createLocalStorageProgressRepository();
  const put = vi.fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const progress = createSyncedProgressRepository(local, { list: async () => [], put, delete: async () => {} });
  const request = vi.fn(async (command: string) => command === 'playback.history' ? { pending: [entry] } : {});
  const bridge = { platform: 'android' as const, request, subscribe: () => () => {} } as unknown as NativeBridge;
  const disconnect = connectNativePlaybackHistory(store, bridge, progress);
  await disconnect.ready;
  expect(request).not.toHaveBeenCalledWith('playback.ackHistory', expect.anything());
  window.dispatchEvent(new Event('muzio-resume'));
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('playback.ackHistory', { ids: ['revision1'] }));
  expect(put.mock.calls.length).toBeGreaterThanOrEqual(3);
  disconnect();
});

it('does not acknowledge outbox entries when browser persistence fails', async () => {
  const { store, progress } = setup();
  const request = vi.fn(async (command: string) => command === 'playback.history' ? { pending: [entry] } : {});
  const bridge = { capabilities: { playbackHistory: true }, request, subscribe: () => () => {} } as unknown as NativeBridge;
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const disconnect = connectNativePlaybackHistory(store, bridge, progress);
  await vi.waitFor(() => expect(store.getState().activityRecords).toHaveLength(1));
  expect(request).not.toHaveBeenCalledWith('playback.ackHistory', expect.anything());
  failure.mockRestore();
  window.dispatchEvent(new Event('muzio-resume'));
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('playback.ackHistory', { ids: ['revision1'] }));
  expect(store.getState().activityRecords[0].playCount).toBe(1);
  disconnect();
});
