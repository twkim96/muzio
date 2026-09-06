import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { LibrarySearchPreview, librarySearchPreview } from './LibrarySearchPreview';
import { EMPTY_LIBRARY_FILTERS } from './libraryView';

const facets = {
  artists: [
    { id: 'maroon 5', label: 'Maroon 5', count: 81 },
    { id: 'muse', label: 'Muse', count: 58 },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `other ${i}`, label: `Other ${i}`, count: 1 })),
  ],
  storage: [{ id: 'network:Collection', label: 'Collection', count: 100 }],
  locations: { network: 200, local: 2 },
};

describe('library search filter preview', () => {
  test('limits full-catalog matches and normalizes partial artist names', () => {
    expect(librarySearchPreview('#', facets).suggestions).toHaveLength(8);
    expect(librarySearchPreview('#ＭＡＲＯＯＮ５', facets).suggestions.map((x) => x.id)).toEqual(['maroon 5']);
    expect(librarySearchPreview('Maroon', facets).suggestions.map((x) => x.id)).toEqual(['maroon 5']);
  });
  test('completes a partial tag, retaining preceding search text and artist tags', () => {
    const onApply = vi.fn(); const onClose = vi.fn();
    render(<LibrarySearchPreview query={'love #"Muse" #Mar'} facets={facets} filters={EMPTY_LIBRARY_FILTERS} onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply artist filter Maroon 5' }));
    expect(onApply).toHaveBeenCalledWith('love #"Muse" #"Maroon 5"', EMPTY_LIBRARY_FILTERS);
    expect(onClose).toHaveBeenCalledOnce();
  });
  test('replaces the storage search token without losing existing filters', () => {
    const onApply = vi.fn();
    const filters = { ...EMPTY_LIBRARY_FILTERS, locations: ['local'] as const };
    render(<LibrarySearchPreview query="#Coll" facets={facets} filters={filters} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply storage filter Collection' }));
    expect(onApply).toHaveBeenCalledWith('', { ...filters, storageIds: ['network:Collection'] });
  });
});
