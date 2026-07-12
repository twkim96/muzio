import { describe, expect, test } from 'vitest';
import type { CSSProperties } from 'react';

import type { LibraryItem } from '../../core/api/libraryClient';
import { rowPropsEqual } from './LibraryItemRow';

function item(patch: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: patch.id ?? 'id',
    type: patch.type ?? 'audio',
    rootName: 'root',
    relativePath: patch.relativePath ?? patch.name ?? 'song.mp3',
    name: patch.name ?? 'song.mp3',
    sizeBytes: patch.sizeBytes ?? 1,
    modifiedAt: patch.modifiedAt ?? '2026-06-01T00:00:00Z',
    metadata: patch.metadata,
    thumbnail: patch.thumbnail,
    subtitles: patch.subtitles,
  };
}

type RowProps = Parameters<typeof rowPropsEqual>[0];

function props(patch: Partial<RowProps> = {}): RowProps {
  const style: CSSProperties = {
    height: 54,
    transform: 'translateY(0px)',
    position: 'absolute',
  };
  return {
    item: item(),
    queueItems: [],
    onLongPress: () => {},
    onOpenAddToPlaylist: () => {},
    onToggleSelected: () => {},
    selected: false,
    selectionMode: false,
    style,
    ...patch,
  } as RowProps;
}

describe('rowPropsEqual', () => {
  test('treats a freshly built style object with equal layout as unchanged', () => {
    const base = props();
    // The virtualized list rebuilds `style` every render; a new object with the
    // same height/transform must not force a re-render.
    const next = props({
      item: base.item,
      queueItems: base.queueItems,
      onLongPress: base.onLongPress,
      onOpenAddToPlaylist: base.onOpenAddToPlaylist,
      onToggleSelected: base.onToggleSelected,
      style: { height: 54, transform: 'translateY(0px)', position: 'absolute' },
    });

    expect(base.style).not.toBe(next.style);
    expect(rowPropsEqual(base, next)).toBe(true);
  });

  test('re-renders when the row moves to a new transform', () => {
    const base = props();
    const next = props({
      item: base.item,
      queueItems: base.queueItems,
      onLongPress: base.onLongPress,
      onOpenAddToPlaylist: base.onOpenAddToPlaylist,
      onToggleSelected: base.onToggleSelected,
      style: { height: 54, transform: 'translateY(108px)' },
    });

    expect(rowPropsEqual(base, next)).toBe(false);
  });

  test('re-renders when the underlying item, selection, or handler changes', () => {
    const base = props();
    expect(rowPropsEqual(base, props({ ...base, item: item({ id: 'other' }) }))).toBe(
      false,
    );
    expect(rowPropsEqual(base, props({ ...base, selected: true }))).toBe(false);
    expect(
      rowPropsEqual(base, props({ ...base, onToggleSelected: () => {} })),
    ).toBe(false);
  });
});
