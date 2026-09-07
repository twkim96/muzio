import type { NativeBridge } from './nativeBridge';
import type { PlayerStoreApi } from '../../features/player/playerStore';
import type { PlaybackSource } from '../playback/source/source';
import { contentIdentityForPlaybackSource } from '../media/contentIdentity';
import type { PlaybackActivityDocument, PlaybackActivityRecord } from '../storage/playbackActivityRepository';
import type { ProgressRepository } from '../storage/progressRepository';

type Entry = { id: string; source: PlaybackSource; positionSec: number; durationSec: number;
  completed: boolean; updatedAtMs: number; startedAtMs: number };
type Snapshot = { pending: Entry[] };

/** Import through the store's own repository so its cached activity stays coherent. */
export function mergeNativePlaybackHistory(store: PlayerStoreApi, snapshot: Snapshot, progress?: ProgressRepository): string[] {
  const document = JSON.parse(store.getState().exportPlaybackActivity()) as PlaybackActivityDocument;
  const records = new Map(document.records.map(record => [record.contentKey, record]));
  const acknowledged: string[] = [];
  for (const entry of [...(snapshot.pending ?? [])].filter(validEntry).sort((a, b) => a.startedAtMs - b.startedAtMs || a.updatedAtMs - b.updatedAtMs)) {
    const identity = contentIdentityForPlaybackSource(entry.source);
    let record = records.get(identity.key);
    if (!record) {
      record = { contentKey: identity.key, mediaId: entry.source.mediaId, mediaType: entry.source.mediaType,
        name: entry.source.name, artist: identity.artist, playCount: 0, lastPlayedAt: null,
        lastPositionSec: 0, durationSec: 0, completed: false, events: [] } satisfies PlaybackActivityRecord;
      records.set(identity.key, record);
    }
    if (entry.startedAtMs > (record.nativeHistoryStartedAtMs ?? 0)) {
      const date = new Date(entry.startedAtMs);
      record.playCount += 1;
      record.events = [{ playedAt: date.toISOString(), weekday: date.getDay(), hour: date.getHours() }, ...record.events].slice(0, 200);
      record.nativeHistoryStartedAtMs = entry.startedAtMs;
    }
    const previous = progress?.read(entry.source.mediaId);
    const previousMs = Date.parse(previous?.lastPlayedAt ?? '');
    const activityMs = Date.parse(record.lastPlayedAt ?? '');
    if ((!Number.isFinite(previousMs) || previousMs <= entry.updatedAtMs) &&
        (!Number.isFinite(activityMs) || activityMs <= entry.updatedAtMs)) {
      record.lastPositionSec = entry.positionSec;
      record.durationSec = entry.durationSec;
      record.completed = entry.completed || (entry.durationSec > 0 &&
        (entry.positionSec >= entry.durationSec * 0.9 || entry.durationSec - entry.positionSec <= 15));
      record.lastPlayedAt = new Date(entry.updatedAtMs).toISOString();
      progress?.write(entry.source.mediaId, {
        positionSec: entry.positionSec, durationSec: entry.durationSec, lastPlayedAt: record.lastPlayedAt,
        source: { mediaType: entry.source.mediaType, name: entry.source.name,
          rootName: entry.source.rootName ?? '', relativePath: entry.source.relativePath ?? '' },
      });
    }
    acknowledged.push(entry.id);
  }
  return store.getState().importPlaybackActivity({ version: 1, records: [...records.values()] }) ? acknowledged : [];
}

function validEntry(entry: Entry): boolean {
  return !!entry && typeof entry.id === 'string' && !!entry.source &&
    typeof entry.source.mediaId === 'string' && typeof entry.source.name === 'string' &&
    entry.source.mediaType === 'audio' && [entry.positionSec, entry.durationSec, entry.updatedAtMs, entry.startedAtMs]
      .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) &&
    entry.updatedAtMs <= 8.64e15 && entry.startedAtMs <= 8.64e15;
}

export function connectNativePlaybackHistory(store: PlayerStoreApi, bridge: NativeBridge | null, progress?: ProgressRepository) {
  if (!bridge?.capabilities?.playbackHistory) return Object.assign(() => {}, { ready: Promise.resolve() });
  let disposed = false;
  let running = false;
  const reconcile = async () => {
    if (disposed || running) return;
    running = true;
    try {
      const snapshot = await bridge.request<Snapshot>('playback.history');
      if (disposed) return;
      const ids = mergeNativePlaybackHistory(store, snapshot, progress);
      // Repository writes are best effort. Never discard the native copy when
      // browser storage is unavailable or full, even if its in-memory state changed.
      const persistedActivity = window.localStorage.getItem('music.activity.v1');
      if (persistedActivity !== JSON.stringify(JSON.parse(store.getState().exportPlaybackActivity()))) return;
      const persistedProgress = JSON.parse(window.localStorage.getItem('playback.progress.v1') ?? '{}') as Record<string, { lastPlayedAt?: string }>;
      const durableIds = ids.filter(id => {
        const entry = snapshot.pending.find(candidate => candidate.id === id);
        return !progress || (!!entry && Date.parse(persistedProgress[entry.source.mediaId]?.lastPlayedAt ?? '') >= Math.floor(entry.updatedAtMs));
      });
      if (durableIds.length) await bridge.request('playback.ackHistory', { ids: durableIds });
    } catch { /* The durable outbox retries on the next resume or native event. */ }
    finally { running = false; }
  };
  const resume = () => { void reconcile(); };
  // Pull periodically during foreground playback; every native sample remains durable.
  let lastPull = 0;
  const unsubscribe = bridge.subscribe(event => {
    if ((event.type === 'playback' || event.type === 'history') && Date.now() - lastPull >= 5000) {
      lastPull = Date.now(); resume();
    }
  });
  window.addEventListener('muzio-resume', resume);
  const ready = reconcile();
  return Object.assign(() => { disposed = true; unsubscribe(); window.removeEventListener('muzio-resume', resume); }, { ready });
}
