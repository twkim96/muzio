import { expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createPlayerStore } from '../../features/player/playerStore';
import { connectNotificationLikes } from './notificationLikes';
import type { NativeBridge } from './nativeBridge';

test.each(['android', 'ios', 'macos'] as const)('%s replays persisted notification likes, acknowledges them, and mirrors web changes', async (platform) => {
  const write = vi.fn();
  const store = createPlayerStore({ activityRepository: null, preferencesRepository: null,
    likedRepository: { list: () => ['existing'], write } });
  let pending = [{ id: '1', key: 'song', liked: true }];
  let keys: string[] = [];
  const request = vi.fn(async (command: string, payload?: object) => {
    if (command === 'playback.syncNotificationLikes') {
      const data = payload as { keys: string[]; acknowledged: string[] };
      keys = data.keys;
      pending = pending.filter(change => !data.acknowledged.includes(change.id));
    }
    return { pending };
  });
  const bridge = { platform, capabilities: { notificationLikes: true }, request, subscribe: () => () => {}, dispose: () => {} } as NativeBridge;
  const dispose = connectNotificationLikes(store, bridge);
  await waitFor(() => expect(keys).toEqual(['existing', 'song']));
  expect(pending).toEqual([]);
  expect(write).toHaveBeenCalledWith(['existing', 'song']);
  store.getState().toggleLike('song');
  await waitFor(() => expect(keys).toEqual(['existing']));
  dispose();
});

test('failed acknowledgement retries without replaying a toggle over a newer web edit', async () => {
  const store = createPlayerStore({ activityRepository: null, preferencesRepository: null, likedRepository: null });
  let fail = true;
  const request = vi.fn(async (command: string) => {
    if (command === 'playback.notificationLikes') return { pending: [{ id: '1', key: 'song', liked: true }] };
    if (fail) throw Error('disconnected');
    return { pending: [] };
  });
  const bridge = { platform: 'android', request, subscribe: () => () => {}, dispose: () => {} } as NativeBridge;
  const dispose = connectNotificationLikes(store, bridge);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  fail = false;
  store.getState().toggleLike('song');
  await waitFor(() => expect(request).toHaveBeenLastCalledWith('playback.syncNotificationLikes', { keys: [], acknowledged: ['1'] }));
  expect(store.getState().likedMediaIds).toEqual([]);
  dispose();
});
