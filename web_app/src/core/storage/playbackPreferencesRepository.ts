export type StoredRepeatMode = 'none' | 'all' | 'one';

export interface PlaybackPreferences {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeatMode: StoredRepeatMode;
}

export interface PlaybackPreferencesRepository {
  read(): PlaybackPreferences;
  write(preferences: PlaybackPreferences): void;
}

const STORAGE_KEY = 'music.playback-preferences.v1';
const DEFAULTS: PlaybackPreferences = {
  volume: 1,
  muted: false,
  shuffle: false,
  repeatMode: 'none',
};

export function createLocalStoragePlaybackPreferencesRepository(
  storage?: Storage,
): PlaybackPreferencesRepository {
  const target = storage ?? defaultLocalStorage();
  return {
    read() {
      if (target === null) return { ...DEFAULTS };
      try {
        return normalize(JSON.parse(target.getItem(STORAGE_KEY) ?? 'null'));
      } catch {
        return { ...DEFAULTS };
      }
    },
    write(preferences) {
      if (target === null) return;
      try {
        target.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...normalize(preferences) }));
      } catch {
        // Playback remains usable when storage is unavailable or full.
      }
    },
  };
}

function normalize(value: unknown): PlaybackPreferences {
  if (typeof value !== 'object' || value === null) return { ...DEFAULTS };
  const input = value as Record<string, unknown>;
  const volume = typeof input.volume === 'number' && Number.isFinite(input.volume)
    ? Math.min(1, Math.max(0, input.volume))
    : DEFAULTS.volume;
  const repeatMode = input.repeatMode === 'all' || input.repeatMode === 'one'
    ? input.repeatMode
    : 'none';
  return {
    volume,
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULTS.muted,
    shuffle: typeof input.shuffle === 'boolean' ? input.shuffle : DEFAULTS.shuffle,
    repeatMode,
  };
}

function defaultLocalStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
