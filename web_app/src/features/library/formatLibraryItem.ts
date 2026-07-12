/**
 * Pure formatters for library item presentation. Lifted out of components so
 * unit tests can pin the exact wording and so future locale work has one
 * place to land.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KB`;
  if (bytes < GIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${(bytes / GIB).toFixed(2)} GB`;
}

/**
 * Returns the modified timestamp as a UTC YYYY-MM-DD string. The backend
 * already serializes UTC RFC3339, so no time-zone conversion is performed
 * here; locale-aware formatting is a Phase 11+ concern.
 */
export function formatModified(rfc3339: string): string {
  const date = new Date(rfc3339);
  if (Number.isNaN(date.getTime())) return '—';
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Splits a forward-slash relativePath into its directory prefix and the
 * filename. Used by the row component to dim the directory portion.
 */
export function splitPath(relativePath: string): {
  directory: string;
  filename: string;
} {
  const slash = relativePath.lastIndexOf('/');
  if (slash === -1) return { directory: '', filename: relativePath };
  return {
    directory: relativePath.slice(0, slash + 1),
    filename: relativePath.slice(slash + 1),
  };
}
