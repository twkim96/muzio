import type { LibraryMediaType } from '../api/libraryClient';

export interface PlaybackActivitySource {
  contentKey: string;
  mediaId: string;
  mediaType: LibraryMediaType;
  name: string;
  artist: string | null;
}

export interface PlaybackActivityEvent {
  playedAt: string;
  weekday: number;
  hour: number;
}

export interface PlaybackActivityRecord extends PlaybackActivitySource {
  playCount: number;
  lastPlayedAt: string | null;
  lastPositionSec: number;
  durationSec: number;
  completed: boolean;
  events: PlaybackActivityEvent[];
}

export interface PlaybackProgressPatch {
  positionSec: number;
  durationSec: number;
  completed: boolean;
}

export interface PlaybackActivityDocument {
  version: 1;
  records: PlaybackActivityRecord[];
}

export interface PlaybackActivityRepository {
  list(): PlaybackActivityRecord[];
  recordPlay(source: PlaybackActivitySource, atMs?: number): PlaybackActivityRecord[];
  updateProgress(
    source: PlaybackActivitySource,
    patch: PlaybackProgressPatch,
  ): boolean;
  exportData(): PlaybackActivityDocument;
  importData(data: unknown): PlaybackActivityRecord[];
}

const STORAGE_KEY = 'music.activity.v1';
const MAX_EVENTS_PER_TRACK = 200;
export const MAX_ACTIVITY_DOCUMENT_CHARS = 2_000_000;

export function createLocalStoragePlaybackActivityRepository(
  storage?: Storage,
): PlaybackActivityRepository {
  const targetStorage = storage ?? defaultLocalStorage();
  let document = readDocument(targetStorage);
  let recordsByContentKey = indexRecords(document.records);

  const rebuildIndex = () => {
    recordsByContentKey = indexRecords(document.records);
  };

  const write = (activeContentKey: string): boolean => {
    const pruned = enforceRetention(document, activeContentKey);
    if (pruned) rebuildIndex();
    if (targetStorage === null) return pruned;
    try {
      targetStorage.setItem(STORAGE_KEY, JSON.stringify(document));
    } catch {
      // Leave playback functional when storage is disabled or another origin
      // payload has exhausted the browser quota.
    }
    return pruned;
  };

  return {
    list() {
      return cloneRecords(document.records);
    },
    recordPlay(source, atMs = Date.now()) {
      const record = ensureRecord(document, recordsByContentKey, source);
      const playedAt = new Date(atMs);
      record.playCount += 1;
      record.lastPlayedAt = playedAt.toISOString();
      record.mediaId = source.mediaId;
      record.name = source.name;
      record.artist = source.artist;
      record.events = [
        {
          playedAt: record.lastPlayedAt,
          weekday: playedAt.getDay(),
          hour: playedAt.getHours(),
        },
        ...record.events,
      ].slice(0, MAX_EVENTS_PER_TRACK);
      write(source.contentKey);
      return cloneRecords(document.records);
    },
    updateProgress(source, patch) {
      const existing = recordsByContentKey.get(source.contentKey);
      const record = ensureRecord(document, recordsByContentKey, source);
      const wasCompleted = record.completed;
      record.mediaId = source.mediaId;
      record.name = source.name;
      record.artist = source.artist;
      record.lastPositionSec = sanitizeSeconds(patch.positionSec);
      record.durationSec = sanitizeSeconds(patch.durationSec);
      record.completed = patch.completed || isEffectivelyComplete(record);
      const pruned = write(source.contentKey);
      return existing === undefined || (!wasCompleted && record.completed) || pruned;
    },
    exportData() {
      return cloneDocument(document);
    },
    importData(data) {
      document = normalizeDocument(data);
      rebuildIndex();
      write('');
      return cloneRecords(document.records);
    },
  };
}

function ensureRecord(
  document: PlaybackActivityDocument,
  recordsByContentKey: Map<string, PlaybackActivityRecord>,
  source: PlaybackActivitySource,
): PlaybackActivityRecord {
  let record = recordsByContentKey.get(source.contentKey);
  if (record !== undefined) return record;
  record = {
    ...source,
    playCount: 0,
    lastPlayedAt: null,
    lastPositionSec: 0,
    durationSec: 0,
    completed: false,
    events: [],
  };
  document.records.push(record);
  recordsByContentKey.set(record.contentKey, record);
  return record;
}

