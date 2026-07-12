import type { LibraryItem } from '../../core/api/libraryClient';
import type { LibrarySnapshot, LibrarySnapshotCache } from './libraryStore';

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'library.snapshot.audio.v1';
const MAX_ITEMS = 20_000;

interface StoredSnapshot {
  version: number;
  revision: number;
  etag?: string;
  items: LibraryItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLibraryItem(value: unknown): value is LibraryItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.type === 'audio' &&
    typeof value.rootName === 'string' &&
    typeof value.relativePath === 'string' &&
    typeof value.name === 'string' &&
    typeof value.sizeBytes === 'number' &&
    Number.isFinite(value.sizeBytes) &&
    typeof value.modifiedAt === 'string'
  );
}

function parseSnapshot(raw: string | null): LibrarySnapshot | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== SCHEMA_VERSION) return null;
    if (
      typeof parsed.revision !== 'number' ||
      !Number.isSafeInteger(parsed.revision) ||
      parsed.revision < 0 ||
      !Array.isArray(parsed.items)
    ) {
      return null;
    }
    const items = parsed.items.filter(isLibraryItem).slice(0, MAX_ITEMS);
    return {
      revision: parsed.revision,
      etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
      items,
    };
  } catch {
    return null;
  }
}

function defaultLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function stripForSnapshot(item: LibraryItem): LibraryItem {
  return {
    id: item.id,
    type: item.type,
    rootName: item.rootName,
    relativePath: item.relativePath,
    name: item.name,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    modifiedAt: item.modifiedAt,
    metadata: item.metadata,
  };
}

export function createLocalStorageAudioLibrarySnapshotCache(
  storage?: Storage,
): LibrarySnapshotCache {
  const targetStorage = storage ?? defaultLocalStorage();
  return {
    read() {
      if (targetStorage === null) return null;
      try {
        return parseSnapshot(targetStorage.getItem(STORAGE_KEY));
      } catch {
        return null;
      }
    },
    write(snapshot) {
      if (targetStorage === null) return;
      const stored: StoredSnapshot = {
        version: SCHEMA_VERSION,
        revision: snapshot.revision,
        etag: snapshot.etag,
        items: snapshot.items
          .filter((item) => item.type === 'audio')
          .slice(0, MAX_ITEMS)
          .map(stripForSnapshot),
      };
      try {
        targetStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      } catch {
        // Best effort only. If quota is full, playback and live fetches still
        // work through the ordinary network path.
      }
    },
    clear() {
      if (targetStorage === null) return;
      try {
        targetStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    },
  };
}
