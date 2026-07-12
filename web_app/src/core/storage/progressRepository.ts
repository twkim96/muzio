/**
 * Persistent playback progress per media id.
 *
 * Today's localStorage implementation stores everything under a single JSON
 * object keyed by media id. The document is loaded once and kept in memory so
 * row reads do not repeatedly parse the whole payload.
 */
export interface ProgressRecord {
  /** Last known playback position, in seconds. */
  positionSec: number;
  /** Best known duration, in seconds, when the record was written. */
  durationSec: number;
  /** ISO 8601 timestamp of the last update. */
  lastPlayedAt: string;
  /**
   * Cached source metadata so the boot-time "Continue" mini-player can
   * rehydrate without a library fetch. Optional because older records
   * written by Phase 8.0 do not carry it; consumers must tolerate absence.
   */
  source?: ProgressRecordSource;
}

export interface ProgressRecordSource {
  mediaType: 'audio' | 'video';
  name: string;
  /** Parent root name from the listing API; used for display. */
  rootName: string;
  /** Forward-slash relative path inside the root. */
  relativePath: string;
}

export interface ProgressRepository {
  read(mediaId: string): ProgressRecord | null;
  write(mediaId: string, record: ProgressRecord): void;
  clear(mediaId: string): void;
  entries(): ReadonlyArray<readonly [string, ProgressRecord]>;
  /** Commit several local records with one persistence write. */
  mergeMany?(
    entries: ReadonlyArray<readonly [string, ProgressRecord]>,
  ): void;
  /** Notify one media consumer after its local record changes. */
  subscribe?(mediaId: string, listener: () => void): () => void;
  /**
   * Returns the entry with the most recent `lastPlayedAt` timestamp, or
   * null if storage is empty. Used by the boot-time mini-player seed.
   */
  mostRecent(): { mediaId: string; record: ProgressRecord } | null;
}

const STORAGE_KEY = 'playback.progress.v1';

interface Snapshot {
  [mediaId: string]: ProgressRecord;
}

function isProgressRecord(value: unknown): value is ProgressRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ProgressRecord>;
  if (
    typeof v.positionSec !== 'number' ||
    typeof v.durationSec !== 'number' ||
    typeof v.lastPlayedAt !== 'string'
  ) {
    return false;
  }
  if (v.source !== undefined) {
    const s = v.source as Partial<ProgressRecordSource>;
    if (
      (s.mediaType !== 'audio' && s.mediaType !== 'video') ||
      typeof s.name !== 'string' ||
      typeof s.rootName !== 'string' ||
      typeof s.relativePath !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

function parseSnapshot(raw: string | null): Snapshot {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Snapshot = {};
    for (const [id, record] of Object.entries(parsed as Record<string, unknown>)) {
      if (isProgressRecord(record)) out[id] = record;
    }
    return out;
  } catch {
    // Corrupt payload: forget it rather than block startup. The next write
    // overwrites the corrupted blob with a fresh snapshot.
    return {};
  }
}

function readSnapshot(storage: Storage | null): Snapshot {
  if (storage === null) return {};
  try {
    return parseSnapshot(storage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeSnapshot(storage: Storage | null, snapshot: Snapshot): void {
  if (storage === null) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded or storage disabled; drop silently. Progress is a
    // best-effort feature.
  }
}

export function createLocalStorageProgressRepository(
  storage?: Storage,
): ProgressRepository {
  const targetStorage = storage ?? defaultLocalStorage();
  let snapshot = readSnapshot(targetStorage);
  let mostRecent = findMostRecent(snapshot);
  const listeners = new Map<string, Set<() => void>>();

  const notify = (changedIds: ReadonlySet<string>) => {
    for (const mediaId of changedIds) {
      for (const listener of listeners.get(mediaId) ?? []) listener();
    }
  };

  const commit = (changedIds: ReadonlySet<string>) => {
    if (changedIds.size === 0) return;
    mostRecent = findMostRecent(snapshot);
    writeSnapshot(targetStorage, snapshot);
    notify(changedIds);
  };

  const repository: ProgressRepository = {
    read(mediaId) {
      if (mediaId === '') return null;
      return snapshot[mediaId] ?? null;
    },
    write(mediaId, record) {
      if (mediaId === '') return;
      if (!isWritableProgressRecord(record)) return;
      snapshot[mediaId] = cloneProgressRecord(record);
      commit(new Set([mediaId]));
    },
    clear(mediaId) {
      if (mediaId === '') return;
      if (mediaId in snapshot) {
        delete snapshot[mediaId];
        commit(new Set([mediaId]));
      }
    },
    entries() {
      return Object.entries(snapshot);
    },
    mergeMany(entries) {
      const changedIds = new Set<string>();
      for (const [mediaId, record] of entries) {
        if (mediaId === '' || !isWritableProgressRecord(record)) continue;
        snapshot[mediaId] = cloneProgressRecord(record);
        changedIds.add(mediaId);
      }
      commit(changedIds);
    },
    subscribe(mediaId, listener) {
      if (mediaId === '') return () => {};
      const current = listeners.get(mediaId) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(mediaId, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(mediaId);
      };
    },
    mostRecent() {
      return mostRecent;
    },
  };

  if (usesWindowLocalStorage(targetStorage)) {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || event.storageArea !== targetStorage) {
        return;
      }
      const next = parseSnapshot(event.newValue);
      const changedIds = changedMediaIds(snapshot, next);
      snapshot = next;
      mostRecent = findMostRecent(snapshot);
      notify(changedIds);
    });
  }

  return repository;
}

function defaultLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isWritableProgressRecord(record: ProgressRecord): boolean {
  return (
    isProgressRecord(record) &&
    Number.isFinite(record.positionSec) &&
    record.positionSec >= 0 &&
    Number.isFinite(record.durationSec) &&
    record.durationSec >= 0
  );
}

function cloneProgressRecord(record: ProgressRecord): ProgressRecord {
  return {
    ...record,
    ...(record.source !== undefined ? { source: { ...record.source } } : {}),
  };
}

function findMostRecent(
  snapshot: Snapshot,
): { mediaId: string; record: ProgressRecord } | null {
  let bestId: string | null = null;
  let bestRecord: ProgressRecord | null = null;
  let bestStamp = Number.NEGATIVE_INFINITY;
  for (const [id, record] of Object.entries(snapshot)) {
    const stamp = Date.parse(record.lastPlayedAt);
    if (!Number.isFinite(stamp)) continue;
    if (stamp > bestStamp) {
      bestStamp = stamp;
      bestId = id;
      bestRecord = record;
    }
  }
  if (bestId === null || bestRecord === null) return null;
  return { mediaId: bestId, record: bestRecord };
}

function changedMediaIds(previous: Snapshot, next: Snapshot): Set<string> {
  const changed = new Set<string>();
  for (const mediaId of new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ])) {
    if (!sameProgressRecord(previous[mediaId], next[mediaId])) {
      changed.add(mediaId);
    }
  }
  return changed;
}

function sameProgressRecord(
  left: ProgressRecord | undefined,
  right: ProgressRecord | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.positionSec === right.positionSec &&
    left.durationSec === right.durationSec &&
    left.lastPlayedAt === right.lastPlayedAt &&
    left.source?.mediaType === right.source?.mediaType &&
    left.source?.name === right.source?.name &&
    left.source?.rootName === right.source?.rootName &&
    left.source?.relativePath === right.source?.relativePath
  );
}

function usesWindowLocalStorage(storage: Storage | null): boolean {
  if (storage === null || typeof window === 'undefined') return false;
  try {
    return storage === window.localStorage;
  } catch {
    return false;
  }
}
