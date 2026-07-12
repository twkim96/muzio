import type { PlaybackEngine, EngineEvent } from '../engine/engine';
import type { PlaybackSource } from '../source/source';

/**
 * High-level playback state consumed by the UI.
 *
 * The session subscribes to engine events and projects them onto a small,
 * UI-friendly state machine. UI code never imports the engine module
 * directly; it watches the session and calls back into engine operations
 * through this layer.
 */
export type PlaybackStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'buffering' }
  | { kind: 'ended' }
  | { kind: 'error'; message: string };

export interface PlaybackState {
  status: PlaybackStatus;
  source: PlaybackSource | null;
  positionSec: number;
  durationSec: number;
  /**
   * Increments only when the media element reports a real timeupdate.
   * UI-mirrored seeks update positionSec immediately but do not advance this.
   */
  mediaPositionUpdateSeq?: number;
}

export type SessionListener = (state: PlaybackState) => void;

export interface PlaybackSession {
  getState(): PlaybackState;
  subscribe(listener: SessionListener): () => void;
  load(source: PlaybackSource): void;
  play(): Promise<void>;
  pause(): void;
  seek(positionSec: number): void;
  dispose(): void;
}

const initialState: PlaybackState = {
  status: { kind: 'idle' },
  source: null,
  positionSec: 0,
  durationSec: 0,
  mediaPositionUpdateSeq: 0,
};

function sourceDurationSec(source: PlaybackSource): number {
  return typeof source.durationSec === 'number' &&
    Number.isFinite(source.durationSec) &&
    source.durationSec > 0
    ? source.durationSec
    : 0;
}

export function createSession(engine: PlaybackEngine): PlaybackSession {
  let state: PlaybackState = initialState;
  const listeners = new Set<SessionListener>();

  const emit = () => {
    for (const listener of [...listeners]) listener(state);
  };

  const update = (patch: Partial<PlaybackState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const handle = (event: EngineEvent) => {
    switch (event.kind) {
      case 'loading':
        update({
          status: { kind: 'loading' },
          positionSec: 0,
          durationSec: 0,
          mediaPositionUpdateSeq: 0,
        });
        break;
      case 'metadata':
        update({ durationSec: event.durationSec });
        break;
      case 'canplay':
        if (
          event.paused &&
          (state.status.kind === 'loading' ||
            state.status.kind === 'buffering')
        ) {
          update({ status: { kind: 'paused' } });
        }
        break;
      case 'playing':
        update({ status: { kind: 'playing' } });
        break;
      case 'paused':
        // Ignore paused after ended so the terminal state stays terminal until
        // the next load.
        if (state.status.kind === 'ended') break;
        update({ status: { kind: 'paused' } });
        break;
      case 'waiting':
        update({ status: { kind: 'buffering' } });
        break;
      case 'seeking':
      case 'seeked':
      case 'stalled':
      case 'progress':
      case 'suspend':
      case 'abort':
        break;
      case 'time':
        // Ignore stray timeupdate events delivered before any load() so the
        // session does not surface a non-zero position from a previous source.
        if (state.source === null) break;
        update({
          positionSec: event.positionSec,
          mediaPositionUpdateSeq: (state.mediaPositionUpdateSeq ?? 0) + 1,
        });
        break;
      case 'ended':
        update({ status: { kind: 'ended' } });
        break;
      case 'error':
        update({ status: { kind: 'error', message: event.message } });
        break;
    }
  };

  const unsubscribeEngine = engine.subscribe(handle);

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(source) {
      // Reset to a clean loading state; metadata/timeupdate events from the
      // previous source must not bleed into the new one.
      state = {
        status: { kind: 'loading' },
        source,
        positionSec: 0,
        durationSec: sourceDurationSec(source),
        mediaPositionUpdateSeq: 0,
      };
      emit();
      engine.load(source);
    },
    play() {
      return engine.play();
    },
    pause() {
      engine.pause();
    },
    seek(positionSec) {
      engine.seek(positionSec);
      // Mirror the requested position immediately so the UI does not wait for
      // the next timeupdate to redraw a scrubber.
      if (Number.isFinite(positionSec) && positionSec >= 0) {
        update({ positionSec });
      }
    },
    dispose() {
      unsubscribeEngine();
      listeners.clear();
      // The session is the playback owner from the UI's point of view (Phase 6
      // decision record). Releasing the engine here means UI code can call
      // session.dispose() in a single useEffect cleanup without leaking the
      // underlying media element's listeners, src, or buffering.
      engine.release();
    },
  };
}
