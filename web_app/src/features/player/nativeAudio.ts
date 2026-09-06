import { createNativeBridge, type NativeBridge } from '../../core/platform/nativeBridge';
import type { PlaybackSession, PlaybackState, SessionListener } from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import type { RepeatMode } from './musicQueue';
import type { PlayerState, PlayerStoreApi } from './playerStore';

export interface NativePlaybackSnapshot extends PlaybackState {
  queue?: PlaybackSource[];
  index: number;
  repeatMode: RepeatMode;
  volume: number;
  muted: boolean;
  stopAfterCurrent: boolean;
  sleepTimerEndsAtMs: number | null;
  sleepTimerExpired: boolean;
}

/** Call once before seeding/rendering. The service is authoritative on recreation. */
export async function connectNativeAudio(store: PlayerStoreApi, bridge: NativeBridge | null = createNativeBridge()): Promise<() => void> {
  if (!bridge) return () => {};
  let applying = false;
  let disposed = false;
  let state: PlaybackState = { source: null, status: { kind: 'idle' }, positionSec: 0, durationSec: 0 };
  const listeners = new Set<SessionListener>();
  let commands: Promise<unknown> = Promise.resolve();
  let pendingCommands = 0;
  let commandRevision = 0;
  let eventRevision = 0;
  let selectionRevision = 0;
  let pendingQueueRevision = 0;
  let queuedQueueUpdate = false;
  // Leave the input task before serializing a potentially large native queue.
  // React can commit the selected/loading state before bridge preparation starts.
  const yieldToUi = () => new Promise<void>((resolve) => {
    if (document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') {
      // A timer after the frame callback gives the committed loading UI a paint
      // opportunity before the synchronous WebMessage JSON serialization.
      const fallback = setTimeout(resolve, 50);
      requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); resolve(); }, 0));
    } else setTimeout(resolve, 0);
  });
  const send = (command: string, payload?: object): Promise<unknown> => {
    pendingCommands += 1;
    commandRevision += 1;
    const operation = commands.then(async () => { await yieldToUi(); return bridge.request(command, payload); });
    const settled = operation.finally(() => {
      pendingCommands -= 1;
      if (pendingCommands === 0 && !disposed) void reconcile().catch(report);
    });
    commands = settled.catch(() => {});
    return settled;
  };
  const report = (error: unknown) => {
    state = { ...state, status: { kind: 'error', message: error instanceof Error ? error.message : String(error) } };
    listeners.forEach((listener) => listener(state));
  };
  const settings = (value: PlayerState) => ({
    repeatMode: value.repeatMode, volume: value.volume, muted: value.muted,
    stopAfterCurrent: value.stopAfterCurrent,
    sleepTimerEndsAtMs: value.active !== 'video' && value.sleepTimer.kind === 'running' ? value.sleepTimer.endsAtMs : null,
  });
  const apply = (snapshot: NativePlaybackSnapshot) => {
    if (disposed) return;
    applying = true;
    try {
      if (snapshot.status.kind === 'playing' && store.getState().active === 'video') store.getState().pauseActive();
      state = { source: snapshot.source, status: snapshot.status, positionSec: snapshot.positionSec, durationSec: snapshot.durationSec,
        mediaPositionUpdateSeq: (state.mediaPositionUpdateSeq ?? 0) + 1 };
      const ownsTimer = store.getState().active !== 'video';
      const remainingSec = Math.max(0, Math.ceil(((snapshot.sleepTimerEndsAtMs ?? 0) - Date.now()) / 1000));
      store.setState({
        ...(snapshot.queue ? { musicQueue: snapshot.queue } : {}), musicQueueIndex: snapshot.index,
        repeatMode: snapshot.repeatMode, volume: snapshot.volume, muted: snapshot.muted,
        stopAfterCurrent: snapshot.stopAfterCurrent,
        ...(ownsTimer ? { sleepTimer: snapshot.sleepTimerExpired ? { kind: 'expired' } : snapshot.sleepTimerEndsAtMs === null ? { kind: 'off' }
          : { kind: 'running', endsAtMs: snapshot.sleepTimerEndsAtMs, remainingSec, durationSec: remainingSec } } : {}),
        ...(snapshot.source && (snapshot.status.kind === 'playing' || store.getState().active === null) ? { active: 'audio' as const } : {}),
      });
      listeners.forEach((listener) => listener(state));
    } finally { applying = false; }
  };
  // Responses acknowledge ordered native mutations. Fetch only after the command
  // drain, and never let an older response overwrite a newer command or event.
  const reconcile = async () => {
    if (disposed || pendingCommands > 0 || queuedQueueUpdate) return;
    const revision = commandRevision;
    const events = eventRevision;
    const snapshot = await bridge.request<NativePlaybackSnapshot>('playback.snapshot');
    if (!disposed && pendingCommands === 0 && revision === commandRevision && events === eventRevision) apply(snapshot);
  };
  let pendingLoad: Promise<unknown> = Promise.resolve();
  const session: PlaybackSession = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load(source) {
      const revision = ++selectionRevision;
      // The load carries the complete queue, so a queue mutation from this
      // same selection must not send it a second time first.
      pendingQueueRevision += 1;
      queuedQueueUpdate = false;
      const current = store.getState();
      const selected = current.musicQueue[current.musicQueueIndex];
      const matchesSelection = selected?.mediaId === source.mediaId &&
        (source.queueEntryId === undefined || source.queueEntryId === selected.queueEntryId);
      const nativeSource = matchesSelection ? { ...source, queueEntryId: selected.queueEntryId } : source;
      const queue = matchesSelection ? current.musicQueue.map((item, index) => index === current.musicQueueIndex ? nativeSource : item) : [nativeSource];
      const index = matchesSelection ? current.musicQueueIndex : 0;
      state = { source: nativeSource, status: { kind: 'loading' }, positionSec: 0, durationSec: source.durationSec ?? 0 };
      listeners.forEach((listener) => listener(state));
      const fragment = /#t=([0-9.]+)/.exec(source.url);
      pendingLoad = send('playback.load', { source: nativeSource, queue, index,
        ...(fragment ? { positionSec: Number(fragment[1]) } : {}) });
      void pendingLoad.catch((error) => { if (revision === selectionRevision) report(error); });
    },
    async play() {
      const revision = selectionRevision;
      await pendingLoad;
      if (revision !== selectionRevision) return;
      await send('playback.play');
    },
    pause() { void send('playback.pause').catch(report); },
    seek(positionSec) { if (Number.isFinite(positionSec) && positionSec >= 0) void send('playback.seek', { positionSec }).catch(report); },
    dispose() { listeners.clear(); },
  };
  store.getState().attachNativeAudio(session, async () => { await send('playback.pause'); });
  let receivedEvent = false;
  const unsubscribeBridge = bridge.subscribe((event) => {
    if (event.type === 'playback' && event.state) {
      receivedEvent = true; eventRevision += 1;
      if (pendingCommands === 0 && !queuedQueueUpdate) apply(event.state as NativePlaybackSnapshot);
    }
  });
  try {
    const snapshot = await bridge.request<NativePlaybackSnapshot>('playback.snapshot');
    // An event delivered while snapshot was in flight is newer than its response.
    if (!receivedEvent) apply(snapshot);
    else if (!store.getState().musicQueue.length && snapshot.queue) store.setState({ musicQueue: snapshot.queue });
  } catch (error) { unsubscribeBridge(); session.dispose(); throw error; }
  const unsubscribeStore = store.subscribe((next, previous) => {
    if (applying || disposed) return;
    if (next.musicQueue !== previous.musicQueue || next.musicQueueIndex !== previous.musicQueueIndex) {
      const revision = ++pendingQueueRevision;
      queuedQueueUpdate = true;
      queueMicrotask(() => {
        if (disposed || revision !== pendingQueueRevision) return;
        queuedQueueUpdate = false;
        const current = store.getState();
        void send('playback.queue', { queue: current.musicQueue, index: current.musicQueueIndex }).catch(report);
      });
    }
    if (JSON.stringify(settings(next)) !== JSON.stringify(settings(previous))) {
      void send('playback.settings', settings(next)).catch(report);
    }
  });
  const onResume = () => { void reconcile().catch(report); };
  const onVisibility = () => { if (document.visibilityState === 'visible') onResume(); };
  window.addEventListener('muzio-resume', onResume);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    disposed = true; unsubscribeStore(); unsubscribeBridge(); session.dispose();
    window.removeEventListener('muzio-resume', onResume);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
