import type {
  ProgressRecord,
  ProgressRepository,
} from '../../core/storage/progressRepository';
import type { PlaybackSession } from '../../core/playback/session/session';
import { PLAYBACK_PROGRESS_THROTTLE_MS } from '../../core/playback/playbackPolicy';

/**
 * Wires a playback session to the progress repository.
 *
 * The service is the only place that owns the rules for "when to save" so
 * neither core/playback nor any UI layer has to know about the storage
 * shape. Resume is intentionally driven by the streaming URL fragment
 * (`#t=...`) at load time rather than by a post-metadata seek; that choice
 * eliminates a buffering race where the element starts loading from byte 0
 * and is then asked to jump.
 */
export interface ProgressServiceOptions {
  /** Throttle interval for periodic writes, in milliseconds. */
  throttleMs?: number;
  /** Provider for the current timestamp, injected for tests. */
  now?: () => number;
}

export interface ProgressServiceAttachment {
  /** Persist the latest known session position without detaching listeners. */
  flush(): void;
  dispose(options?: { flush?: boolean }): void;
}

export interface ProgressService {
  attach(session: PlaybackSession): ProgressServiceAttachment;
  recordFor(mediaId: string): ProgressRecord | null;
}

export function createProgressService(
  repository: ProgressRepository,
  options: ProgressServiceOptions = {},
): ProgressService {
  const throttleMs = options.throttleMs ?? PLAYBACK_PROGRESS_THROTTLE_MS;
  const now = options.now ?? Date.now;

  return {
    recordFor(mediaId) {
      return repository.read(mediaId);
    },

    attach(session) {
      // Initialize to -Infinity so the first throttled write always fires
      // regardless of whether `now()` returns 0 in tests.
      let lastWrittenAt = Number.NEGATIVE_INFINITY;

      const writeIfMeaningful = (
        sourceId: string | null,
        positionSec: number,
        durationSec: number,
      ) => {
        if (sourceId === null) return;
        if (!Number.isFinite(positionSec) || positionSec <= 0) return;
        if (!Number.isFinite(durationSec) || durationSec <= 0) return;
        const liveSource = session.getState().source;
        const sourceMeta =
          liveSource !== null &&
          liveSource.mediaId === sourceId &&
          liveSource.rootName !== undefined &&
          liveSource.relativePath !== undefined
            ? {
                mediaType: liveSource.mediaType,
                name: liveSource.name,
                rootName: liveSource.rootName,
                relativePath: liveSource.relativePath,
              }
            : undefined;
        repository.write(sourceId, {
          positionSec,
          durationSec,
          lastPlayedAt: new Date(now()).toISOString(),
          ...(sourceMeta !== undefined ? { source: sourceMeta } : {}),
        });
        lastWrittenAt = now();
      };

      const flush = () => {
        const state = session.getState();
        const fallbackDurationSec =
          typeof state.source?.durationSec === 'number'
            ? state.source.durationSec
            : 0;
        writeIfMeaningful(
          state.source?.mediaId ?? null,
          state.positionSec,
          state.durationSec > 0 ? state.durationSec : fallbackDurationSec,
        );
      };

      const unsubscribe = session.subscribe((state) => {
        const sourceId = state.source?.mediaId ?? null;
        if (sourceId === null) return;
        const fallbackDurationSec =
          typeof state.source?.durationSec === 'number'
            ? state.source.durationSec
            : 0;
        const durationSec =
          state.durationSec > 0 ? state.durationSec : fallbackDurationSec;

        // Persist on terminal events so the user does not lose the last
        // viewed position to a hard tab close.
        if (state.status.kind === 'paused' || state.status.kind === 'ended') {
          writeIfMeaningful(sourceId, state.positionSec, durationSec);
          return;
        }
        // Throttled write while playing.
        if (state.status.kind === 'playing') {
          if (now() - lastWrittenAt >= throttleMs) {
            writeIfMeaningful(sourceId, state.positionSec, durationSec);
          }
        }
      });

      const handleBeforeUnload = () => {
        flush();
      };

      const supportsBrowserUnload =
        typeof window !== 'undefined' &&
        typeof window.addEventListener === 'function';
      if (supportsBrowserUnload) {
        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('pagehide', handleBeforeUnload);
      }

      return {
        flush,
        dispose(options = {}) {
          if (options.flush !== false) {
            flush();
          }
          unsubscribe();
          if (supportsBrowserUnload) {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            window.removeEventListener('pagehide', handleBeforeUnload);
          }
        },
      };
    },
  };
}
