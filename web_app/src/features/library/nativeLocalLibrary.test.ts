import { create } from 'zustand';
import { afterEach, expect, test, vi } from 'vitest';
import { configureAndroidShell } from '../../core/platform/androidShell';
import { createLibraryStore } from './libraryStore';
import { createLocalAwareLibraryStore, startLocalLibraryProgressSync, useNativeLocalLibrary } from './nativeLocalLibrary';
import type { LibraryItem } from '../../core/api/libraryClient';
import { remoteSourceFromLibraryItem, buildStreamingUrl } from '../../core/playback/source/source';

const localItem: LibraryItem = { id: 'local:one', location: 'local', storageId: 'device-root', type: 'audio', rootName: 'Phone', relativePath: 'song.mp3', name: 'song.mp3', sizeBytes: 5, modifiedAt: '2026-09-07T00:00:00Z' };
const remoteItem: LibraryItem = { ...localItem, id: 'server-one', location: undefined, rootName: 'Server' };
function fixture(fetcher = vi.fn().mockResolvedValue({ kind: 'unreachable', message: 'offline' })) {
  const network = createLibraryStore({ type: 'audio', fetcher });
  const local = create<ReturnType<typeof useNativeLocalLibrary.getState>>(() => ({ ...useNativeLocalLibrary.getState(), items: [localItem] }));
  return { network, local, store: createLocalAwareLibraryStore(network, local) };
}
test('local music remains usable through pending/failed remote load and server reset', async () => {
  const { store } = fixture();
  const pending = store.getState().load();
  expect(store.getState().result).toMatchObject({ kind: 'ok', items: [localItem] });
  await pending;
  expect(store.getState().status).toBe('error');
  expect(store.getState().result).toMatchObject({ kind: 'ok', items: [localItem] });
  store.getState().reset();
  expect(store.getState().result).toMatchObject({ kind: 'ok', items: [localItem] });
});
test('server snapshots/deltas and local folder removal remain independent', async () => {
  const { network, local, store } = fixture(vi.fn().mockResolvedValue({ kind: 'ok', items: [remoteItem], revision: 1 }));
  await store.getState().load();
  expect(network.getState().result).toMatchObject({ items: [remoteItem] });
  expect(store.getState().result).toMatchObject({ items: expect.arrayContaining([localItem, remoteItem]) });
  store.getState().applyChanges({ kind: 'ok', revision: 2, upserts: [], deletedIds: ['server-one'], resetRequired: false });
  expect(store.getState().result).toMatchObject({ items: [localItem] });
  local.setState({ items: [] });
  expect(store.getState().result).toMatchObject({ items: [] });
});
test('local source uses opaque native id route and retains resume fragment without server API', () => {
  const source = remoteSourceFromLibraryItem({ ...localItem, type: 'audio' });
  expect(source).toMatchObject({ location: 'local', mediaId: 'local:one', url: '/__muzio_local/media/local%3Aone' });
  expect(buildStreamingUrl('local:one', { startSec: 12 })).toBe('/__muzio_local/media/local%3Aone#t=12');
});

let stopSync: (() => void) | undefined;
afterEach(() => {
  stopSync?.(); stopSync = undefined;
  configureAndroidShell(null);
  useNativeLocalLibrary.setState({ roots: [], items: [], enrichment: undefined, busy: false, error: '' });
  vi.useRealTimers();
});
test('publishes a large playable filename catalog before metadata and stops polling after completion', async () => {
  vi.useFakeTimers();
  const items = Array.from({ length: 1001 }, (_, i) => ({ ...localItem, id: `local:${i}`, name: `track-${i}.mp3` }));
  const enriched = items.map(item => ({ ...item, metadata: { title: item.name, artist: 'Completed Artist' } }));
  const request = vi.fn().mockResolvedValueOnce({ roots: [], items, enrichment: { pending: 1001, total: 1001 } })
    .mockResolvedValueOnce({ roots: [], items: enriched, enrichment: { pending: 0, total: 1001 } });
  configureAndroidShell({ request });
  const network = createLibraryStore({ type: 'audio', fetcher: vi.fn() });
  const combined = createLocalAwareLibraryStore(network);
  stopSync = startLocalLibraryProgressSync();
  await useNativeLocalLibrary.getState().run('add');
  expect(useNativeLocalLibrary.getState()).toMatchObject({ busy: false, enrichment: { pending: 1001 } });
  expect(combined.getState().result).toMatchObject({ kind: 'ok', items: expect.arrayContaining(items) });
  expect(useNativeLocalLibrary.getState().items).toHaveLength(1001);
  await vi.advanceTimersByTimeAsync(2000);
  expect(combined.getState().result).toMatchObject({ items: expect.arrayContaining(enriched) });
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(2);
});
test('a delayed progress read cannot restore a removed folder', async () => {
  let finishRead!: (value: unknown) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }))
    .mockResolvedValueOnce({ roots: [], items: [], enrichment: { pending: 0, total: 0 } });
  configureAndroidShell({ request });
  useNativeLocalLibrary.setState({ items: [localItem], enrichment: { pending: 1, total: 1 } });
  const poll = useNativeLocalLibrary.getState().run('list', undefined, true);
  expect(useNativeLocalLibrary.getState().busy).toBe(false);
  await useNativeLocalLibrary.getState().run('remove', { id: 'device-root' });
  finishRead({ roots: [], items: [localItem], enrichment: { pending: 1, total: 1 } });
  await poll;
  expect(useNativeLocalLibrary.getState()).toMatchObject({ items: [], enrichment: { pending: 0 } });
});
test('resuming the app reads native progress and retries a transient progress error', async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockRejectedValueOnce(new Error('Temporary read failure'))
    .mockResolvedValueOnce({ roots: [], items: [localItem], enrichment: { pending: 0, total: 1 } });
  configureAndroidShell({ request });
  useNativeLocalLibrary.setState({ enrichment: { pending: 1, total: 1 } });
  stopSync = startLocalLibraryProgressSync();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(useNativeLocalLibrary.getState().error).toBe('Temporary read failure');
  await vi.advanceTimersByTimeAsync(2000);
  expect(useNativeLocalLibrary.getState()).toMatchObject({ items: [localItem], error: '', enrichment: { pending: 0 } });
});
