import type { NativeBridge } from './nativeBridge';
import type { PlayerStoreApi } from '../../features/player/playerStore';

type Change = { id: string; key: string; liked: boolean };
type Snapshot = { pending: Change[] };

/** Mirror web likes to the service; replay durable notification edits before syncing. */
export function connectNotificationLikes(store: PlayerStoreApi, bridge: NativeBridge | null) {
  if (!bridge || (bridge.platform && bridge.platform !== 'android' && !bridge.capabilities?.notificationLikes)) return Object.assign(() => {}, { flush: async () => {} });
  let disposed = false;
  let running: Promise<void> | undefined;
  let dirty = false;
  const applied = new Set<string>();
  const apply = (snapshot: Snapshot) => {
    const acknowledged: string[] = [];
    for (const change of snapshot.pending ?? []) {
      if (typeof change.id !== 'string' || typeof change.key !== 'string' || typeof change.liked !== 'boolean') continue;
      if (!applied.has(change.id)) {
        if (store.getState().likedMediaIds.includes(change.key) !== change.liked) store.getState().toggleLike(change.key);
        applied.add(change.id);
      }
      acknowledged.push(change.id);
    }
    return acknowledged;
  };
  const reconcile = (): Promise<void> => {
    dirty = true;
    if (disposed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
    try {
      while (dirty && !disposed) {
        dirty = false;
        const pending = await bridge.request<Snapshot>('playback.notificationLikes');
        if (disposed) return;
        const acknowledged = apply(pending);
        const result = await bridge.request<Snapshot>('playback.syncNotificationLikes', {
          keys: store.getState().likedMediaIds, acknowledged,
        });
        if (disposed) return;
        // New native edits may arrive during the request; fetch before applying
        // them so a delayed playback snapshot cannot overwrite a newer UI edit.
        if (result.pending?.length) dirty = true;
      }
    } catch {
      // Older installed shells do not expose this optional command. A later
      // resume/change retries without changing playback state or losing likes.
    } finally { running = undefined; }
    })();
    return running;
  };
  const unsubscribe = store.subscribe((next, previous) => {
    if (next.likedMediaIds !== previous.likedMediaIds) void reconcile();
  });
  const unsubscribeBridge = bridge.subscribe(event => {
    const state = event.state as { notificationLikes?: Snapshot } | undefined;
    if (state?.notificationLikes?.pending?.length) void reconcile();
  });
  const resume = () => { void reconcile(); };
  window.addEventListener('muzio-resume', resume);
  void reconcile();
  return Object.assign(() => { disposed = true; unsubscribe(); unsubscribeBridge(); window.removeEventListener('muzio-resume', resume); }, { flush: reconcile });
}
