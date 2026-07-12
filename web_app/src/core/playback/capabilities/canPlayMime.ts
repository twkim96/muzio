/**
 * Browser media capability check.
 *
 * `HTMLMediaElement.canPlayType` returns the empty string, "maybe", or
 * "probably". We re-export those three values as a sealed union so callers
 * never compare against magic strings and so future logic (Phase 7
 * "unsupported" surface, Phase 13 thumbnail/transcode hints) can switch on
 * the result exhaustively.
 *
 * `probe` accepts an optional `HTMLMediaElement`-like object so unit tests
 * can pass a fake without touching the DOM. When omitted it constructs a
 * detached `<audio>` element, which is enough for the standard probe in
 * every browser we support.
 */
export type Playability = 'no' | 'maybe' | 'probably';

export interface CanPlayProbe {
  canPlayType(mime: string): string;
}

let cachedProbe: CanPlayProbe | null = null;

function defaultProbe(): CanPlayProbe {
  if (cachedProbe !== null) return cachedProbe;
  if (typeof document === 'undefined') {
    // Server-side or non-DOM context: report "no" by default.
    cachedProbe = { canPlayType: () => '' };
    return cachedProbe;
  }
  cachedProbe = document.createElement('audio');
  return cachedProbe;
}

export function canPlayMime(
  mime: string,
  probe: CanPlayProbe = defaultProbe(),
): Playability {
  if (typeof mime !== 'string' || mime.trim() === '') return 'no';
  const result = probe.canPlayType(mime);
  if (result === 'probably') return 'probably';
  if (result === 'maybe') return 'maybe';
  return 'no';
}

/**
 * Test-only hook. Resets the cached default probe so a test that monkey-
 * patched the global `document` can rebuild it on the next call.
 */
export function __resetCanPlayMimeCacheForTests(): void {
  cachedProbe = null;
}
