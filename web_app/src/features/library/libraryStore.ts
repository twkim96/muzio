import { create } from 'zustand';

import {
  fetchLibrary,
  type LibraryChangesResult,
  type LibraryFetchOptions,
  type LibraryFetchResult,
  type LibraryItem,
  type LibraryMediaType,
  type LibraryThumbnail,
} from '../../core/api/libraryClient';

const modifiedTimeCache = new WeakMap<LibraryItem, number>();

/**
 * Library list state for a single media type.
 *
 * Successful results stay in newest-first order. Delta updates preserve that
 * invariant so the default view can filter without sorting the full library
 * again after every filesystem change.
 *
 * The store is created once per type so the music and video screens never
 * leak state into each other and so a Phase 11 metadata refresh can
 * invalidate one type without touching the other.
 */
export type LibraryStatus = 'idle' | 'loading' | 'ok' | 'error';

export interface LibraryState {
  status: LibraryStatus;
  result: LibraryFetchResult | null;
  revision: number;
  etag?: string;
  stale: boolean;
  staleRevision: number;
  presentation: ReadonlyMap<string, LibraryThumbnail>;
  load: (options?: { preserveResult?: boolean }) => Promise<void>;
  applyChanges: (
    changes: Extract<LibraryChangesResult, { kind: 'ok' }>,
  ) => void;
  markStale: (revision: number) => void;
  reset: () => void;
}

export interface LibraryStoreOptions {
  type: LibraryMediaType;
  fetcher?: typeof fetchLibrary;
  fetchOptions?: LibraryFetchOptions;
  snapshotCache?: LibrarySnapshotCache | null;
}

export interface LibrarySnapshot {
  revision: number;
  etag?: string;
  complete: boolean;
  items: LibraryItem[];
}

export interface LibrarySnapshotCache {
  read(): LibrarySnapshot | null;
  write(snapshot: LibrarySnapshot): void;
  clear(): void;
}

export function createLibraryStore({
  type,
  fetcher = fetchLibrary,
  fetchOptions,
  snapshotCache = null,
}: LibraryStoreOptions) {
  let loadGeneration = 0;
  const cachedSnapshot = snapshotCache?.read() ?? null;
  let snapshotComplete = cachedSnapshot?.complete ?? false;
  const cachedResult =
    cachedSnapshot === null
      ? null
      : normalizeLatestResult({
          kind: 'ok',
          items: cachedSnapshot.items,
          revision: cachedSnapshot.revision,
          etag: cachedSnapshot.etag,
        });
  let itemIndex =
    cachedResult === null
      ? new Map<string, LibraryItem>()
      : indexItems(cachedResult.items);
  let presentation =
    cachedResult === null
      ? new Map<string, LibraryThumbnail>()
      : indexPresentation(cachedResult.items);
  return create<LibraryState>((set, get) => ({
    status: cachedResult === null ? 'idle' : 'ok',
    result: cachedResult,
    revision: cachedResult?.revision ?? 0,
    etag: cachedResult?.etag,
    stale: cachedResult !== null,
    staleRevision: cachedResult?.revision ?? 0,
    presentation,

    async load(options = {}) {
      const generation = ++loadGeneration;
      const previous = get();
      set((current) => ({
        status: 'loading',
        result: options.preserveResult ? current.result : null,
      }));
      const result = await fetcher(type, {
        ...fetchOptions,
        ifNoneMatch:
          options.preserveResult && snapshotComplete
            ? previous.etag
            : undefined,
      });
      if (generation !== loadGeneration) return;
      const current = get();
      if (result.kind === 'notModified') {
        if (!snapshotComplete) {
          set({
            status: 'error',
            result: previous.result,
            revision: previous.revision,
            etag: undefined,
            stale: true,
          });
          return;
        }
        if (current.revision !== previous.revision) return;
        const revision = result.revision ?? previous.revision;
        set({
          status: previous.result?.kind === 'ok' ? 'ok' : 'idle',
          result: previous.result,
          revision,
          etag: result.etag ?? previous.etag,
          stale: current.staleRevision > revision,
        });
        return;
      }
      if (result.kind !== 'ok' && options.preserveResult) {
        if (current.revision !== previous.revision) return;
        set({
          status: 'error',
          result: previous.result,
          revision: previous.revision,
          etag: previous.etag,
          stale: true,
        });
        return;
      }
      if (
        result.kind === 'ok' &&
        current.revision !== previous.revision &&
        (result.revision === undefined || result.revision < current.revision)
      ) {
        return;
      }
      const revision =
        result.kind === 'ok' ? (result.revision ?? previous.revision) : previous.revision;
      const normalizedResult =
        result.kind === 'ok'
          ? normalizeLatestResult(result)
          : result;
      if (normalizedResult.kind === 'ok') {
        snapshotComplete = true;
        itemIndex = indexItems(normalizedResult.items);
        presentation = indexPresentation(normalizedResult.items);
        snapshotCache?.write({
          revision,
          etag: normalizedResult.etag,
          complete: true,
          items: normalizedResult.items,
        });
      }
      set({
        status: result.kind === 'ok' ? 'ok' : 'error',
        result: normalizedResult,
        revision,
        etag: result.kind === 'ok' ? result.etag : previous.etag,
        stale: result.kind !== 'ok' || current.staleRevision > revision,
        presentation,
      });
    },

    applyChanges(changes) {
      set((current) => {
        if (changes.revision <= current.revision) {
          return current;
        }
        if (current.result?.kind !== 'ok') {
          return {
            ...current,
            stale: true,
            staleRevision: Math.max(current.staleRevision, changes.revision),
          };
        }
        const semanticUpserts: LibraryItem[] = [];
        let presentationChanged = false;
        for (const item of changes.upserts) {
          const existing = itemIndex.get(item.id);
          if (existing === undefined || !sameSemanticItem(existing, item)) {
            semanticUpserts.push(item);
          }
          if (!sameThumbnail(presentation.get(item.id), item.thumbnail)) {
            if (item.thumbnail === undefined) {
              presentation.delete(item.id);
            } else {
              presentation.set(item.id, item.thumbnail);
            }
            presentationChanged = true;
          }
        }
        for (const mediaId of changes.deletedIds) {
          if (presentation.delete(mediaId)) presentationChanged = true;
        }
        const semanticChanged =
          semanticUpserts.length > 0 || changes.deletedIds.length > 0;
        const items = semanticChanged
          ? mergeLibraryChanges(
              current.result.items,
              semanticUpserts,
              changes.deletedIds,
            )
            : current.result.items;
        if (semanticChanged) itemIndex = indexItems(items);
        const nextResult = semanticChanged
          ? {
              ...current.result,
              items,
              revision: changes.revision,
              etag: changes.etag ?? current.etag,
            }
          : current.result;
        snapshotCache?.write({
          revision: changes.revision,
          etag: changes.etag ?? current.etag,
          complete: snapshotComplete,
          items: nextResult.items,
        });
        return {
          ...current,
          status: 'ok',
          result: nextResult,
          revision: changes.revision,
          etag: changes.etag ?? current.etag,
          stale: current.staleRevision > changes.revision,
          ...(presentationChanged ? { presentation } : {}),
        };
      });
    },

    markStale(revision) {
      set((current) =>
        revision <= current.revision
          ? current
          : {
              ...current,
              stale: true,
              staleRevision: Math.max(current.staleRevision, revision),
            },
      );
    },

    reset() {
      loadGeneration += 1;
      snapshotComplete = false;
      itemIndex = new Map();
      presentation = new Map();
      snapshotCache?.clear();
      set({
        status: 'idle',
        result: null,
        revision: 0,
        etag: undefined,
        stale: false,
        staleRevision: 0,
        presentation,
      });
    },
  }));
}

