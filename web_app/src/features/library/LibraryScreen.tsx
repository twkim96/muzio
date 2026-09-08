import { Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { createPortal } from 'react-dom';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { FloatingSearchControl } from '../../app/FloatingSearchControl';

import type {
  LibraryFetchResult,
  LibraryItem,
  LibraryMediaType,
} from '../../core/api/libraryClient';
import { contentKeyForLibraryItem } from '../../core/media/contentIdentity';
import type { PlaylistRecord } from '../../core/storage/playlistRepository';
import { GlassModal } from '../../core/ui/GlassModal';
import { FunnelSimple } from '@phosphor-icons/react/dist/csr/FunnelSimple';
import { LibraryFilterPanel } from './LibraryFilterPanel';
import { LibrarySearchPreview } from './LibrarySearchPreview';
import { useFilterHost, useSearchHost } from '../../app/SearchHostContext';
import { usePlaylists } from '../playlists/PlaylistContext';
import { useLibraryStores } from './LibraryContext';
import { VirtualizedLibraryList } from './VirtualizedLibraryList';
import type { LibraryStatus } from './libraryStore';
import { describeLibraryError } from './libraryMessage';
import {
  createLocalStorageLibraryViewPreferencesRepository,
  type LibraryViewPreferences,
} from './libraryViewPreferencesRepository';
import {
  EMPTY_LIBRARY_FILTERS, libraryFacets, libraryQueryWithArtists, parseLibraryQuery,
  type LibraryFilters,
  filterAndSortLibraryItems,
  type LibrarySortKey,
  type LibrarySortDirection,
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

type LibrarySortSelection = { key: LibrarySortKey; direction: LibrarySortDirection };

export function LibraryScreen({ type }: { type: LibraryMediaType }) {
  const stores = useLibraryStores();
  const useStore =
    type === 'audio' ? stores.audio : type === 'video' ? stores.video : stores.image;
  const status = useStore((state) => state.status);
  const result = useStore((state) => state.result);
  const stale = useStore((state) => state.stale);
  const load = useStore((state) => state.load);
  const playlists = usePlaylists();
  const filterHost = useFilterHost();
  const [filterOpen, setFilterOpen] = useState(false);
  const preferencesRepository = useMemo(() => createLocalStorageLibraryViewPreferencesRepository(), []);
  const [viewPreferences, setViewPreferences] = useState<Record<LibraryMediaType, LibraryViewPreferences>>(
    () => ({
      audio: preferencesRepository.read('audio'),
      video: preferencesRepository.read('video'),
      image: preferencesRepository.read('image'),
    }),
  );
  const currentPreferences = viewPreferences[type];
  const { filters, query, sortKey, sortDirection } = currentPreferences;
  const updateCurrentPreferences = useCallback(
    (update: (current: LibraryViewPreferences) => LibraryViewPreferences) => {
      setViewPreferences((current) => ({
        ...current,
        [type]: update(current[type]),
      }));
    },
    [type],
  );
  const setFilters = useCallback(
    (next: LibraryFilters | ((current: LibraryFilters) => LibraryFilters)) => {
      updateCurrentPreferences((current) => ({
        ...current,
        filters: typeof next === 'function' ? next(current.filters) : next,
      }));
    },
    [updateCurrentPreferences],
  );
  const setQuery = useCallback(
    (next: string) => updateCurrentPreferences((current) => ({ ...current, query: next })),
    [updateCurrentPreferences],
  );
  const setSort = useCallback(
    (next: LibrarySortSelection | ((current: LibrarySortSelection) => LibrarySortSelection)) => {
      updateCurrentPreferences((current) => {
        if (typeof next === 'function') {
          const updated = next({ key: current.sortKey, direction: current.sortDirection });
          return { ...current, sortKey: updated.key, sortDirection: updated.direction };
        }
        return { ...current, sortKey: next.key, sortDirection: next.direction };
      });
    },
    [updateCurrentPreferences],
  );
  useEffect(() => {
    preferencesRepository.write(type, currentPreferences);
  }, [currentPreferences, preferencesRepository, type]);
  const deferredQuery = useDeferredValue(query);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectionMode = selectedIds.size > 0;
  const selectionAnchorId = [...selectedIds].at(-1);
  const [addModalItems, setAddModalItems] = useState<LibraryItem[] | null>(null);
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
  const rawItems = result?.kind === 'ok' ? result.items : [];
  const facets = useMemo(() => libraryFacets(rawItems), [rawItems]);
  const parsedQuery = useMemo(() => parseLibraryQuery(query, facets.artists), [query, facets.artists]);
  const selectedArtistIds = [...new Set([...filters.artists, ...parsedQuery.artists])];
  const selectedFilters = { ...filters, artists: selectedArtistIds };
  const filterCount = filters.storageIds.length + filters.locations.length + selectedArtistIds.length;
  const clearFilters = () => { setFilters(EMPTY_LIBRARY_FILTERS); setQuery(''); };
  const renderSearchPreview = (onClose?: () => void) => <LibrarySearchPreview query={query} facets={facets} filters={filters}
    onApply={(nextQuery, nextFilters) => { setQuery(nextQuery); setFilters(nextFilters); }} onClose={onClose} />;
  const filterButton = <button type="button" data-testid="library-filter-toggle" aria-label="Sort and filter library" aria-expanded={filterOpen}
    aria-pressed={filterCount > 0 || sortKey !== 'latest'} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-foreground/10 aria-pressed:text-accent" onClick={() => setFilterOpen(true)}>
    <FunnelSimple aria-hidden className="h-6 w-6" />
  </button>;
  const visibleItems = useMemo(
    () =>
      filterAndSortLibraryItems(rawItems, type, {
        query: deferredQuery,
        sortKey,
        sortDirection,
        filters,
      }),
    [deferredQuery, filters, rawItems, sortKey, sortDirection, type],
  );
  const selectedItems = useMemo(
    () => rawItems.filter((item) => selectedIds.has(item.id)),
    [rawItems, selectedIds],
  );
  const selectSort = (key: LibrarySortKey) => {
    setSort((current) => ({
      key,
      direction: (current.key === key || (current.key === 'latest' && key === 'modified'))
        ? current.direction === 'asc' ? 'desc' : 'asc'
        : key === 'size' || key === 'modified' ? 'desc' : 'asc',
    }));
  };
  const clearSelection = () => {
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
      return next;
    });
  }, []);
  const enterSelection = useCallback(
    (item: LibraryItem) => {
      if (type === 'image') return;
      setSelectedIds(new Set([item.id]));
    },
    [type],
  );
  const openAddModal = useCallback(
    (items: LibraryItem[]) => {
      if (items.length === 0) return;
      setAddModalItems(items);
      setNewPlaylistName('');
    },
    [],
  );
  const confirmAddToPlaylist = (playlistId = '') => {
    const items = addModalItems ?? [];
    if (items.length === 0) return;
    const keys = items.map(contentKeyForLibraryItem);
    let targetId = playlistId;
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
    <div className="mx-auto w-full max-w-7xl px-4 pb-7 pt-3 sm:px-8 lg:px-10">
      {searchHost === null && <header className="mb-4 flex min-h-10 items-center">
        <h1 className="truncate text-xl font-semibold tracking-tight">{meta.title}</h1>
      </header>}
      {searchHost === null ? (
        <>
        <StandaloneLibrarySearch
          title={meta.title}
          query={query}
          onQueryChange={setQuery}
        />
        {renderSearchPreview()}
        </>
      ) : (
        createPortal(
          <FloatingSearchControl
            title={meta.title}
            query={query}
            onQueryChange={setQuery}
            renderPreview={renderSearchPreview}
          />,
          searchHost,
        )
      )}

      {filterHost ? createPortal(filterButton, filterHost) : <div className="mb-2 flex justify-end">{filterButton}</div>}
      {filterCount > 0 && <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Active library filters">
        {filters.storageIds.map((id) => <button key={id} type="button" className="muzio-glass-action muzio-glass-action-secondary" aria-label={`Remove storage ${facets.storage.find((entry) => entry.id === id)?.label ?? id}`}
          onClick={() => setFilters((current) => ({ ...current, storageIds: current.storageIds.filter((value) => value !== id) }))}>{facets.storage.find((entry) => entry.id === id)?.label ?? id} ×</button>)}
        {filters.locations.map((location) => <button key={location} type="button" className="muzio-glass-action muzio-glass-action-secondary" aria-label={`Remove ${location === 'local' ? 'Offline' : 'Online'} source`}
          onClick={() => setFilters((current) => ({ ...current, locations: current.locations.filter((value) => value !== location) }))}>{location === 'local' ? 'Offline' : 'Online'} ×</button>)}
        {selectedArtistIds.map((id) => {
          const label = facets.artists.find((artist) => artist.id === id)?.label ?? id;
          return <button key={id} type="button" className="muzio-glass-action muzio-glass-action-secondary" aria-label={`Remove artist ${label}`}
            onClick={() => {
              if (parsedQuery.artists.includes(id)) {
                setQuery(libraryQueryWithArtists(parsedQuery.text, parsedQuery.artists.filter((artist) => artist !== id), facets.artists));
              }
              setFilters((current) => ({ ...current, artists: current.artists.filter((artist) => artist !== id) }));
            }}>#{label} ×</button>;
        })}
        <button type="button" className="text-xs text-muted" onClick={clearFilters}>Clear filters</button>
      </div>}
      {filterOpen && <LibraryFilterPanel items={rawItems} type={type} selection={{ filters: selectedFilters, sortKey, sortDirection, text: parsedQuery.text }} onClose={() => setFilterOpen(false)} onApply={(selection) => {
        setSort({ key: selection.sortKey, direction: selection.sortDirection });
        setFilters({ ...selection.filters, artists: [] });
        setQuery(libraryQueryWithArtists(selection.text, selection.filters.artists, facets.artists));
        setFilterOpen(false);
      }} />}

      <LibraryBody
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={selectSort}
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
        selectionAnchorId={selectionAnchorId}
        onAddSelection={() => openAddModal(selectedItems)}
        onClearSelection={clearSelection}
      />
      {addModalItems !== null && (
        <AddToPlaylistModal
          itemCount={addModalItems.length}
          newPlaylistName={newPlaylistName}
          onClose={() => setAddModalItems(null)}
          onConfirm={confirmAddToPlaylist}
          onNewPlaylistName={setNewPlaylistName}
          playlists={playlists.playlists}
        />
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
  sortKey,
  sortDirection,
  onSort,
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
  selectionAnchorId,
  onAddSelection,
  onClearSelection,
}: {
  sortKey: LibrarySortKey;
  sortDirection: LibrarySortDirection;
  onSort: (key: LibrarySortKey) => void;
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
  selectionAnchorId?: string;
  onAddSelection: () => void;
  onClearSelection: () => void;
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
        <div className="border-b border-zinc-200/70 dark:border-white/10">
          <div className={`border-b border-zinc-200/70 px-3 text-sm font-medium text-muted dark:border-white/10 sm:px-5 ${type === 'audio' ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_6.75rem] xl:gap-2' : ''}`}>
            <div
              role="group"
              aria-label="Sort library"
              className={`flex min-h-[54px] flex-wrap items-center gap-x-4 ${type === 'audio' ? 'xl:grid xl:grid-cols-[2.75rem_minmax(11rem,1fr)_minmax(8rem,0.72fr)_6rem_7.5rem_minmax(6rem,0.6fr)] xl:gap-3' : ''}`}
            >
              {([
                { key: 'name', label: type === 'audio' ? 'Song' : type === 'video' ? 'Video' : 'Image' },
                ...(type === 'audio' ? [{ key: 'artist', label: 'Artist' }] : []),
                { key: 'size', label: 'Size' },
                { key: 'modified', label: 'Modified' },
                { key: 'library', label: 'Library' },
              ] as { key: LibrarySortKey; label: string }[]).map(({ key, label }, index) => {
                const active = sortKey === key || (sortKey === 'latest' && key === 'modified');
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={`Sort by ${label}`}
                    aria-pressed={active}
                    title={active ? `${label}: ${sortDirection === 'asc' ? 'ascending' : 'descending'}` : `Sort by ${label}`}
                    onClick={() => onSort(key)}
                    className={`relative inline-flex min-h-10 items-center justify-start gap-1 text-left hover:text-foreground ${active ? 'text-foreground' : ''} ${index === 0 && type === 'audio' ? 'xl:col-span-2' : ''}`}
                  >
                    {index > 0 && <span aria-hidden className="pointer-events-none absolute -left-2 text-[10px] font-normal text-muted/40">|</span>}
                    <span>{label}</span>
                    {active && <span aria-hidden className="text-[10px] text-muted">{sortDirection === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <VirtualizedLibraryList
            items={visibleItems}
            onLongPressItem={onLongPressItem}
            onOpenAddToPlaylist={onOpenAddToPlaylist}
            onToggleSelected={onToggleSelected}
            selectedIds={selectedIds}
            selectionMode={selectionMode}
            selectionAnchorId={selectionAnchorId}
            onAddSelection={onAddSelection}
            onClearSelection={onClearSelection}
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
  playlists,
}: {
  itemCount: number;
  newPlaylistName: string;
  onClose: () => void;
  onConfirm: (playlistId?: string) => void;
  onNewPlaylistName: (name: string) => void;
  playlists: PlaylistRecord[];
}) {
  const [creating, setCreating] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) nameInput.current?.focus();
  }, [creating]);
  return (
    <GlassModal
      testId="add-to-playlist-modal"
      title="Add to Playlist"
      closeLabel="Close add to playlist"
      onClose={onClose}
      headerActions={<button type="button" aria-label="Create playlist" className="muzio-modal-close"
        disabled={creating} onClick={() => setCreating(true)}><Plus aria-hidden className="h-5 w-5" /></button>}
      footer={creating ? (
        <>
        <button type="button" className="muzio-glass-action muzio-glass-action-secondary"
          onClick={() => { setCreating(false); onNewPlaylistName(''); }}>Cancel</button>
        <button
          type="button"
          data-testid="add-playlist-confirm"
          className="muzio-glass-action"
          disabled={newPlaylistName.trim() === ''}
          onClick={() => onConfirm()}
        >
          Create and save
        </button>
        </>
      ) : undefined}
    >
      <p className="mb-3 text-sm text-white/60">{itemCount} selected</p>
      {creating ? (
        <div>
          <label className="mb-2 block text-sm text-muted" htmlFor="add-playlist-create-name">New playlist name</label>
          <input ref={nameInput} id="add-playlist-create-name"
            data-testid="add-playlist-create-name"
            value={newPlaylistName}
            onChange={(event) => onNewPlaylistName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && newPlaylistName.trim()) {
                event.preventDefault();
                onConfirm();
              }
            }}
            className="muzio-glass-input w-full px-4 py-2 text-sm outline-none"
          />
        </div>
      ) : playlists.length > 0 ? (
        <div className="flex flex-col gap-2" aria-label="Playlists">
          {playlists.map((playlist) => (
            <button key={playlist.id} type="button" className="muzio-glass-action w-full text-left"
              onClick={() => onConfirm(playlist.id)}>{playlist.name}</button>
          ))}
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-muted">No playlists yet. Use + to create one.</p>
      )}
    </GlassModal>
  );
}
