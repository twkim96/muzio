import type { LibraryMediaType } from '../../core/api/libraryClient';
import {
  EMPTY_LIBRARY_FILTERS,
  type LibraryFilters,
  type LibrarySortDirection,
  type LibrarySortKey,
} from './libraryView';

export interface LibraryViewPreferences {
  query: string;
  filters: LibraryFilters;
  sortKey: LibrarySortKey;
  sortDirection: LibrarySortDirection;
}

export interface LibraryViewPreferencesRepository {
  read(type: LibraryMediaType): LibraryViewPreferences;
  write(type: LibraryMediaType, preferences: LibraryViewPreferences): void;
}

const STORAGE_KEY = 'music.library-view-preferences.v1';
const SORT_KEYS: readonly LibrarySortKey[] = [
  'latest',
  'name',
  'artist',
  'size',
  'modified',
  'library',
];
const DEFAULT_PREFERENCES: LibraryViewPreferences = {
  query: '',
  filters: EMPTY_LIBRARY_FILTERS,
  sortKey: 'latest',
  sortDirection: 'desc',
};

/** Best-effort local persistence for the library's reload-safe view state. */
export function createLocalStorageLibraryViewPreferencesRepository(
  storage?: Storage,
): LibraryViewPreferencesRepository {
  const targetStorage = storage ?? defaultLocalStorage();
  return {
    read(type) {
      const document = readDocument(targetStorage);
      return normalizePreferences(document[type]);
    },
    write(type, preferences) {
      if (targetStorage === null) return;
      try {
        const document = readDocument(targetStorage);
        document[type] = normalizePreferences(preferences);
        targetStorage.setItem(STORAGE_KEY, JSON.stringify({ ...document, version: 1 }));
      } catch {
        // A disabled or full browser storage must not block library browsing.
      }
    },
  };
}

function readDocument(storage: Storage | null): Partial<Record<LibraryMediaType, unknown>> {
  if (storage === null) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Partial<Record<LibraryMediaType, unknown>>;
  } catch {
    return {};
  }
}

function normalizePreferences(value: unknown): LibraryViewPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return cloneDefaults();
  }
  const input = value as Record<string, unknown>;
  const sortKey = SORT_KEYS.includes(input.sortKey as LibrarySortKey)
    ? input.sortKey as LibrarySortKey
    : DEFAULT_PREFERENCES.sortKey;
  return {
    query: typeof input.query === 'string' ? input.query : DEFAULT_PREFERENCES.query,
    filters: normalizeFilters(input.filters),
    sortKey,
    sortDirection: input.sortDirection === 'asc' || input.sortDirection === 'desc'
      ? input.sortDirection
      : DEFAULT_PREFERENCES.sortDirection,
  };
}

function normalizeFilters(value: unknown): LibraryFilters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return cloneFilters(EMPTY_LIBRARY_FILTERS);
  }
  const input = value as Record<string, unknown>;
  return {
    storageIds: normalizeStrings(input.storageIds),
    locations: normalizeLocations(input.locations),
    artists: normalizeStrings(input.artists),
  };
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== ''))];
}

function normalizeLocations(value: unknown): Array<'local' | 'network'> {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is 'local' | 'network' => entry === 'local' || entry === 'network'))];
}

function cloneDefaults(): LibraryViewPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    filters: cloneFilters(DEFAULT_PREFERENCES.filters),
  };
}

function cloneFilters(filters: LibraryFilters): LibraryFilters {
  return {
    storageIds: [...filters.storageIds],
    locations: [...filters.locations],
    artists: [...filters.artists],
  };
}

function defaultLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
