import { createPortal } from 'react-dom';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';

import type {
  LibraryFetchResult,
  LibraryItem,
  LibraryMediaType,
} from '../../core/api/libraryClient';
import { contentKeyForLibraryItem } from '../../core/media/contentIdentity';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';
import { CloseGlyph, SortGlyph } from '../../core/ui/AppIcons';
import { useSearchHost } from '../../app/SearchHostContext';
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
  const searchHost = useSearchHost();

  // Auto-load on first mount of each type. Switching between music and video
  // does not re-fetch; the settings screen refresh invalidates stale stores.
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
      <header className="mb-4 flex items-center justify-end gap-4">
        {searchHost === null && (
          <div className="mr-auto min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {meta.title}
            </h1>
          </div>
        )}
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
      {searchHost === null ? (
        <StandaloneLibrarySearch
          title={meta.title}
          query={query}
          onQueryChange={setQuery}
        />
      ) : (
        createPortal(
          <LibrarySearchControl
            title={meta.title}
            query={query}
            onQueryChange={setQuery}
          />,
          searchHost,
        )
      )}

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

function LibrarySearchControl({
  onQueryChange,
  query,
  title,
}: {
  onQueryChange: (query: string) => void;
  query: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={controlRef} className="flex items-center">
      <button
        ref={buttonRef}
        type="button"
        data-testid="search-toggle"
        aria-label={`Search ${title}`}
        aria-expanded={open}
        aria-pressed={query.trim() !== ''}
        data-active={query.trim() !== '' ? 'true' : 'false'}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground transition hover:bg-foreground/10 aria-pressed:text-accent"
        onClick={() => setOpen((current) => !current)}
      >
        <MagnifyingGlass aria-hidden className="h-6 w-6" weight="regular" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${title} search`}
          data-testid="search-popover"
          className="muzio-search absolute left-1/2 top-[calc(100%+0.75rem)] z-40 flex h-[58px] w-[calc(100%+6rem)] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 px-5"
        >
          <MagnifyingGlass aria-hidden className="h-5 w-5 shrink-0 text-muted" weight="regular" />
          <input
            ref={inputRef}
            aria-label={`Filter ${title}`}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="검색"
            className="min-w-0 flex-1 bg-transparent px-1 py-2 text-base outline-none placeholder:text-muted focus:text-zinc-950 dark:focus:text-foreground"
          />
          {query !== '' && (
            <button
              type="button"
              aria-label={`Clear filter ${title}`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg text-muted hover:bg-zinc-200/70 dark:hover:bg-white/10"
              onClick={() => {
                onQueryChange('');
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StandaloneLibrarySearch({
  onQueryChange,
  query,
  title,
}: {
  onQueryChange: (query: string) => void;
  query: string;
  title: string;
}) {
  return (
    <div className="muzio-search mb-6 border-b border-zinc-300/80 pb-2 dark:border-white/20">
      <label className="sr-only" htmlFor={`standalone-filter-${title}`}>
        Filter {title}
      </label>
      <input
        id={`standalone-filter-${title}`}
        aria-label={`Filter ${title}`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Filter"
        className="min-w-0 w-full bg-transparent px-0 py-2.5 text-base outline-none placeholder:text-muted focus:text-zinc-950 dark:focus:text-foreground"
      />
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
        className="muzio-dialog w-full max-w-sm rounded-2xl border border-white/14 bg-[#111113]/94 p-4 text-white shadow-2xl shadow-black/60 backdrop-blur-[76px]"
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
