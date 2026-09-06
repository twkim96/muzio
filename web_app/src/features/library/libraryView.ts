import type { LibraryItem, LibraryMediaType } from '../../core/api/libraryClient';

export type LibrarySortKey =
  | 'latest'
  | 'name'
  | 'artist'
  | 'size'
  | 'modified'
  | 'library';

export type LibrarySortDirection = 'asc' | 'desc';

export interface LibraryViewOptions {
  query: string;
  sortKey: LibrarySortKey;
  sortDirection?: LibrarySortDirection;
  filters?: LibraryFilters;
}

export interface LibraryFilters {
  storageIds: readonly string[];
  locations: readonly ('local' | 'network')[];
  artists: readonly string[];
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = { storageIds: [], locations: [], artists: [] };
export interface LibraryFacet { id: string; label: string; count: number }
export function libraryStorageId(item: LibraryItem): string {
  return item.location === 'local' ? `local:${item.storageId ?? item.rootName}` : `network:${item.rootName}`;
}

export function libraryFacets(items: readonly LibraryItem[]) {
  const storage = new Map<string, LibraryFacet>();
  const artists = new Map<string, LibraryFacet>();
  const locations = { local: 0, network: 0 };
  const add = (map: Map<string, LibraryFacet>, id: string, label: string) => {
    const entry = map.get(id);
    if (entry) entry.count++;
    else map.set(id, { id, label, count: 1 });
  };
  for (const item of items) {
    add(storage, libraryStorageId(item), item.rootName);
    locations[item.location ?? 'network']++;
    const artist = item.metadata?.artist?.trim();
    if (artist) add(artists, normalize(artist), artist);
  }
  return {
    storage: [...storage.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    artists: [...artists.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    locations,
  };
}

/** Quoted tags or longest known artist names; remaining text stays a normal search. */
export function parseLibraryQuery(query: string, knownArtists: readonly LibraryFacet[] = []) {
  const known = [...knownArtists].sort((a, b) => b.label.length - a.label.length);
  const artists: string[] = [];
  const text = query.replace(/(?<!\S)#(?:"([^"\n]+)"|'([^'\n]+)'|([^#\n]+))/g, (match, double: string, single: string, rest: string) => {
    if (double || single) {
      artists.push(normalize(double || single));
      return '';
    }
    const candidate = known.find((artist) => normalize(rest).startsWith(artist.id) && (rest.length === artist.label.length || /\s/.test(rest[artist.label.length] ?? '')));
    const label = candidate?.label ?? rest.match(/^\S+/)?.[0] ?? '';
    if (!label) return match;
    artists.push(candidate?.id ?? normalize(label));
    return rest.slice(label.length);
  }).replace(/\s+/g, ' ').trim();
  return { text, artists: [...new Set(artists)] };
}

export function libraryQueryWithArtists(text: string, artists: readonly string[], known: readonly LibraryFacet[]) {
  return [text, ...artists.map((id) => {
    const label = known.find((artist) => artist.id === id)?.label ?? id;
    return `#"${label.replace(/"/g, '')}"`;
  })].filter(Boolean).join(' ');
}

const searchTextCache = new WeakMap<LibraryItem, string>();
const titleCache = new WeakMap<LibraryItem, string>();
const titleCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function filterAndSortLibraryItems(
  items: readonly LibraryItem[],
  _type: LibraryMediaType,
  options: LibraryViewOptions,
): readonly LibraryItem[] {
  const parsed = options.query.includes('#') ? parseLibraryQuery(options.query, libraryFacets(items).artists) : { text: options.query, artists: [] };
  const query = normalize(parsed.text);
  const filters = options.filters ?? EMPTY_LIBRARY_FILTERS;
  const artists = [...new Set([...filters.artists.map(normalize), ...parsed.artists])];
  const hasFilters = query !== '' || artists.length > 0 || filters.storageIds.length > 0 || filters.locations.length > 0;
  const filtered = hasFilters ? items.filter((item) =>
    (query === '' || searchText(item).includes(query)) &&
    (artists.length === 0 || artists.includes(normalize(item.metadata?.artist))) &&
    (filters.storageIds.length === 0 || filters.storageIds.includes(libraryStorageId(item))) &&
    (filters.locations.length === 0 || filters.locations.includes(item.location ?? 'network')),
  ) : items;
  if (options.sortKey === 'latest') {
    return filtered;
  }
  const direction = options.sortDirection === 'desc' ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const left = sortValue(a, options.sortKey);
    const right = sortValue(b, options.sortKey);
    if (left === undefined && right !== undefined) return 1;
    if (right === undefined && left !== undefined) return -1;
    const comparison = left === undefined || right === undefined
      ? 0
      : typeof left === 'number' && typeof right === 'number'
        ? left - right
        : titleCollator.compare(String(left), String(right));
    return comparison * direction || byTitle(a, b) || a.id.localeCompare(b.id);
  });
}

function sortValue(item: LibraryItem, key: LibrarySortKey): string | number | undefined {
  if (key === 'size') {
    return typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0
      ? item.sizeBytes
      : undefined;
  }
  if (key === 'modified') {
    const timestamp = typeof item.modifiedAt === 'string' ? Date.parse(item.modifiedAt) : NaN;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  const value = key === 'artist' ? item.metadata?.artist : key === 'library' ? item.rootName : titleFor(item);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function byTitle(a: LibraryItem, b: LibraryItem): number {
  return titleCollator.compare(titleFor(a) ?? '', titleFor(b) ?? '');
}

function searchText(item: LibraryItem): string {
  const cached = searchTextCache.get(item);
  if (cached !== undefined) return cached;
  const value = normalize(
    [
      item.name,
      item.relativePath,
      item.rootName,
      item.metadata?.title,
      item.metadata?.artist,
      item.metadata?.album,
      item.metadata?.year,
      item.metadata?.season,
      item.metadata?.episode,
      ...(item.subtitles ?? []).map((subtitle) => subtitle.label),
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(' '),
  );
  searchTextCache.set(item, value);
  return value;
}

function titleFor(item: LibraryItem): string {
  const cached = titleCache.get(item);
  if (cached !== undefined) return cached;
  const value = item.metadata?.title ?? item.name;
  titleCache.set(item, value);
  return value;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim();
}
