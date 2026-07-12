import type { LibraryItem } from '../../core/api/libraryClient';
import { contentIdentityForLibraryItem } from '../../core/media/contentIdentity';
import type { PlaybackActivityRecord } from '../../core/storage/playbackActivityRepository';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';

export interface SmartCollection {
  id: string;
  title: string;
  items: LibraryItem[];
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
        const identity = contentIdentityForLibraryItem(item);
        return liked.has(identity.key) || liked.has(item.id);
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
          .sort(comparePlayCount)
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
    const key = contentIdentityForLibraryItem(item).key;
    if (!map.has(key)) map.set(key, item);
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
