import type { LibraryItem } from '../../core/api/libraryClient';
import { contentKeysForLibraryItem } from '../../core/media/contentIdentity';
import type { PlaybackActivityRecord } from '../../core/storage/playbackActivityRepository';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';

export interface SmartCollection {
  id: string;
  title: string;
  items: LibraryItem[];
}

const IMAGE_COLLECTION_LIMIT = 100;

export function buildImageCollections({
  items,
  likedKeys,
}: {
  items: readonly LibraryItem[];
  likedKeys: readonly string[];
}): SmartCollection[] {
  const images = items.filter((item) => item.type === 'image');
  const liked = new Set(likedKeys);
  const newest = [...images].sort((a, b) =>
    b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id),
  );
  return [
    {
      id: 'image-favorites',
      title: 'Favorites',
      items: images.filter((item) => {
        return contentKeysForLibraryItem(item).some((key) => liked.has(key)) || liked.has(item.id);
      }).slice(0, IMAGE_COLLECTION_LIMIT),
    },
    {
      id: 'image-recently-added',
      title: 'Recently Added',
      items: newest.slice(0, IMAGE_COLLECTION_LIMIT),
    },
    {
      id: 'image-screenshots',
      title: 'Screenshots',
      items: images.filter(isScreenshot).slice(0, IMAGE_COLLECTION_LIMIT),
    },
    {
      id: 'image-downloads',
      title: 'Downloads',
      items: images.filter((item) => pathTokens(item.rootName).some(isDownloadsRootToken)).slice(0, IMAGE_COLLECTION_LIMIT),
    },
  ];
}

function isDownloadsRootToken(value: string): boolean {
  return value === 'downloads' || value.startsWith('downloads-');
}

function isScreenshot(item: LibraryItem): boolean {
  const segments = pathTokens(`${item.rootName}/${item.relativePath}`);
  if (segments.includes('screenshots')) return true;
  const filename = item.name.normalize('NFKC').toLocaleLowerCase();
  return /^(screen ?shot|screenshot|스크린샷|화면 ?캡처)[ _-]/u.test(filename);
}

function pathTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolvePlaylistItems(
  playlist: PlaylistRecord,
  items: readonly LibraryItem[],
): LibraryItem[] {
  return resolvePlaylistItemsFromIndex(
    playlist,
    mapItemsByContentKey(items),
  );
}

export function resolvePlaylistItemsFromIndex(
  playlist: PlaylistRecord,
  byKey: ReadonlyMap<string, LibraryItem>,
): LibraryItem[] {
  return playlist.items
    .map((ref) => byKey.get(ref.contentKey))
    .filter((item): item is LibraryItem => item !== undefined);
}

export function buildSmartCollections({
  items,
  likedKeys,
  activityRecords,
  itemIndex,
}: {
  items: readonly LibraryItem[];
  likedKeys: readonly string[];
  activityRecords: readonly PlaybackActivityRecord[];
  itemIndex?: ReadonlyMap<string, LibraryItem>;
}): SmartCollection[] {
  const byKey = itemIndex ?? mapItemsByContentKey(items);
  const liked = new Set(likedKeys);

  return [
    {
      id: 'liked-music',
      title: 'Liked Music',
      items: items.filter((item) => {
        if (item.type !== 'audio') return false;
        return contentKeysForLibraryItem(item).some((key) => liked.has(key)) || liked.has(item.id);
      }),
    },
    {
      id: 'most-played',
      title: 'Most Played',
      items: recordsToItems(
        [...activityRecords]
          .filter((record) => record.mediaType === 'audio' && record.playCount > 0)
          .sort(comparePlayCount)
          .slice(0, 50),
        byKey,
      ),
    },
    {
      id: 'recently-watching',
      title: 'Recently Watching',
      items: recordsToItems(
        [...activityRecords]
          .filter((record) => record.mediaType === 'video' && record.playCount > 0)
          .sort(compareRecentlyPlayed)
          .slice(0, 50),
        byKey,
      ),
    },
  ];
}

export function mapItemsByContentKey(
  items: readonly LibraryItem[],
): Map<string, LibraryItem> {
  const map = new Map<string, LibraryItem>();
  for (const item of items) {
    for (const key of contentKeysForLibraryItem(item)) {
      if (!map.has(key)) map.set(key, item);
    }
  }
  return map;
}

function recordsToItems(
  records: readonly PlaybackActivityRecord[],
  byKey: ReadonlyMap<string, LibraryItem>,
): LibraryItem[] {
  return records
    .map((record) => byKey.get(record.contentKey))
    .filter((item): item is LibraryItem => item !== undefined);
}

function comparePlayCount(
  a: PlaybackActivityRecord,
  b: PlaybackActivityRecord,
): number {
  if (a.playCount !== b.playCount) return b.playCount - a.playCount;
  return String(b.lastPlayedAt ?? '').localeCompare(String(a.lastPlayedAt ?? ''));
}

function compareRecentlyPlayed(
  a: PlaybackActivityRecord,
  b: PlaybackActivityRecord,
): number {
  const lastPlayed = String(b.lastPlayedAt ?? '').localeCompare(
    String(a.lastPlayedAt ?? ''),
  );
  if (lastPlayed !== 0) return lastPlayed;
  if (a.playCount !== b.playCount) return b.playCount - a.playCount;
  return a.contentKey.localeCompare(b.contentKey);
}
