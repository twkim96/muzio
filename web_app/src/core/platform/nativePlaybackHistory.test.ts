import { describe, expect, it, vi } from 'vitest';
import { createPlayerStore } from '../../features/player/playerStore';
import { createLocalStoragePlaybackActivityRepository } from '../storage/playbackActivityRepository';
import { createLocalStorageProgressRepository } from '../storage/progressRepository';
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
