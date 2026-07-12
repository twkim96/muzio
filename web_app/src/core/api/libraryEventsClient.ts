import {
  fetchLibraryChanges,
  type LibraryChangesResult,
  type LibraryMediaType,
} from './libraryClient';
import type { LibraryStores } from '../../features/library/LibraryContext';
import {
  playbackNetworkGate,
  type PlaybackNetworkGate,
} from '../playback/networkGate/playbackNetworkGate';

export interface LibraryRevisionEvent {
  revision: number;
  affectedTypes: LibraryMediaType[];
  reason: string;
}

interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
}

interface VisibilityDocument {
  hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface LibraryLiveSyncOptions {
  stores: LibraryStores;
  fetchChanges?: typeof fetchLibraryChanges;
  eventSourceFactory?: (url: string) => EventSourceLike;
  documentRef?: VisibilityDocument;
  hiddenCloseDelayMs?: number;
  retryBaseDelayMs?: number;
  retryMaxAttempts?: number;
  networkGate?: PlaybackNetworkGate;
}

const mediaTypes: LibraryMediaType[] = ['audio', 'video', 'image'];
type DeferredWorkPriority = 'run' | 'reload';

function deferredPriorityValue(priority: DeferredWorkPriority) {
  return priority === 'reload' ? 2 : 1;
}

export function startLibraryLiveSync({
  stores,
  fetchChanges = fetchLibraryChanges,
  eventSourceFactory = defaultEventSourceFactory(),
  documentRef = typeof document === 'undefined' ? undefined : document,
  hiddenCloseDelayMs = 60_000,
  retryBaseDelayMs = 1_000,
  retryMaxAttempts = 5,
  networkGate = playbackNetworkGate,
}: LibraryLiveSyncOptions): () => void {
  if (!eventSourceFactory) return () => {};

  const work = Object.fromEntries(
    mediaTypes.map((type) => [
      type,
      {
        pendingRevision: 0,
        running: false,
        retryAttempt: 0,
        retryTimer: null,
        deferUnsubscribe: null,
        deferredWork: null,
        deferredWorkPriority: null,
        epoch: 0,
        controller: null,
      },
    ]),
  ) as Record<
    LibraryMediaType,
    {
      pendingRevision: number;
      running: boolean;
      retryAttempt: number;
      retryTimer: ReturnType<typeof setTimeout> | null;
      deferUnsubscribe: (() => void) | null;
      deferredWork: (() => void) | null;
      deferredWorkPriority: DeferredWorkPriority | null;
      epoch: number;
      controller: AbortController | null;
    }
  >;
  let source: EventSourceLike | null = null;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clearRetry = (type: LibraryMediaType) => {
    const task = work[type];
    if (task.retryTimer !== null) {
      clearTimeout(task.retryTimer);
      task.retryTimer = null;
    }
  };
  const clearDefer = (type: LibraryMediaType) => {
    const task = work[type];
    if (task.deferUnsubscribe !== null) {
      task.deferUnsubscribe();
      task.deferUnsubscribe = null;
    }
    task.deferredWork = null;
    task.deferredWorkPriority = null;
  };
  const deferWork = (
    type: LibraryMediaType,
    priority: DeferredWorkPriority,
    workFn: () => void,
  ) => {
    const task = work[type];
    if (stopped) return;
    if (
      task.deferredWorkPriority !== null &&
      deferredPriorityValue(task.deferredWorkPriority) > deferredPriorityValue(priority)
    ) {
      return;
    }
    task.deferredWork = workFn;
    task.deferredWorkPriority = priority;
    if (task.deferUnsubscribe !== null) return;
    task.deferUnsubscribe = networkGate.subscribe(() => {
      if (
        stopped ||
        documentRef?.hidden ||
        networkGate.shouldDefer('library-live-sync', 'resume')
      ) {
        return;
      }
      const deferredWork = task.deferredWork;
      clearDefer(type);
      deferredWork?.();
    });
  };
  const deferRun = (type: LibraryMediaType) => {
    deferWork(type, 'run', () => {
      void run(type);
    });
  };
  const loadPreservingResult = (type: LibraryMediaType) => {
    if (stopped || documentRef?.hidden) return;
    if (networkGate.shouldDefer('library-live-sync', 'connected-reload')) {
      deferWork(type, 'reload', () => loadPreservingResult(type));
      return;
    }
    clearDefer(type);
    void stores[type].getState().load({ preserveResult: true });
  };
  const scheduleRetry = (type: LibraryMediaType) => {
    const task = work[type];
    if (
      stopped ||
      documentRef?.hidden ||
      task.retryTimer !== null
    ) {
      return;
    }
    if (networkGate.shouldDefer('library-live-sync', 'retry')) {
      deferRun(type);
      return;
    }
    const exponent = Math.min(task.retryAttempt, Math.max(retryMaxAttempts - 1, 0));
    const delay = retryBaseDelayMs * 2 ** exponent;
    task.retryAttempt = Math.min(task.retryAttempt + 1, retryMaxAttempts);
    task.retryTimer = setTimeout(() => {
      task.retryTimer = null;
      void run(type);
    }, delay);
  };
  const run = async (type: LibraryMediaType) => {
    const task = work[type];
    if (task.running || documentRef?.hidden) return;
    if (networkGate.shouldDefer('library-live-sync', 'run')) {
      deferRun(type);
      return;
    }
    clearDefer(type);
    task.running = true;
    const store = stores[type];
    try {
      while (!stopped) {
        const state = store.getState();
        if (state.result?.kind !== 'ok') {
          state.markStale(task.pendingRevision);
          return;
        }
        if (task.pendingRevision <= state.revision) return;
        const epoch = task.epoch;
        const controller = new AbortController();
        task.controller = controller;
        const changes = await fetchChanges(type, state.revision, {
          signal: controller.signal,
        });
        if (task.controller === controller) task.controller = null;
        if (epoch !== task.epoch) return;
        if (changes.kind !== 'ok') {
          store.getState().markStale(task.pendingRevision);
          scheduleRetry(type);
          return;
        }
        const beforeRevision = state.revision;
        await applyLibraryChanges(store, changes);
        if (store.getState().revision <= beforeRevision) {
          store.getState().markStale(task.pendingRevision);
          scheduleRetry(type);
          return;
        }
        task.retryAttempt = 0;
        clearRetry(type);
      }
    } finally {
      task.running = false;
      const state = stores[type].getState();
      if (
        !stopped &&
        !documentRef?.hidden &&
        task.retryTimer === null &&
        state.result?.kind === 'ok' &&
        task.pendingRevision > state.revision
      ) {
        void run(type);
      }
    }
  };

  const receive = (raw: MessageEvent<string>) => {
    const event = parseLibraryRevisionEvent(raw.data);
    if (event === null) return;
    for (const type of event.affectedTypes) {
      const task = work[type];
      const state = stores[type].getState();
      if (event.reason === 'connected' && event.revision < state.revision) {
        task.epoch += 1;
        task.pendingRevision = event.revision;
        task.retryAttempt = 0;
        task.controller?.abort();
        task.controller = null;
        clearRetry(type);
        clearDefer(type);
        loadPreservingResult(type);
        continue;
      }
      if (event.reason === 'connected') {
        task.retryAttempt = 0;
        clearRetry(type);
      }
      task.pendingRevision = Math.max(task.pendingRevision, event.revision);
      if (state.result?.kind !== 'ok') {
        state.markStale(event.revision);
        continue;
      }
      if (task.retryTimer === null) {
        void run(type);
      }
    }
  };

  const connect = () => {
    if (stopped || source !== null || documentRef?.hidden) return;
    source = eventSourceFactory('/api/library/events');
    source.addEventListener('library', receive);
  };
  const disconnect = () => {
    source?.close();
    source = null;
  };
  const visibilityChanged = () => {
    if (documentRef?.hidden) {
      for (const type of mediaTypes) {
        clearRetry(type);
        clearDefer(type);
        work[type].controller?.abort();
        work[type].controller = null;
      }
      if (hiddenTimer === null) {
        hiddenTimer = setTimeout(() => {
          hiddenTimer = null;
          disconnect();
        }, hiddenCloseDelayMs);
      }
      return;
    }
    if (hiddenTimer !== null) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
    connect();
    for (const type of mediaTypes) {
      work[type].retryAttempt = 0;
      if (work[type].pendingRevision > stores[type].getState().revision) {
        void run(type);
      }
    }
  };

  const unsubscribeStores = mediaTypes.map((type) =>
    stores[type].subscribe((state) => {
      if (
        state.result?.kind === 'ok' &&
        work[type].pendingRevision > state.revision
      ) {
        void run(type);
      }
    }),
  );
  documentRef?.addEventListener('visibilitychange', visibilityChanged);
  connect();
  return () => {
    stopped = true;
    if (hiddenTimer !== null) clearTimeout(hiddenTimer);
    for (const type of mediaTypes) {
      clearRetry(type);
      clearDefer(type);
      work[type].controller?.abort();
      work[type].controller = null;
    }
    for (const unsubscribe of unsubscribeStores) unsubscribe();
    documentRef?.removeEventListener('visibilitychange', visibilityChanged);
    disconnect();
  };
}

async function applyLibraryChanges(
  store: LibraryStores[LibraryMediaType],
  changes: Extract<LibraryChangesResult, { kind: 'ok' }>,
) {
  if (changes.resetRequired) {
    await store.getState().load({ preserveResult: true });
    return;
  }
  store.getState().applyChanges(changes);
}

export function parseLibraryRevisionEvent(
  data: string,
): LibraryRevisionEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0 ||
    !Array.isArray(raw.affectedTypes)
  ) {
    return null;
  }
  const affectedTypes = raw.affectedTypes.filter(
    (value): value is LibraryMediaType =>
      value === 'audio' || value === 'video' || value === 'image',
  );
  if (affectedTypes.length === 0) return null;
  return {
    revision: raw.revision,
    affectedTypes: [...new Set(affectedTypes)],
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  };
}

function defaultEventSourceFactory():
  | ((url: string) => EventSourceLike)
  | undefined {
  if (typeof EventSource === 'undefined') return undefined;
  return (url) => new EventSource(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
