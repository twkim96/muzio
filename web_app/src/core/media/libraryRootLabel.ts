import type { LibraryItem } from '../api/libraryClient';

/** Server root IDs append an eight-digit path hash; never alter the stored ID. */
export function libraryRootLabel(item: Pick<LibraryItem, 'rootName' | 'location'>): string {
  const name = item.rootName.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || item.rootName;
  return item.location === 'local' ? name : name.replace(/-[0-9a-f]{8}$/, '');
}
