import type { NativeBridge } from '../../core/platform/nativeBridge';
import type { PlayerStoreApi } from './playerStore';

/** Android's native session controls the existing WebView video through the store. */
export async function connectNativeVideoSession(store: PlayerStoreApi, bridge: NativeBridge | null) {
  if (!bridge || (bridge.platform && bridge.platform !== 'android')) return () => {};
  // Old installed APKs don't understand this command. Keep their web fallback.
  try { await bridge.request('playback.videoSession', { active: false }); }
  catch { return () => {}; }
  bridge.capabilities = { nativeAudio: true, localLibrary: true, ...bridge.capabilities, nativeVideoSession: true };
  let last = '';
  const report = () => {
    const state = store.getState();
    const video = state.video;
    const active = state.active === 'video' && video.source !== null &&
      !['idle', 'ended', 'error'].includes(video.status.kind);
    const payload = active ? {
      active, source: { mediaId: video.source!.mediaId, title: video.source!.title,
        name: video.source!.name, artist: video.source!.artist },
      positionSec: Math.floor(video.positionSec), durationSec: video.durationSec,
      playing: ['playing', 'buffering', 'loading'].includes(video.status.kind),
      buffering: ['buffering', 'loading'].includes(video.status.kind),
    } : { active: false };
    const signature = JSON.stringify(payload);
    if (signature === last) return;
    last = signature;
    void bridge.request('playback.videoSession', payload).catch(() => {});
  };
  const unsubscribe = store.subscribe(report);
  const off = bridge.subscribe(event => {
    if (event.type !== 'videoSessionAction') return;
    const action = event.state as { mediaId?: string; action?: string; positionSec?: number } | undefined;
    const state = store.getState();
    if (state.active !== 'video' || !action || state.video.source?.mediaId !== action.mediaId) return;
    const playing = ['playing', 'loading', 'buffering'].includes(state.video.status.kind);
    if (action.action === 'play' && !playing) void state.togglePlayPause();
    if (action.action === 'pause' && playing) state.pauseActive();
    if (action.action === 'seek' && typeof action.positionSec === 'number' && Number.isFinite(action.positionSec)) {
      state.seekActive(Math.max(0, Math.min(action.positionSec, state.video.durationSec || action.positionSec)));
    }
  });
  report();
  return () => { unsubscribe(); off(); void bridge.request('playback.videoSession', { active: false }).catch(() => {}); };
}
