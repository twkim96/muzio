import { useMemo } from 'react';
import { libraryQueryWithArtists, parseLibraryQuery, type LibraryFacet, type LibraryFilters } from './libraryView';

type Facets = { artists: LibraryFacet[]; storage: LibraryFacet[]; locations: { network: number; local: number } };
type Suggestion = LibraryFacet & { kind: 'artist' | 'storage' | 'source' };
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();

/** Complete the last # token while preserving earlier text and selected tags. */
export function librarySearchPreview(query: string, facets: Facets) {
  const tag = /(?:^|\s)#([^#]*)$/.exec(query);
  const term = normalize((tag ? tag[1] : query).trim().replace(/^["']|["']$/g, ''));
  const prefix = tag ? query.slice(0, tag.index).trim() : '';
  const candidates: Suggestion[] = [
    ...facets.artists.map((entry) => ({ ...entry, kind: 'artist' as const })),
    ...facets.storage.map((entry) => ({ ...entry, kind: 'storage' as const })),
    ...(['network', 'local'] as const).filter((id) => facets.locations[id] > 0).map((id) => ({
      id, kind: 'source' as const, label: id === 'local' ? 'Offline' : 'Online', count: facets.locations[id],
    })),
  ];
  const rank = (entry: Suggestion) => normalize(entry.label) === term ? 0 : normalize(entry.label).startsWith(term) ? 1 : 2;
  const suggestions = candidates.filter((entry) => normalize(entry.label).includes(term))
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.label.localeCompare(b.label)).slice(0, 8);
  return { prefix, suggestions };
}

export function LibrarySearchPreview({ query, facets, filters, onApply, onClose }: {
  query: string;
  facets: Facets;
  filters: LibraryFilters;
  onApply: (query: string, filters: LibraryFilters) => void;
  onClose?: () => void;
}) {
  const { prefix, suggestions } = useMemo(() => librarySearchPreview(query, facets), [query, facets]);
  if (!query.trim()) return null;
  const select = (entry: Suggestion) => {
    const parsed = parseLibraryQuery(prefix, facets.artists);
    const next = { ...filters };
    if (entry.kind === 'artist') parsed.artists = [...new Set([...parsed.artists, entry.id])];
    else if (entry.kind === 'storage') next.storageIds = [...new Set([...next.storageIds, entry.id])];
    else next.locations = [...new Set([...next.locations, entry.id as 'local' | 'network'])];
    onApply(libraryQueryWithArtists(parsed.text, parsed.artists, facets.artists), next);
    onClose?.();
  };
  return <section aria-label="Filter suggestions" data-testid="library-search-preview" data-allow-scroll
    className="muzio-dialog mt-2 max-h-[min(18rem,40dvh)] overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200/70 p-3 text-sm shadow-xl dark:border-white/10">
    <h3 className="mb-2 text-xs font-semibold text-muted">필터 미리보기</h3>
    {suggestions.length === 0 ? <p className="text-xs text-muted">일치하는 필터가 없습니다.</p> :
      (['artist', 'storage', 'source'] as const).map((kind) => {
        const entries = suggestions.filter((entry) => entry.kind === kind);
        if (!entries.length) return null;
        return <div key={kind} className="mt-2">
          <h4 className="mb-1.5 text-[11px] text-muted">{kind === 'artist' ? 'Artist' : kind === 'storage' ? 'Storage' : 'Source'}</h4>
          <div className="flex flex-wrap gap-1.5">{entries.map((entry) => <button key={entry.id} type="button"
            aria-label={`Apply ${kind} filter ${entry.label}`} onClick={() => select(entry)}
            className="muzio-glass-action muzio-glass-action-secondary">
            #{entry.label} <span className="text-muted">{entry.count}</span>
          </button>)}</div>
        </div>;
      })}
  </section>;
}
