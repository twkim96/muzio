import type { PlaybackSource } from '../source/source';

const STORAGE_KEY = 'muzio.playbackDiagnostics';
const MAX_ENTRIES = 400;

export interface PlaybackDiagnosticBufferedRange {
  startSec: number;
  endSec: number;
}

export interface PlaybackDiagnosticEntry {
  sequence: number;
  atMs: number;
  kind: string;
  mediaId: string | null;
  mediaType: PlaybackSource['mediaType'] | null;
  sourceGeneration: number;
  seekGeneration: number;
  positionSec: number | null;
  previousPositionSec?: number | null;
  targetPositionSec?: number | null;
  durationSec: number | null;
  paused: boolean | null;
  readyState: number | null;
  networkState: number | null;
  buffered: PlaybackDiagnosticBufferedRange[];
}

export interface PlaybackDiagnosticSnapshot {
  kind: string;
  source: PlaybackSource | null;
  sourceGeneration: number;
  seekGeneration: number;
  positionSec: number | null;
  previousPositionSec?: number | null;
  targetPositionSec?: number | null;
  durationSec: number | null;
  paused: boolean | null;
  readyState: number | null;
  networkState: number | null;
  buffered: PlaybackDiagnosticBufferedRange[];
}

export interface PlaybackDiagnosticsApi {
  enable(): void;
  disable(): void;
  clear(): void;
  entries(): PlaybackDiagnosticEntry[];
  export(): string;
}

declare global {
  interface Window {
    muzioPlaybackDiagnostics?: PlaybackDiagnosticsApi;
  }
}

let enabledOverride: boolean | null = null;
let storedEnabled: boolean | null = null;
let sequence = 0;
const entries: PlaybackDiagnosticEntry[] = [];

function storageEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isPlaybackDiagnosticsEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  if (storedEnabled === null) storedEnabled = storageEnabled();
  return storedEnabled;
}

export function setPlaybackDiagnosticsEnabled(enabled: boolean): void {
  enabledOverride = enabled;
  storedEnabled = enabled;
  if (typeof window === 'undefined') return;
  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private contexts; the in-memory override
    // still controls diagnostics for the current session.
  }
}

export function clearPlaybackDiagnostics(): void {
  entries.length = 0;
  sequence = 0;
}

export function getPlaybackDiagnostics(): PlaybackDiagnosticEntry[] {
  return entries.map((entry) => ({
    ...entry,
    buffered: entry.buffered.map((range) => ({ ...range })),
  }));
}

export function exportPlaybackDiagnosticsReport(): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      entries: getPlaybackDiagnostics(),
    },
    null,
    2,
  );
}

export function recordPlaybackDiagnostic(
  snapshot: PlaybackDiagnosticSnapshot,
): void {
  if (!isPlaybackDiagnosticsEnabled()) return;
  const source = snapshot.source;
  entries.push({
    sequence: ++sequence,
    atMs:
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    kind: snapshot.kind,
    mediaId: source?.mediaId ?? null,
    mediaType: source?.mediaType ?? null,
    sourceGeneration: snapshot.sourceGeneration,
    seekGeneration: snapshot.seekGeneration,
    positionSec: snapshot.positionSec,
    previousPositionSec: snapshot.previousPositionSec,
    targetPositionSec: snapshot.targetPositionSec,
    durationSec: snapshot.durationSec,
    paused: snapshot.paused,
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    buffered: snapshot.buffered.map((range) => ({ ...range })),
  });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export function installPlaybackDiagnosticsGlobal(): void {
  if (typeof window === 'undefined') return;
  window.muzioPlaybackDiagnostics = {
    enable: () => setPlaybackDiagnosticsEnabled(true),
    disable: () => setPlaybackDiagnosticsEnabled(false),
    clear: clearPlaybackDiagnostics,
    entries: getPlaybackDiagnostics,
    export: exportPlaybackDiagnosticsReport,
  };
}

installPlaybackDiagnosticsGlobal();
