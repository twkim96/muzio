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
  const query = normalize(options.query);
  const filtered =
    query === ''
      ? items
      : items.filter((item) => searchText(item).includes(query));
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
