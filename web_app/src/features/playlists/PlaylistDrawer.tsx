import { useEffect, useMemo, useState } from 'react';

import type { LibraryItem } from '../../core/api/libraryClient';
import { contentKeyForLibraryItem } from '../../core/media/contentIdentity';
import { formatDuration } from '../library/formatLibraryItem';
import { ImageGlyph } from '../../core/ui/AppIcons';

export function PlaylistDrawer({
  editable = false,
  items,
  onClose,
  onPlayItem,
  onMoveItem,
  onRemoveItems,
  open,
  title,
}: {
  editable?: boolean;
  items: LibraryItem[];
  onClose: () => void;
  onPlayItem: (item: LibraryItem) => void;
  onMoveItem?: (contentKey: string, direction: 'up' | 'down') => void;
  onRemoveItems?: (contentKeys: readonly string[]) => void;
  open: boolean;
  playlistId?: string;
  title: string;
}) {
  const [editing, setEditing] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedCount = selectedKeys.size;
  const removableKeys = useMemo(
    () => items.map(contentKeyForLibraryItem),
    [items],
  );

  useEffect(() => {
    if (!open) {
      setEditing(false);
      setSelectedKeys(new Set());
      setConfirmDelete(false);
    }
  }, [open]);

  useEffect(() => {
    setSelectedKeys((current) => {
      const allowed = new Set(removableKeys);
      const next = new Set([...current].filter((key) => allowed.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [removableKeys]);

  if (!open) return null;

  const toggleSelected = (item: LibraryItem) => {
    const key = contentKeyForLibraryItem(item);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const confirmRemoveItems = () => {
    if (selectedKeys.size === 0) return;
    onRemoveItems?.([...selectedKeys]);
    setSelectedKeys(new Set());
    setEditing(false);
    setConfirmDelete(false);
  };

  return (
    <div
      data-testid="playlist-drawer-backdrop"
      className="fixed inset-0 z-[65] bg-black/30"
      onPointerDown={onClose}
    >
      <aside
        data-testid="playlist-drawer"
        data-glass
        data-no-menu-swipe
        aria-label={title}
        className="absolute bottom-0 left-0 top-0 flex w-[min(24rem,88vw)] flex-col border-r border-white/14 bg-[#111113]/94 text-white shadow-2xl shadow-black/60 backdrop-blur-[76px] [-webkit-backdrop-filter:saturate(1.35)_blur(76px)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{title}</h2>
            <p className="text-xs text-white/55">{items.length} items</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {editable && (
              <button
                type="button"
                data-testid="playlist-drawer-edit"
                aria-pressed={editing}
                className="inline-flex h-9 items-center justify-center rounded-full px-3 text-sm font-semibold text-white/65 hover:bg-white/10 hover:text-white aria-pressed:text-accent"
                onClick={() => {
                  setEditing((current) => !current);
                  setSelectedKeys(new Set());
                }}
              >
                Edit
              </button>
            )}
            {editable && editing && (
              <button
                type="button"
                data-testid="playlist-drawer-delete"
                disabled={selectedCount === 0}
                className="inline-flex h-9 items-center justify-center rounded-full px-3 text-sm font-semibold text-accent hover:bg-accent/10 disabled:opacity-45"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              aria-label="Close playlist"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-2xl text-white/70 hover:bg-white/10 hover:text-white"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>
        {items.length === 0 ? (
          <p
            data-testid="playlist-drawer-empty"
            className="px-5 py-5 text-sm text-white/55"
          >
            No items.
          </p>
        ) : (
          <ol className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {items.map((item, index) => (
              <li key={item.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={editing ? `Select ${item.name}` : `${item.type === 'image' ? 'Open' : 'Play'} ${item.name}`}
                  aria-pressed={editing ? selectedKeys.has(contentKeyForLibraryItem(item)) : undefined}
                  className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/10 aria-pressed:bg-accent/18"
                  onClick={() => {
                    if (editing) {
                      toggleSelected(item);
                      return;
                    }
                    onPlayItem(item);
                  }}
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-md bg-white/10 text-lg text-white/75">
                    {editing && selectedKeys.has(contentKeyForLibraryItem(item))
                      ? '✓'
                      : item.type === 'image'
                        ? <ImageGlyph className="h-5 w-5" />
                        : item.type === 'video'
                        ? '▶'
                        : '♪'}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {item.metadata?.title || item.name}
                    </span>
                    <span className="block truncate text-xs text-white/50">
                      {[item.metadata?.artist, item.metadata?.album].filter(Boolean).join(' · ') || item.rootName}
                    </span>
                  </span>
                  {item.type !== 'image' && (
                    <span className="text-xs tabular-nums text-white/45">
                      {formatDuration(item.metadata?.durationSec)}
                    </span>
                  )}
                </button>
                {editing && editable && (
                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${item.name} up`}
                      disabled={index === 0}
                      className="h-7 w-8 rounded text-sm hover:bg-white/10 disabled:opacity-30"
                      onClick={() => onMoveItem?.(contentKeyForLibraryItem(item), 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${item.name} down`}
                      disabled={index === items.length - 1}
                      className="h-7 w-8 rounded text-sm hover:bg-white/10 disabled:opacity-30"
                      onClick={() => onMoveItem?.(contentKeyForLibraryItem(item), 'down')}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {confirmDelete && (
          <div
            data-testid="playlist-drawer-confirm"
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 px-4"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <section
              data-glass
              className="w-full max-w-xs rounded-2xl border border-white/14 bg-[#111113]/96 p-4 shadow-2xl shadow-black/60 backdrop-blur-[76px]"
            >
              <h3 className="text-base font-semibold">Delete Items</h3>
              <p className="mt-2 text-sm text-white/60">
                Delete {selectedCount} selected items from this playlist?
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-full border border-white/14 px-4 text-sm font-semibold text-white/70 hover:bg-white/10"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="playlist-drawer-confirm-delete"
                  className="inline-flex h-10 items-center justify-center rounded-full bg-accent px-4 text-sm font-semibold text-white hover:bg-accent/85"
                  onClick={confirmRemoveItems}
                >
                  Delete
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
