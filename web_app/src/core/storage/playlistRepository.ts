export interface PlaylistItemRef {
  contentKey: string;
  addedAt: string;
}

export interface PlaylistRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: PlaylistItemRef[];
}

export interface PlaylistDocument {
  version: 1;
  playlists: PlaylistRecord[];
}

export interface PlaylistRepository {
  list(): PlaylistRecord[];
  create(name: string, id?: string): PlaylistRecord[];
  rename(id: string, name: string): PlaylistRecord[];
  delete(id: string): PlaylistRecord[];
  addItem(id: string, contentKey: string): PlaylistRecord[];
  addItems(id: string, contentKeys: readonly string[]): PlaylistRecord[];
  removeItem(id: string, contentKey: string): PlaylistRecord[];
  removeItems(id: string, contentKeys: readonly string[]): PlaylistRecord[];
  moveItem(id: string, contentKey: string, direction: 'up' | 'down'): PlaylistRecord[];
  exportData(): PlaylistDocument;
  importData(data: unknown): PlaylistRecord[];
}

const STORAGE_KEY = 'music.playlists.v1';

export function createLocalStoragePlaylistRepository(
  storage?: Storage,
): PlaylistRepository {
  const targetStorage = storage ?? defaultLocalStorage();

  const read = () => readDocument(targetStorage);
  const write = (document: PlaylistDocument) => {
    if (targetStorage === null) return;
    try {
      targetStorage.setItem(STORAGE_KEY, JSON.stringify(document));
    } catch {
      // Best effort: the music library should stay usable without storage.
    }
  };

  return {
    list() {
      return read().playlists;
    },
    create(name, id = createId()) {
      const cleanName = name.trim();
      if (cleanName === '') return read().playlists;
      const document = read();
      const now = new Date().toISOString();
      document.playlists.push({
        id,
        name: cleanName,
        createdAt: now,
        updatedAt: now,
        items: [],
      });
      write(document);
      return document.playlists;
    },
    rename(id, name) {
      const cleanName = name.trim();
      if (cleanName === '') return read().playlists;
      const document = read();
      const playlist = document.playlists.find((candidate) => candidate.id === id);
      if (playlist !== undefined) {
        playlist.name = cleanName;
        playlist.updatedAt = nextUpdatedAt(playlist.updatedAt);
        write(document);
      }
      return document.playlists;
    },
    delete(id) {
      const document = read();
      document.playlists = document.playlists.filter(
        (playlist) => playlist.id !== id,
      );
      write(document);
      return document.playlists;
    },
    addItem(id, contentKey) {
      return addItemsToPlaylist(read, write, id, [contentKey]);
    },
    addItems(id, contentKeys) {
      return addItemsToPlaylist(read, write, id, contentKeys);
    },
    removeItem(id, contentKey) {
      return removeItemsFromPlaylist(read, write, id, [contentKey]);
    },
    removeItems(id, contentKeys) {
      return removeItemsFromPlaylist(read, write, id, contentKeys);
    },
    moveItem(id, contentKey, direction) {
      const document = read();
      const playlist = document.playlists.find((candidate) => candidate.id === id);
      if (playlist !== undefined) {
        const from = playlist.items.findIndex(
          (item) => item.contentKey === contentKey,
        );
        const to = direction === 'up' ? from - 1 : from + 1;
        if (from >= 0 && to >= 0 && to < playlist.items.length) {
          const [moved] = playlist.items.splice(from, 1);
          playlist.items.splice(to, 0, moved);
          playlist.updatedAt = nextUpdatedAt(playlist.updatedAt);
          write(document);
        }
      }
      return document.playlists;
    },
    exportData() {
      return read();
    },
    importData(data) {
      const document = normalizeDocument(data);
      write(document);
      return document.playlists;
    },
  };
}

function removeItemsFromPlaylist(
  read: () => PlaylistDocument,
  write: (document: PlaylistDocument) => void,
  id: string,
  contentKeys: readonly string[],
): PlaylistRecord[] {
  const keys = new Set(
    contentKeys
      .map((contentKey) => contentKey.trim())
      .filter((contentKey) => contentKey !== ''),
  );
  if (keys.size === 0) return read().playlists;

  const document = read();
  const playlist = document.playlists.find((candidate) => candidate.id === id);
  if (playlist === undefined) return document.playlists;

  const nextItems = playlist.items.filter((item) => !keys.has(item.contentKey));
  if (nextItems.length !== playlist.items.length) {
    playlist.items = nextItems;
    playlist.updatedAt = nextUpdatedAt(playlist.updatedAt);
    write(document);
  }
  return document.playlists;
}

function addItemsToPlaylist(
  read: () => PlaylistDocument,
  write: (document: PlaylistDocument) => void,
  id: string,
  contentKeys: readonly string[],
): PlaylistRecord[] {
  const keys = contentKeys
    .map((contentKey) => contentKey.trim())
    .filter((contentKey) => contentKey !== '');
  if (keys.length === 0) return read().playlists;

  const document = read();
  const playlist = document.playlists.find((candidate) => candidate.id === id);
  if (playlist === undefined) return document.playlists;

  const existing = new Set(playlist.items.map((item) => item.contentKey));
  let changed = false;
  for (const key of keys) {
    if (existing.has(key)) continue;
    existing.add(key);
    playlist.items.push({
      contentKey: key,
      addedAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) {
    playlist.updatedAt = nextUpdatedAt(playlist.updatedAt);
    write(document);
  }
  return document.playlists;
}

function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous);
  const nowMs = Date.now();
  if (Number.isFinite(previousMs) && nowMs <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return new Date(nowMs).toISOString();
}

function readDocument(storage: Storage | null): PlaylistDocument {
  if (storage === null) return emptyDocument();
  try {
    return normalizeDocument(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return emptyDocument();
  }
}

function normalizeDocument(data: unknown): PlaylistDocument {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.playlists)) {
    return emptyDocument();
  }
  const seen = new Set<string>();
  const playlists: PlaylistRecord[] = [];
  for (const raw of data.playlists) {
    const playlist = normalizePlaylist(raw);
    if (playlist === null || seen.has(playlist.id)) continue;
    seen.add(playlist.id);
    playlists.push(playlist);
  }
  return { version: 1, playlists };
}

function normalizePlaylist(raw: unknown): PlaylistRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  if (typeof raw.createdAt !== 'string') return null;
  if (typeof raw.updatedAt !== 'string') return null;
  if (!Array.isArray(raw.items)) return null;
  const seen = new Set<string>();
  const items: PlaylistItemRef[] = [];
  for (const item of raw.items) {
    const normalized = normalizeItem(item);
    if (normalized === null || seen.has(normalized.contentKey)) continue;
    seen.add(normalized.contentKey);
    items.push(normalized);
  }
  return {
    id: raw.id,
    name: raw.name.trim(),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    items,
  };
}

function normalizeItem(raw: unknown): PlaylistItemRef | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.contentKey !== 'string' || raw.contentKey.trim() === '') {
    return null;
  }
  if (typeof raw.addedAt !== 'string') return null;
  return {
    contentKey: raw.contentKey.trim(),
    addedAt: raw.addedAt,
  };
}

function createId(): string {
  return `playlist-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function emptyDocument(): PlaylistDocument {
  return { version: 1, playlists: [] };
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
