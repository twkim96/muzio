import { musicSync } from './musicSync';

/**
 * Best-effort local persistence for liked music tracks.
 *
 * The repository stores opaque strings. Phase 10 wrote backend media ids;
 * Phase 11 writes content identity keys while still reading the older ids so
 * existing hearts keep working during the local-DB migration.
 */
export interface LikedTracksRepository {
  list(): string[];
  write(ids: readonly string[]): void;
  set?(id: string, liked: boolean): void;
}

const STORAGE_KEY = 'music.likes.v1';

function normalizeIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function defaultLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createLocalStorageLikedTracksRepository(
  storage?: Storage,
): LikedTracksRepository {
  const targetStorage = storage ?? defaultLocalStorage();
  return {
    list() {
      if (targetStorage === null) return [];
      try {
        const raw = targetStorage.getItem(STORAGE_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return normalizeIds(
          parsed.filter((id): id is string => typeof id === 'string'),
        );
      } catch {
        return [];
      }
    },
    set(id, liked) {
      const keys = new Set(this.list());
      if (liked) keys.add(id); else keys.delete(id);
      this.write([...keys]);
    },
    write(ids) {
      if (targetStorage === null) return;
      try {
        const next = normalizeIds(ids);
        musicSync()?.recordLikes(this.list(), next);
        targetStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Likes are local convenience state; disabled/quota storage should not
        // block playback.
      }
    },
  };
}
