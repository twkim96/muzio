import { create } from 'zustand';
import { expect, test, vi } from 'vitest';
import { createLibraryStore } from './libraryStore';
import { createLocalAwareLibraryStore, useNativeLocalLibrary } from './nativeLocalLibrary';
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
