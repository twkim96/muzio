import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import type {
  LibraryFetchResult,
  LibraryItem,
  LibraryMediaType,
} from '../../core/api/libraryClient';
import { contentKeyForLibraryItem } from '../../core/media/contentIdentity';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';
import { CloseGlyph, SortGlyph } from '../../core/ui/AppIcons';
import { usePlaylists } from '../playlists/PlaylistContext';
import { useLibraryStores } from './LibraryContext';
import { VirtualizedLibraryList } from './VirtualizedLibraryList';
import type { LibraryStatus } from './libraryStore';
import { describeLibraryError } from './libraryMessage';
import {
  filterAndSortLibraryItems,
  type LibrarySortKey,
} from './libraryView';

const labels: Record<LibraryMediaType, { title: string; emptyHint: string }> = {
  audio: {
    title: 'Music',
    emptyHint:
      'No audio yet. Configure the server media roots and refresh.',
  },
  video: {
    title: 'Video',
    emptyHint:
      'No video yet. Configure the server media roots and refresh.',
  },
  image: {
    title: 'Image',
    emptyHint:
      'No images yet. Configure the server media roots and refresh.',
  },
};

export function LibraryScreen({ type }: { type: LibraryMediaType }) {
  const stores = useLibraryStores();
  const useStore =
    type === 'audio' ? stores.audio : type === 'video' ? stores.video : stores.image;
  const status = useStore((state) => state.status);
  const result = useStore((state) => state.result);
  const stale = useStore((state) => state.stale);
  const load = useStore((state) => state.load);
  const playlists = usePlaylists();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [sortKey, setSortKey] = useState<LibrarySortKey>('latest');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [addModalItems, setAddModalItems] = useState<LibraryItem[] | null>(null);
  const [addTargetPlaylistId, setAddTargetPlaylistId] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');

  // Auto-load on first mount of each type. Switching between music and video
  // does not re-fetch; the shared menu refresh explicitly reloads the stores.
  useEffect(() => {
    if (status === 'idle') {
      void load();
      return;
    }
    if (status === 'ok' && stale && result?.kind === 'ok') {
      void load({ preserveResult: true });
    }
  }, [load, result, stale, status]);

  const meta = labels[type];
  const sortLabel = sortKey === 'latest' ? 'Newest first' : 'Name order';
  const rawItems = result?.kind === 'ok' ? result.items : [];
  const visibleItems = useMemo(
    () =>
      filterAndSortLibraryItems(rawItems, type, {
        query: deferredQuery,
        sortKey,
      }),
    [deferredQuery, rawItems, sortKey, type],
  );
  const selectedItems = useMemo(
    () => rawItems.filter((item) => selectedIds.has(item.id)),
    [rawItems, selectedIds],
  );
  const toggleSort = () => {
    setSortKey((current) => (current === 'latest' ? 'name' : 'latest'));
  };
  const clearSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  const toggleSelected = useCallback((item: LibraryItem) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      if (next.size === 0) {
        setSelectionMode(false);
      }
      return next;
    });
  }, []);
  const enterSelection = useCallback(
    (item: LibraryItem) => {
      if (type === 'image') return;
      setSelectionMode(true);
      setSelectedIds(new Set([item.id]));
    },
    [type],
  );
  const openAddModal = useCallback(
    (items: LibraryItem[]) => {
      if (items.length === 0) return;
      setAddModalItems(items);
      setAddTargetPlaylistId(playlists.playlists[0]?.id ?? '');
    },
    [playlists],
  );
  const confirmAddToPlaylist = () => {
    const items = addModalItems ?? [];
    if (items.length === 0) return;
    const keys = items.map(contentKeyForLibraryItem);
    let targetId = addTargetPlaylistId;
    if (targetId === '' && newPlaylistName.trim() !== '') {
      const next = playlists.createPlaylist(newPlaylistName);
      targetId = next.at(-1)?.id ?? '';
    }
    if (targetId === '') return;
    playlists.addItems(targetId, keys);
    setAddModalItems(null);
    setNewPlaylistName('');
    clearSelection();
  };

  return (
    <div className="w-full px-4 py-7 sm:px-8 lg:px-10">
      <header className="mb-7 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-5xl font-semibold tracking-tight sm:text-6xl">
            {meta.title}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selectionMode && type !== 'image' && (
            <>
              <button
                type="button"
                data-testid="selection-add-to-playlist"
                className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300/80 bg-white/65 px-4 text-sm font-semibold shadow-sm backdrop-blur-xl hover:bg-zinc-200/70 dark:border-white/10 dark:bg-white/[0.07] dark:hover:bg-white/10"
                onClick={() => openAddModal(selectedItems)}
              >
                Add to Playlist
              </button>
              <button
                type="button"
                aria-label="Clear selection"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300/80 bg-white/65 text-lg font-semibold shadow-sm backdrop-blur-xl hover:bg-zinc-200/70 dark:border-white/10 dark:bg-white/[0.07] dark:hover:bg-white/10"
                onClick={clearSelection}
              >
                <CloseGlyph className="h-5 w-5" />
              </button>
            </>
          )}
          <button
            type="button"
            data-testid="sort-toggle"
            aria-label={`Sort ${meta.title}: ${sortLabel}`}
            title={sortLabel}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300/80 bg-white/65 text-lg font-semibold shadow-sm backdrop-blur-xl hover:bg-zinc-200/70 dark:border-white/10 dark:bg-white/[0.07] dark:hover:bg-white/10"
            onClick={toggleSort}
          >
            <SortGlyph className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="mb-6 border-b border-zinc-300/80 pb-2 dark:border-white/20">
        <input
          aria-label={`Filter ${meta.title}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter"
          className="min-w-0 flex-1 bg-transparent px-0 py-2.5 text-base outline-none placeholder:text-muted focus:text-zinc-950 dark:focus:text-foreground"
        />
      </div>

      <LibraryBody
        type={type}
        status={status}
        result={result}
        emptyHint={meta.emptyHint}
        visibleItems={visibleItems}
        onLongPressItem={enterSelection}
        onOpenAddToPlaylist={openAddModal}
        onToggleSelected={toggleSelected}
        selectedIds={selectedIds}
        selectionMode={selectionMode}
      />
      {addModalItems !== null && (
        <AddToPlaylistModal
          itemCount={addModalItems.length}
          newPlaylistName={newPlaylistName}
          onClose={() => setAddModalItems(null)}
          onConfirm={confirmAddToPlaylist}
          onNewPlaylistName={setNewPlaylistName}
          onTargetPlaylist={setAddTargetPlaylistId}
          playlists={playlists.playlists}
          targetPlaylistId={addTargetPlaylistId}
        />
      )}
    </div>
  );
}

function LibraryBody({
  type,
  status,
  result,
  emptyHint,
  visibleItems,
  onLongPressItem,
  onOpenAddToPlaylist,
  onToggleSelected,
  selectedIds,
  selectionMode,
}: {
  type: LibraryMediaType;
  status: LibraryStatus;
  result: LibraryFetchResult | null;
  emptyHint: string;
  visibleItems: readonly LibraryItem[];
  onLongPressItem: (item: LibraryItem) => void;
  onOpenAddToPlaylist: (items: LibraryItem[]) => void;
  onToggleSelected: (item: LibraryItem) => void;
  selectedIds: Set<string>;
  selectionMode: boolean;
}) {
  const rawItems =
    result?.kind === 'ok'
      ? result.items
      : [];

  if (status === 'loading' && rawItems.length === 0) {
    return (
      <p data-testid="library-loading" className="text-sm text-muted">
        Loading library…
      </p>
    );
  }

  if (
    status === 'error' &&
    result !== null &&
    result.kind !== 'ok'
  ) {
    return (
      <p
        data-testid="library-error"
        className="text-sm text-red-600 dark:text-red-400"
      >
        {describeLibraryError(result)}
      </p>
    );
  }

  if (result?.kind === 'ok') {
    if (visibleItems.length === 0) {
      return (
        <p data-testid="library-empty" className="text-sm text-muted">
          {result.items.length === 0 ? emptyHint : 'No matches.'}
        </p>
      );
    }
    return (
      <>
        <div className="border-y border-zinc-200/70 dark:border-white/10">
          <div
            aria-hidden
            className={
              type !== 'audio'
                ? 'hidden'
                : 'hidden h-[54px] grid-cols-[minmax(16rem,1.35fr)_minmax(8rem,0.72fr)_6rem_7.5rem_minmax(6rem,0.6fr)_6.75rem] items-center gap-4 border-b border-zinc-200/70 px-5 text-sm font-medium text-muted dark:border-white/10 xl:grid'
            }
          >
            <span>Song</span>
            <span>Artist</span>
            <span className="text-right">Size</span>
            <span className="text-right">Modified</span>
            <span>Library</span>
            <span className="sr-only">Actions</span>
          </div>
          <VirtualizedLibraryList
            items={visibleItems}
            onLongPressItem={onLongPressItem}
            onOpenAddToPlaylist={onOpenAddToPlaylist}
            onToggleSelected={onToggleSelected}
            selectedIds={selectedIds}
            selectionMode={selectionMode}
          />
        </div>
      </>
    );
  }

  return null;
}

function AddToPlaylistModal({
  itemCount,
  newPlaylistName,
  onClose,
  onConfirm,
  onNewPlaylistName,
  onTargetPlaylist,
  playlists,
  targetPlaylistId,
}: {
  itemCount: number;
  newPlaylistName: string;
  onClose: () => void;
  onConfirm: () => void;
  onNewPlaylistName: (name: string) => void;
  onTargetPlaylist: (playlistId: string) => void;
  playlists: PlaylistRecord[];
  targetPlaylistId: string;
}) {
  return (
    <div
      data-testid="add-to-playlist-modal"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <section
        data-glass
        className="w-full max-w-sm rounded-2xl border border-white/14 bg-[#111113]/94 p-4 text-white shadow-2xl shadow-black/60 backdrop-blur-[76px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add to Playlist</h2>
          <button
            type="button"
            aria-label="Close add to playlist"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-2xl text-white/70 hover:bg-white/10"
            onClick={onClose}
          >
            <CloseGlyph className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-3 text-sm text-white/60">{itemCount} selected</p>
        {playlists.length > 0 ? (
          <select
            data-testid="add-playlist-select"
            aria-label="Playlist"
            value={targetPlaylistId}
            onChange={(event) => onTargetPlaylist(event.target.value)}
            className="mb-3 w-full rounded-full border border-white/15 bg-[#111113] px-4 py-2 text-sm"
          >
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            data-testid="add-playlist-create-name"
            aria-label="New playlist name"
            value={newPlaylistName}
            onChange={(event) => onNewPlaylistName(event.target.value)}
            className="mb-3 w-full rounded-full border border-white/15 bg-transparent px-4 py-2 text-sm outline-none"
          />
        )}
        <button
          type="button"
          data-testid="add-playlist-confirm"
          className="inline-flex h-10 w-full items-center justify-center rounded-full bg-white px-4 text-sm font-semibold text-zinc-950 hover:bg-white/85"
          onClick={onConfirm}
        >
          Confirm
        </button>
      </section>
    </div>
  );
}
