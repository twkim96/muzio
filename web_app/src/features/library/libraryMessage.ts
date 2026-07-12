import type { LibraryFetchResult } from '../../core/api/libraryClient';

/**
 * Pure helper for rendering a short error/empty banner. Component code stays
 * dumb; tests pin the exact wording.
 */
export function describeLibraryError(result: LibraryFetchResult): string {
  switch (result.kind) {
    case 'ok':
    case 'notModified':
      return '';
    case 'badResponse':
      return `Server replied with HTTP ${result.statusCode}`;
    case 'unreachable':
      return `Backend unreachable: ${result.message}`;
  }
}