function readDocument(storage: Storage | null): PlaybackActivityDocument {
  if (storage === null) return emptyDocument();
  try {
    return normalizeDocument(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return emptyDocument();
  }
}

function normalizeDocument(data: unknown): PlaybackActivityDocument {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.records)) {
    return emptyDocument();
  }
  const seen = new Set<string>();
  const records: PlaybackActivityRecord[] = [];
  for (const raw of data.records) {
    const record = normalizeRecord(raw);
    if (record === null || seen.has(record.contentKey)) continue;
    seen.add(record.contentKey);
    records.push(record);
  }
  return { version: 1, records };
}

function normalizeRecord(raw: unknown): PlaybackActivityRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.contentKey !== 'string' || raw.contentKey.trim() === '') {
    return null;
  }
  if (typeof raw.mediaId !== 'string') return null;
  if (raw.mediaType !== 'audio' && raw.mediaType !== 'video') return null;
  if (typeof raw.name !== 'string') return null;
  const artist = typeof raw.artist === 'string' ? raw.artist : null;
  const events = Array.isArray(raw.events)
    ? raw.events.map(normalizeEvent).filter((event): event is PlaybackActivityEvent => event !== null)
    : [];
  return {
    contentKey: raw.contentKey,
    mediaId: raw.mediaId,
    mediaType: raw.mediaType,
    name: raw.name,
    artist,
    playCount: sanitizeCount(raw.playCount),
    lastPlayedAt:
      typeof raw.lastPlayedAt === 'string' ? raw.lastPlayedAt : null,
    lastPositionSec: sanitizeSeconds(raw.lastPositionSec),
    durationSec: sanitizeSeconds(raw.durationSec),
    completed: raw.completed === true,
    events: events.slice(0, MAX_EVENTS_PER_TRACK),
  };
}

function normalizeEvent(raw: unknown): PlaybackActivityEvent | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.playedAt !== 'string') return null;
  const weekday = sanitizeInteger(raw.weekday, 0, 6);
  const hour = sanitizeInteger(raw.hour, 0, 23);
  if (weekday === null || hour === null) return null;
  return { playedAt: raw.playedAt, weekday, hour };
}

function sanitizeSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function sanitizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function sanitizeInteger(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function isEffectivelyComplete(record: PlaybackActivityRecord): boolean {
  if (record.durationSec <= 0) return false;
  if (record.lastPositionSec >= record.durationSec * 0.9) return true;
  return record.durationSec - record.lastPositionSec <= 15;
}

function emptyDocument(): PlaybackActivityDocument {
  return { version: 1, records: [] };
}

function cloneDocument(
  document: PlaybackActivityDocument,
): PlaybackActivityDocument {
  return {
    version: 1,
    records: cloneRecords(document.records),
  };
}

function cloneRecords(
  records: readonly PlaybackActivityRecord[],
): PlaybackActivityRecord[] {
  return records.map((record) => ({
    ...record,
    events: record.events.map((event) => ({ ...event })),
  }));
}

function indexRecords(
  records: readonly PlaybackActivityRecord[],
): Map<string, PlaybackActivityRecord> {
  return new Map(records.map((record) => [record.contentKey, record]));
}

function enforceRetention(
  document: PlaybackActivityDocument,
  activeContentKey: string,
): boolean {
  let length = serializedDocumentLength(document.records);
  if (length <= MAX_ACTIVITY_DOCUMENT_CHARS) return false;

  const candidates = document.records
    .filter((record) => record.contentKey !== activeContentKey)
    .map((record) => ({
      record,
      serializedLength: JSON.stringify(record).length + 1,
      stamp: activityTimestamp(record),
    }))
    .sort((left, right) => {
      if (left.record.completed !== right.record.completed) {
        return left.record.completed ? -1 : 1;
      }
      return left.stamp - right.stamp;
    });

  const removed = new Set<string>();
  for (const candidate of candidates) {
    if (length <= MAX_ACTIVITY_DOCUMENT_CHARS) break;
    removed.add(candidate.record.contentKey);
    length -= candidate.serializedLength;
  }
  if (removed.size === 0) return false;
  document.records = document.records.filter(
    (record) => !removed.has(record.contentKey),
  );
  return true;
}

function serializedDocumentLength(
  records: readonly PlaybackActivityRecord[],
): number {
  // `{"version":1,"records":[]}` plus commas between records.
  let length = 26;
  for (const record of records) length += JSON.stringify(record).length + 1;
  return length;
}

function activityTimestamp(record: PlaybackActivityRecord): number {
  const stamp = Date.parse(record.lastPlayedAt ?? '');
  return Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function defaultLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
