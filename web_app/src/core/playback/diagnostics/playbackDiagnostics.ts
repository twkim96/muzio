import type { PlaybackSource } from '../source/source';

const STORAGE_KEY = 'muzio.playbackDiagnostics';
const TRANSPORT_COOKIE_NAME = 'muzioDiagnosticTransportId';
const SAMPLE_COOKIE_NAME = 'muzioDiagnosticSampleId';
const TRANSPORT_COOKIE_PATHS = [
  '/api/media/',
  '/api/video-optimization/media/',
] as const;
const MAX_ENTRIES = 400;

export interface PlaybackDiagnosticBufferedRange {
  startSec: number;
  endSec: number;
}

export interface PlaybackDiagnosticEntry {
  sequence: number;
  transportCorrelationId: string;
  sampleId: string;
  atMs: number;
  wallClockMs: number;
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

interface PlaybackDiagnosticRun {
  sampleId: string;
  startedWallClockMs: number;
  browserSurface: 'browser-tab' | 'home-screen-pwa';
}

interface PlaybackDiagnosticTransport {
  id: string;
}

declare global {
  interface Window {
    muzioPlaybackDiagnostics?: PlaybackDiagnosticsApi;
  }
}

let enabledOverride: boolean | null = null;
let storedEnabled: boolean | null = null;
let sequence = 0;
let activeRun: PlaybackDiagnosticRun | null = null;
let activeTransport: PlaybackDiagnosticTransport | null = null;
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
  const wasEnabled = isPlaybackDiagnosticsEnabled();
  enabledOverride = enabled;
  storedEnabled = enabled;
  if (enabled && !wasEnabled) {
    entries.length = 0;
    sequence = 0;
    activeRun = null;
    activeTransport = null;
  }
  if (!enabled) clearDiagnosticCookies();
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
  activeRun = null;
  if (isPlaybackDiagnosticsEnabled()) {
    currentPlaybackDiagnosticTransport();
    currentPlaybackDiagnosticRun();
  }
}

export function getPlaybackDiagnostics(): PlaybackDiagnosticEntry[] {
  return entries.map((entry) => ({
    ...entry,
    buffered: entry.buffered.map((range) => ({ ...range })),
  }));
}

export function exportPlaybackDiagnosticsReport(): string {
  const run = activeRun ?? currentPlaybackDiagnosticRun();
  const transport = activeTransport ?? currentPlaybackDiagnosticTransport();
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      transportCorrelationId: transport?.id ?? null,
      sampleId: run?.sampleId ?? null,
      startedWallClockMs: run?.startedWallClockMs ?? null,
      browserSurface: run?.browserSurface ?? null,
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
  const run = currentPlaybackDiagnosticRun();
  const transport = currentPlaybackDiagnosticTransport();
  if (run === null || transport === null) return;
  const source = snapshot.source;
  entries.push({
    sequence: ++sequence,
    transportCorrelationId: transport.id,
    sampleId: run.sampleId,
    atMs:
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    wallClockMs: Date.now(),
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

export function recordPlaybackDiagnosticMilestone(
  kind: string,
  source: PlaybackSource | null = null,
  targetPositionSec?: number | null,
): void {
  recordPlaybackDiagnostic({
    kind,
    source,
    sourceGeneration: 0,
    seekGeneration: 0,
    positionSec: null,
    targetPositionSec,
    durationSec: source?.durationSec ?? null,
    paused: null,
    readyState: null,
    networkState: null,
    buffered: [],
  });
}

export function getPlaybackDiagnosticSampleId(): string | null {
  return currentPlaybackDiagnosticRun()?.sampleId ?? null;
}

export function getPlaybackDiagnosticTransportCorrelationId(): string | null {
  return currentPlaybackDiagnosticTransport()?.id ?? null;
}

function currentPlaybackDiagnosticRun(): PlaybackDiagnosticRun | null {
  if (!isPlaybackDiagnosticsEnabled()) return null;
  if (activeRun === null) {
    activeRun = {
      sampleId: randomIdentifier(),
      startedWallClockMs: Date.now(),
      browserSurface: browserSurface(),
    };
    writeDiagnosticCookie(SAMPLE_COOKIE_NAME, activeRun.sampleId);
  }
  return activeRun;
}

function currentPlaybackDiagnosticTransport(): PlaybackDiagnosticTransport | null {
  if (!isPlaybackDiagnosticsEnabled()) return null;
  if (activeTransport === null) {
    activeTransport = { id: randomIdentifier() };
    writeDiagnosticCookie(TRANSPORT_COOKIE_NAME, activeTransport.id);
  }
  return activeTransport;
}

function randomIdentifier(): string {
  const bytes = new Uint8Array(16);
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
  }
  const fallback = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return fallback.padEnd(32, '0').slice(0, 32);
}

function writeDiagnosticCookie(name: string, id: string): void {
  if (typeof document === 'undefined') return;
  for (const path of TRANSPORT_COOKIE_PATHS) {
    document.cookie = `${name}=${id}; Path=${path}; SameSite=Strict`;
  }
}

function clearDiagnosticCookies(): void {
  if (typeof document === 'undefined') return;
  for (const path of TRANSPORT_COOKIE_PATHS) {
    document.cookie = `${TRANSPORT_COOKIE_NAME}=; Path=${path}; Max-Age=0; SameSite=Strict`;
    document.cookie = `${SAMPLE_COOKIE_NAME}=; Path=${path}; Max-Age=0; SameSite=Strict`;
  }
}

function browserSurface(): PlaybackDiagnosticRun['browserSurface'] {
  if (typeof window === 'undefined') return 'browser-tab';
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  if (
    standaloneNavigator.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  ) {
    return 'home-screen-pwa';
  }
  return 'browser-tab';
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
