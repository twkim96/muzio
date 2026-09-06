import { ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { useEffect, useMemo, useState } from 'react';

import type { LibraryItem } from '../../core/api/libraryClient';
import { contentKeyForLibraryItem } from '../../core/media/contentIdentity';
import { formatDuration } from '../library/formatLibraryItem';
import { CloseGlyph, ImageGlyph } from '../../core/ui/AppIcons';
import { GlassModal } from '../../core/ui/GlassModal';

export function PlaylistDrawer({
  editable = false,
  items,
  onClose,
  onBack,
  onPlayItem,
  onMoveItem,
  onRemoveItems,
  open,
  title,
}: {
  editable?: boolean;
  items: LibraryItem[];
  onClose: () => void;
  onBack?: () => void;
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
        className="muzio-sidebar muzio-side-sheet flex flex-col overflow-hidden px-5 py-5 text-foreground"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex shrink-0 flex-col items-start gap-3">
          <div className="flex w-full items-center justify-between gap-3">
          <h2 className="muzio-sheet-title h-[46.4px] min-w-0 flex-1 [--title-scale:1.45] sm:[--title-scale:1.16]">
            <button
              type="button"
              aria-label="Close playlist"
              title={title}
              onClick={onClose}
              className="muzio-title relative flex h-8 w-fit max-w-[calc(100%/var(--title-scale))] origin-top-left scale-[var(--title-scale)] items-center px-4 text-left text-lg font-semibold tracking-tight sm:h-10 sm:text-xl"
            >
              <span className="min-w-0 truncate scale-[calc(1/var(--title-scale))]">{title}</span>
            </button>
          </h2>
          <button type="button" aria-label={onBack ? 'Back to navigation' : 'Close playlist panel'} onClick={onBack ?? onClose} className="muzio-sheet-header-action muzio-settings-button flex h-[46.4px] w-[46.4px] shrink-0 items-center justify-center text-foreground">
            {onBack ? <ArrowLeft aria-hidden className="h-[21.1px] w-[21.1px]" /> : <CloseGlyph aria-hidden className="h-[21.1px] w-[21.1px]" />}
          </button>
          </div>
          <div className="flex min-h-12 w-full min-w-0 flex-wrap items-center gap-2">
            <p className="mr-auto text-sm text-muted">{items.length} items</p>
            {editable && (
              <button
                type="button"
                data-testid="playlist-drawer-edit"
                aria-pressed={editing}
                className="muzio-glass-action muzio-glass-action-secondary aria-pressed:text-accent"
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
                className="muzio-glass-action disabled:opacity-45"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
        </div>
        {items.length === 0 ? (
          <p
            data-testid="playlist-drawer-empty"
            className="py-5 text-sm text-muted"
          >
            No items.
          </p>
        ) : (
          <ol data-allow-scroll className="scrollbar-none -mx-2 min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
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
                  <span className="flex h-11 w-11 items-center justify-center rounded-md bg-white/10 text-lg text-muted">
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
                    <span className="block truncate text-xs text-muted">
                      {[item.metadata?.artist, item.metadata?.album].filter(Boolean).join(' · ') || item.rootName}
                    </span>
                  </span>
                  {item.type !== 'image' && (
                    <span className="text-xs tabular-nums text-muted">
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
      </aside>
      {confirmDelete && (
        <GlassModal
          testId="playlist-drawer-confirm"
          title="Delete Items"
          onClose={() => setConfirmDelete(false)}
          alert
          footer={
            <>
              <button
                type="button"
                className="muzio-glass-action muzio-glass-action-secondary"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="playlist-drawer-confirm-delete"
                className="muzio-glass-action"
                onClick={confirmRemoveItems}
              >
                Delete
              </button>
            </>
          }
        >
          Delete {selectedCount} selected items from this playlist?
        </GlassModal>
      )}
    </div>
  );
}
