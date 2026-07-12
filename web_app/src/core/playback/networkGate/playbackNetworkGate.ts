type TimerHandle = Parameters<typeof clearTimeout>[0];

export type PlaybackNetworkWorkKind =
  | 'library-live-sync'
  | 'thumbnail'
  | 'manual-refresh';

export interface PlaybackNetworkGate {
  beginAudioStartup(sourceId: string): () => void;
  beginAudioSeek(sourceId: string, targetSec: number): () => void;
  shouldDefer(kind: PlaybackNetworkWorkKind, reason: string): boolean;
  subscribe(listener: () => void): () => void;
}

interface GateOptions {
  timeoutMs?: number;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

interface ActiveSection {
  token: number;
  kind: 'audio-startup' | 'audio-seek';
  sourceId: string;
  targetSec?: number;
  timer: TimerHandle;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function createPlaybackNetworkGate(
  options: GateOptions = {},
): PlaybackNetworkGate {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const active = new Map<number, ActiveSection>();
  const listeners = new Set<() => void>();
  let nextToken = 0;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const end = (token: number) => {
    const section = active.get(token);
    if (!section) return;
    active.delete(token);
    clearTimeoutFn(section.timer);
    emit();
  };

  const begin = (
    kind: ActiveSection['kind'],
    sourceId: string,
    targetSec?: number,
  ) => {
    const token = ++nextToken;
    const timer = setTimeoutFn(() => end(token), timeoutMs);
    active.set(token, { token, kind, sourceId, targetSec, timer });
    emit();
    return () => end(token);
  };

  return {
    beginAudioStartup(sourceId) {
      return begin('audio-startup', sourceId);
    },
    beginAudioSeek(sourceId, targetSec) {
      return begin('audio-seek', sourceId, targetSec);
    },
    shouldDefer(kind) {
      if (kind === 'manual-refresh') return false;
      return active.size > 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const playbackNetworkGate = createPlaybackNetworkGate();