function mergeLibraryChanges(
  current: readonly LibraryItem[],
  upserts: readonly LibraryItem[],
  deletedIds: readonly string[],
): LibraryItem[] {
  const changedIds = new Set(deletedIds);
  for (const item of upserts) changedIds.add(item.id);
  const retained = current.filter((item) => !changedIds.has(item.id));
  if (upserts.length === 0) return retained;

  const additions = [...upserts].sort(compareLatestLibraryItems);
  const merged = new Array<LibraryItem>(retained.length + additions.length);
  let retainedIndex = 0;
  let additionIndex = 0;
  let mergedIndex = 0;
  while (retainedIndex < retained.length && additionIndex < additions.length) {
    if (
      compareLatestLibraryItems(
        retained[retainedIndex],
        additions[additionIndex],
      ) <= 0
    ) {
      merged[mergedIndex++] = retained[retainedIndex++];
    } else {
      merged[mergedIndex++] = additions[additionIndex++];
    }
  }
  while (retainedIndex < retained.length) {
    merged[mergedIndex++] = retained[retainedIndex++];
  }
  while (additionIndex < additions.length) {
    merged[mergedIndex++] = additions[additionIndex++];
  }
  return merged;
}

function compareLatestLibraryItems(
  left: LibraryItem,
  right: LibraryItem,
): number {
  return (
    modifiedTime(right) - modifiedTime(left) ||
    left.rootName.localeCompare(right.rootName) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function normalizeLatestResult(
  result: Extract<LibraryFetchResult, { kind: 'ok' }>,
): Extract<LibraryFetchResult, { kind: 'ok' }> {
  for (let index = 1; index < result.items.length; index += 1) {
    if (
      compareLatestLibraryItems(result.items[index - 1], result.items[index]) > 0
    ) {
      return {
        ...result,
        items: [...result.items].sort(compareLatestLibraryItems),
      };
    }
  }
  return result;
}

function modifiedTime(item: LibraryItem): number {
  const cached = modifiedTimeCache.get(item);
  if (cached !== undefined) return cached;
  const value = Date.parse(item.modifiedAt);
  modifiedTimeCache.set(item, value);
  return value;
}

function indexItems(items: readonly LibraryItem[]): Map<string, LibraryItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function indexPresentation(
  items: readonly LibraryItem[],
): Map<string, LibraryThumbnail> {
  const indexed = new Map<string, LibraryThumbnail>();
  for (const item of items) {
    if (item.thumbnail !== undefined) indexed.set(item.id, item.thumbnail);
  }
  return indexed;
}

function sameSemanticItem(left: LibraryItem, right: LibraryItem): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.rootName === right.rootName &&
    left.relativePath === right.relativePath &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt &&
    sameMetadata(left.metadata, right.metadata) &&
    sameSubtitles(left.subtitles, right.subtitles)
  );
}

function sameMetadata(
  left: LibraryItem['metadata'],
  right: LibraryItem['metadata'],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.title === right.title &&
    left.artist === right.artist &&
    left.album === right.album &&
    left.season === right.season &&
    left.episode === right.episode &&
    left.year === right.year &&
    left.durationSec === right.durationSec
  );
}

function sameSubtitles(
  left: LibraryItem['subtitles'],
  right: LibraryItem['subtitles'],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((subtitle, index) => {
    const candidate = right[index];
    return (
      subtitle.relativePath === candidate.relativePath &&
      subtitle.language === candidate.language &&
      subtitle.label === candidate.label
    );
  });
}

function sameThumbnail(
  left: LibraryThumbnail | undefined,
  right: LibraryThumbnail | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.url === right.url &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.cacheKey === right.cacheKey
  );
}

export type LibraryStoreApi = ReturnType<typeof createLibraryStore>;
