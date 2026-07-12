import type { LibraryItem, LibraryMediaType } from '../../core/api/libraryClient';

export type LibrarySortKey =
  | 'latest'
  | 'name';

export interface LibraryViewOptions {
  query: string;
  sortKey: LibrarySortKey;
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
  return [...filtered].sort(byTitle);
}

function byTitle(a: LibraryItem, b: LibraryItem): number {
  return titleCollator.compare(titleFor(a), titleFor(b));
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
