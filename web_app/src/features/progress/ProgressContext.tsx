import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type {
  ProgressRecord,
  ProgressRepository,
} from '../../core/storage/progressRepository';

/**
 * Read-only access to the progress repository for components that only want
 * to display saved positions (the library row indicator). Writes happen
 * exclusively through ProgressService inside the player store, so this
 * context never exposes write methods.
 */
const ProgressContext = createContext<ProgressRepository | null>(null);

export function ProgressProvider({
  repository,
  children,
}: {
  repository: ProgressRepository;
  children: ReactNode;
}) {
  return (
    <ProgressContext.Provider value={repository}>
      {children}
    </ProgressContext.Provider>
  );
}

export function useProgressRepository(): ProgressRepository {
  const repo = useContext(ProgressContext);
  if (!repo) {
    throw new Error(
      'useProgressRepository must be used inside ProgressProvider',
    );
  }
  return repo;
}

export function useProgressRecord(mediaId: string): ProgressRecord | null {
  const repository = useProgressRepository();
  const cached = useRef<{
    mediaId: string;
    record: ProgressRecord | null;
  } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) =>
      repository.subscribe?.(mediaId, listener) ?? (() => {}),
    [mediaId, repository],
  );
  const getSnapshot = useCallback(() => {
    const next = repository.read(mediaId);
    const previous =
      cached.current?.mediaId === mediaId ? cached.current.record : null;
    const same = sameProgressRecord(previous, next);
    if (same) return previous;
    cached.current = { mediaId, record: next };
    return next;
  }, [mediaId, repository]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function sameProgressRecord(
  left: ProgressRecord | null,
  right: ProgressRecord | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.positionSec === right.positionSec &&
    left.durationSec === right.durationSec &&
    left.lastPlayedAt === right.lastPlayedAt &&
    left.source?.mediaType === right.source?.mediaType &&
    left.source?.name === right.source?.name &&
    left.source?.rootName === right.source?.rootName &&
    left.source?.relativePath === right.source?.relativePath
  );
}
