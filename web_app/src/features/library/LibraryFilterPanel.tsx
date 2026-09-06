import { useMemo, useState } from 'react';
import type { LibraryItem, LibraryMediaType } from '../../core/api/libraryClient';
import { GlassModal } from '../../core/ui/GlassModal';
import {
  EMPTY_LIBRARY_FILTERS, filterAndSortLibraryItems, libraryFacets,
  type LibraryFilters, type LibrarySortDirection, type LibrarySortKey,
} from './libraryView';

export interface LibraryFilterSelection {
  filters: LibraryFilters;
  sortKey: LibrarySortKey;
  sortDirection: LibrarySortDirection;
  text: string;
}

const toggle = <T,>(values: readonly T[], value: T) => values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
const chipClass = 'muzio-glass-action muzio-glass-action-secondary aria-pressed:border-accent aria-pressed:text-accent';

/** Structure follows Web Reader ShelfFilterModal: sort first, facet tags below, reset/apply footer. */
export function LibraryFilterPanel({ items, type, selection, onApply, onClose }: {
  items: readonly LibraryItem[];
  type: LibraryMediaType;
  selection: LibraryFilterSelection;
  onApply: (selection: LibraryFilterSelection) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(selection);
  const [artistCount, setArtistCount] = useState(15);
  const facets = useMemo(() => libraryFacets(items), [items]);
  const count = useMemo(() => filterAndSortLibraryItems(items, type, {
    query: draft.text, sortKey: 'latest', filters: draft.filters,
  }).length, [draft, items, type]);
  const updateFacet = <K extends keyof LibraryFilters>(key: K, values: LibraryFilters[K]) => setDraft((current) => ({ ...current, filters: { ...current.filters, [key]: values } }));
  const visibleArtists = facets.artists.slice(0, artistCount);
  const selectedOutside = draft.filters.artists.filter((id) => !visibleArtists.some((artist) => artist.id === id));
  const artistChip = (id: string, label: string, count: number) => (
    <button key={id} type="button" data-testid="artist-filter-tag" aria-label={`Artist ${label}`} aria-pressed={draft.filters.artists.includes(id)} className={chipClass}
      onClick={() => updateFacet('artists', toggle(draft.filters.artists, id))}>#{label} <span className="text-muted">{count}</span></button>
  );
  return (
    <GlassModal testId="library-filter-panel" title="Sort & filters" onClose={onClose} footer={<>
      <button type="button" className="muzio-glass-action muzio-glass-action-secondary" onClick={() => {
        setDraft({ filters: EMPTY_LIBRARY_FILTERS, sortKey: 'latest', sortDirection: 'desc', text: '' });
        setArtistCount(15);
      }}>Reset</button>
      <button type="button" className="muzio-glass-action flex-1" onClick={() => onApply(draft)}>Show {count} items</button>
    </>}>
      <div className="space-y-5">
        <section aria-label="Sorting">
          <h3 className="text-xs font-semibold text-muted">Sort</h3>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {([{ key: 'latest', label: 'Latest' }, { key: 'name', label: type === 'audio' ? 'Song' : type === 'video' ? 'Video' : 'Image' },
              { key: 'artist', label: 'Artist' }, { key: 'size', label: 'Size' }, { key: 'modified', label: 'Modified' }, { key: 'library', label: 'Library' }] as const).map(({ key, label }) => (
              <button key={key} type="button" aria-label={`Panel sort by ${label}`} aria-pressed={draft.sortKey === key} className={`${chipClass} min-h-11 rounded-xl`}
                onClick={() => setDraft((current) => ({ ...current, sortKey: key, sortDirection: key === 'latest' || key === 'modified' || key === 'size' ? 'desc' : 'asc' }))}>{label}</button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            {(['asc', 'desc'] as const).map((direction) => <button key={direction} type="button" className={chipClass} disabled={draft.sortKey === 'latest'} aria-pressed={draft.sortDirection === direction}
              onClick={() => setDraft((current) => ({ ...current, sortDirection: direction }))}>{direction === 'asc' ? 'Ascending' : 'Descending'}</button>)}
          </div>
        </section>
        <section aria-label="Storage groups">
          <h3 className="text-xs font-semibold text-muted">Storage</h3>
          <div className="mt-2 flex flex-wrap gap-2">{facets.storage.map((storage) => <button key={storage.id} type="button" className={chipClass}
            aria-label={`Storage ${storage.label} (${storage.id.startsWith('local:') ? 'Offline' : 'Online'})`} aria-pressed={draft.filters.storageIds.includes(storage.id)}
            onClick={() => updateFacet('storageIds', toggle(draft.filters.storageIds, storage.id))}>{storage.label} <span className="text-muted">{storage.count}</span></button>)}</div>
        </section>
        <section aria-label="Source availability">
          <h3 className="text-xs font-semibold text-muted">Source</h3>
          <div className="mt-2 flex flex-wrap gap-2">{(['network', 'local'] as const).map((location) => <button key={location} type="button" className={chipClass}
            aria-label={location === 'network' ? 'Online source' : 'Offline source'} aria-pressed={draft.filters.locations.includes(location)}
            onClick={() => updateFacet('locations', toggle(draft.filters.locations, location))}>{location === 'network' ? 'Online' : 'Offline'} <span className="text-muted">{facets.locations[location]}</span></button>)}</div>
          <p className="mt-2 text-xs text-muted">Online: server library · Offline: files stored on this device</p>
        </section>
        <section aria-label="Artist tags">
          <h3 className="text-xs font-semibold text-muted">Artist <span className="font-normal">· Most items first</span></h3>
          {selectedOutside.length > 0 && <div className="mt-2 flex flex-wrap gap-2" aria-label="Selected artists">{selectedOutside.map((id) => {
            const artist = facets.artists.find((entry) => entry.id === id);
            return artistChip(id, artist?.label ?? id, artist?.count ?? 0);
          })}</div>}
          <div className="mt-2 flex flex-wrap gap-2" data-testid="visible-artist-tags">{visibleArtists.map((artist) => artistChip(artist.id, artist.label, artist.count))}</div>
          {artistCount < facets.artists.length && <button type="button" className={`${chipClass} mt-2 w-full`} onClick={() => setArtistCount((count) => count + 15)}>More artists (15)</button>}
          {facets.artists.length === 0 && <p className="mt-2 text-sm text-muted">No artist metadata.</p>}
        </section>
      </div>
    </GlassModal>
  );
}
