import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

import type { LibraryItem } from '../core/api/libraryClient';
import { refreshMediaRoots, type MediaRootsResult } from '../core/api/mediaRootsClient';
import {
  isPlayableLibraryItem,
  playbackSourceFromLibraryItem,
  type PlaybackSource,
} from '../core/playback/source/source';
import type { LibraryState } from '../features/library/libraryStore';
import { useLibraryLiveSync } from '../features/library/useLibraryLiveSync';
import { QueueDrawer } from '../features/player/QueueDrawer';
import { usePlayerStore } from '../features/player/PlayerContext';
import { usePlayerOverlay } from '../features/player/PlayerOverlayContext';
import { PlaylistDrawer } from '../features/playlists/PlaylistDrawer';
import { usePlaylists } from '../features/playlists/PlaylistContext';
import {
  buildSmartCollections,
  buildImageCollections,
  mapItemsByContentKey,
  resolvePlaylistItemsFromIndex,
} from '../features/playlists/smartCollections';
import { backgroundLocationFrom } from './backgroundLocation';

const primaryTabs = [
  { to: '/library/music', label: 'Music', match: '/library/music' },
  { to: '/library/video', label: 'Video', match: '/library/video' },
  { to: '/library/image', label: 'Image', match: '/library/image' },
  { to: '/settings', label: 'Setting', match: '/settings' },
] as const;

const sideSections = {
  music: {
    title: 'Music',
    to: '/library/music',
    items: ['Liked Music', 'Most Played'],
  },
  video: {
    title: 'Video',
    to: '/library/video',
    items: ['Recently Watching'],
  },
  image: {
    title: 'Image',
    to: '/library/image',
    items: ['Favorites', 'Recently Added', 'Screenshots', 'Downloads'],
  },
  settings: {
    title: 'Settings',
    to: '/settings',
    items: ['Appearance', 'Backend Status', 'Media Folders', 'Runtime Notes'],
  },
} as const;

interface PlaylistMenuEntry {
  id: string;
  kind: 'automatic' | 'custom';
  playlistId?: string;
  title: string;
  count: number;
  items: LibraryItem[];
}

const EMPTY_LIBRARY_ITEMS: LibraryItem[] = [];

export function AppShell({ children }: { children: ReactNode }) {
  usePreventPullToRefresh();
  const libraryStores = useLibraryLiveSync();
  const playlists = usePlaylists();
  const playerStore = usePlayerStore();
  const likedMediaIds = playerStore((state) => state.likedMediaIds);
  const activityRecords = playerStore((state) => state.activityRecords);
  const playMusicQueue = playerStore((state) => state.playMusicQueue);
  const playSource = playerStore((state) => state.playSource);
  const playerOverlay = usePlayerOverlay();
  const audioItems = libraryStores.audio(itemsFromLibraryState);
  const videoItems = libraryStores.video(itemsFromLibraryState);
  const imageItems = libraryStores.image(itemsFromLibraryState);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [playlistDrawer, setPlaylistDrawer] = useState<{
    kind: 'automatic' | 'custom';
    playlistId?: string;
    title: string;
    items: LibraryItem[];
  } | null>(null);
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [menuEditing, setMenuEditing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<PlaylistMenuEntry | null>(null);
  const [renamePlaylistName, setRenamePlaylistName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<PlaylistMenuEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const location = useLocation();
  const navigate = useNavigate();
  const shellLocation = backgroundLocationFrom(location) ?? location;
  const isPlayerRoute = shellLocation.pathname.startsWith('/player');
  const isImageViewerRoute = shellLocation.pathname.startsWith('/image/');
  const isImmersiveRoute = isPlayerRoute || isImageViewerRoute;
  const section = sectionForPath(shellLocation.pathname);
  const sidebar = section === null ? null : sideSections[section];
  const hasMobileMenu = sidebar !== null;
  const canCreatePlaylist = section === 'music' || section === 'video';
  const playableItems = useMemo(
    () => [...audioItems, ...videoItems].filter(isPlayableLibraryItem),
    [audioItems, videoItems],
  );
  const playableItemIndex = useMemo(
    () => mapItemsByContentKey(playableItems),
    [playableItems],
  );
  const smartCollections = useMemo(
    () =>
      buildSmartCollections({
        items: playableItems,
        likedKeys: likedMediaIds,
        activityRecords,
        itemIndex: playableItemIndex,
      }),
    [activityRecords, likedMediaIds, playableItemIndex, playableItems],
  );
  const imageCollections = useMemo(
    () => buildImageCollections({ items: imageItems, likedKeys: likedMediaIds }),
    [imageItems, likedMediaIds],
  );
  const playlistEntries = useMemo(() => {
    if (section === 'image') {
      return imageCollections.map((collection) => ({
        id: `auto:${collection.id}`,
        kind: 'automatic' as const,
        title: collection.title,
        count: collection.items.length,
        items: collection.items,
      }));
    }
    if (section !== 'music' && section !== 'video') return [];
    const automaticIds =
      section === 'music' ? ['liked-music', 'most-played'] : ['recently-watching'];
    return [
      ...automaticIds
        .map((id) => smartCollections.find((collection) => collection.id === id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
        .map((collection) => ({
          id: `auto:${collection.id}`,
          kind: 'automatic' as const,
          title: collection.title,
          count: collection.items.length,
          items: collection.items,
        })),
      ...playlists.playlists.map((playlist) => {
        const items = resolvePlaylistItemsFromIndex(
          playlist,
          playableItemIndex,
        );
        return {
          id: `custom:${playlist.id}`,
          kind: 'custom' as const,
          playlistId: playlist.id,
          title: playlist.name,
          count: items.length,
          items,
        };
      }),
    ];
  }, [imageCollections, playableItemIndex, playlists.playlists, section, smartCollections]);
  const shellStyle = {
    '--app-sidebar-width': sidebar === null ? '0px' : '18rem',
    '--mobile-drawer-top': hasMobileMenu ? '13.75rem' : '6.25rem',
    '--mobile-drawer-open-top': hasMobileMenu ? '10.75rem' : '5.5rem',
  } as CSSProperties;
  const menuSwipeHandlers = useLeftToRightMenuSwipe({
    enabled: hasMobileMenu && !isImmersiveRoute && !drawerOpen,
    onOpen: () => setDrawerOpen(true),
  });

  const handleRefreshLibraries = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMessage('');
    try {
      const result = await refreshMediaRoots();
      if (result.kind !== 'ok') {
        setRefreshMessage(describeRefreshError(result));
        return;
      }
      await Promise.all([
        libraryStores.audio.getState().load({ preserveResult: true }),
        libraryStores.video.getState().load({ preserveResult: true }),
        libraryStores.image.getState().load({ preserveResult: true }),
      ]);
      setRefreshMessage(
        `Refreshed ${result.settings.itemCount ?? 0} items.${describeRefreshWarnings(
          result.settings,
        )}`,
      );
    } finally {
      setRefreshing(false);
    }
  };
  const openPlaylist = (entry: PlaylistMenuEntry) => {
    setPlaylistDrawer({
      kind: entry.kind,
      playlistId: entry.playlistId,
      title: entry.title,
      items: entry.items,
    });
    setDrawerOpen(false);
  };
  const createPlaylist = () => {
    if (newPlaylistName.trim() === '') return;
    playlists.createPlaylist(newPlaylistName);
    setNewPlaylistName('');
    setCreatePlaylistOpen(false);
  };
  const openRenamePlaylist = (entry: PlaylistMenuEntry) => {
    if (entry.kind !== 'custom') return;
    setRenameTarget(entry);
    setRenamePlaylistName(entry.title);
  };
  const submitRenamePlaylist = () => {
    if (renameTarget?.playlistId === undefined) return;
    playlists.renamePlaylist(renameTarget.playlistId, renamePlaylistName);
    setRenameTarget(null);
    setRenamePlaylistName('');
  };
  const submitDeletePlaylist = () => {
    if (deleteTarget?.playlistId === undefined) return;
    playlists.deletePlaylist(deleteTarget.playlistId);
    if (playlistDrawer?.playlistId === deleteTarget.playlistId) {
      setPlaylistDrawer(null);
    }
    setDeleteTarget(null);
  };
  const removePlaylistItems = (contentKeys: readonly string[]) => {
    const playlistId = playlistDrawer?.playlistId;
    if (playlistId === undefined) return;
    const nextPlaylists = playlists.removeItems(playlistId, contentKeys);
    const nextPlaylist = nextPlaylists.find((playlist) => playlist.id === playlistId);
    if (nextPlaylist === undefined) {
      setPlaylistDrawer(null);
      return;
    }
    setPlaylistDrawer((current) => {
      if (current === null) return null;
      return {
        ...current,
        items: resolvePlaylistItemsFromIndex(nextPlaylist, playableItemIndex),
      };
    });
  };
  const movePlaylistItem = (
    contentKey: string,
    direction: 'up' | 'down',
  ) => {
    const playlistId = playlistDrawer?.playlistId;
    if (playlistId === undefined) return;
    const nextPlaylist = playlists
      .moveItem(playlistId, contentKey, direction)
      .find((playlist) => playlist.id === playlistId);
    if (nextPlaylist === undefined) return;
    setPlaylistDrawer((current) => current === null ? null : {
      ...current,
      items: resolvePlaylistItemsFromIndex(nextPlaylist, playableItemIndex),
    });
  };
  const playPlaylistItem = (item: LibraryItem) => {
    const playlistItems = playlistDrawer?.items ?? [];
    setPlaylistDrawer(null);
    if (item.type === 'image') {
      navigate(`/image/${encodeURIComponent(item.id)}`, {
        state: { backgroundLocation: shellLocation },
      });
      return;
    }
    if (!isPlayableLibraryItem(item)) return;
    if (item.type === 'audio') {
      const audioSources: PlaybackSource[] = [];
      for (const candidate of playlistItems) {
        if (!isPlayableLibraryItem(candidate) || candidate.type !== 'audio') {
          continue;
        }
        audioSources.push(playbackSourceFromLibraryItem(candidate));
      }
      if (audioSources.length === 0) return;
      void playMusicQueue(audioSources, item.id);
      return;
    }
    void playSource(playbackSourceFromLibraryItem(item));
    playerOverlay.open();
  };

  return (
    <div
      style={shellStyle}
      className="min-h-screen bg-zinc-50 text-zinc-950 transition-colors dark:bg-surface dark:text-foreground"
    >
      <div
        className={
          sidebar === null
            ? 'min-h-screen'
            : 'lg:grid lg:min-h-screen lg:grid-cols-[var(--app-sidebar-width)_minmax(0,1fr)]'
        }
      >
        {sidebar !== null && (
          <aside className="hidden p-3 pr-0 lg:block">
            <nav
              aria-label={`${sidebar.title} navigation`}
              data-glass
              className="sticky top-3 flex h-[calc(100vh-1.5rem)] flex-col rounded-2xl border border-zinc-200/70 bg-white/64 px-5 py-7 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.055]"
            >
              <SidebarContent
                canCreatePlaylist={canCreatePlaylist}
                editing={menuEditing}
                onCreatePlaylist={() => setCreatePlaylistOpen(true)}
                onDeletePlaylist={setDeleteTarget}
                onEditToggle={() => setMenuEditing((editing) => !editing)}
                onOpenPlaylist={openPlaylist}
                onOpenQueue={() => setQueueOpen(true)}
                onRenamePlaylist={openRenamePlaylist}
                onRefreshLibraries={() => void handleRefreshLibraries()}
                playlistEntries={playlistEntries}
                refreshBusy={refreshing}
                refreshMessage={refreshMessage}
                sidebar={sidebar}
              />
            </nav>
          </aside>
        )}

        <div className="min-w-0">
          {!isImmersiveRoute && (
            <header className="app-top-fade sticky top-0 z-30 px-4 py-3">
              <div className="relative flex h-11 items-center justify-center">
                <SegmentedTabs />
              </div>
            </header>
          )}

          {sidebar !== null && !isImmersiveRoute && (
            <MobilePeekDrawer
              canCreatePlaylist={canCreatePlaylist}
              editing={menuEditing}
              open={drawerOpen}
              onCreatePlaylist={() => setCreatePlaylistOpen(true)}
              onDeletePlaylist={setDeleteTarget}
              onEditToggle={() => setMenuEditing((editing) => !editing)}
              onOpenPlaylist={openPlaylist}
              onOpenQueue={() => setQueueOpen(true)}
              onRenamePlaylist={openRenamePlaylist}
              onRefreshLibraries={() => void handleRefreshLibraries()}
              playlistEntries={playlistEntries}
              refreshBusy={refreshing}
              refreshMessage={refreshMessage}
              sidebar={sidebar}
              setOpen={setDrawerOpen}
            />
          )}

          <main
            data-testid="app-main"
            onPointerCancel={menuSwipeHandlers.onPointerCancel}
            onPointerDown={menuSwipeHandlers.onPointerDown}
            onPointerMove={menuSwipeHandlers.onPointerMove}
            onPointerUp={menuSwipeHandlers.onPointerUp}
            onTouchCancel={menuSwipeHandlers.onTouchCancel}
            onTouchEnd={menuSwipeHandlers.onTouchEnd}
            onTouchMove={menuSwipeHandlers.onTouchMove}
            onTouchStart={menuSwipeHandlers.onTouchStart}
            className={
              isImmersiveRoute
                ? 'min-h-screen'
                : 'min-h-[calc(100vh-4.25rem)] touch-pan-y pb-24'
            }
          >
            {children}
          </main>
        </div>
      </div>
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
      <PlaylistDrawer
        editable={playlistDrawer?.kind === 'custom'}
        items={playlistDrawer?.items ?? []}
        onClose={() => setPlaylistDrawer(null)}
        onPlayItem={playPlaylistItem}
        onMoveItem={movePlaylistItem}
        onRemoveItems={removePlaylistItems}
        open={playlistDrawer !== null}
        playlistId={playlistDrawer?.playlistId}
        title={playlistDrawer?.title ?? ''}
      />
      {createPlaylistOpen && (
        <CreatePlaylistModal
          name={newPlaylistName}
          onClose={() => setCreatePlaylistOpen(false)}
          onName={setNewPlaylistName}
          onSubmit={createPlaylist}
        />
      )}
      {renameTarget !== null && (
        <PlaylistNameModal
          name={renamePlaylistName}
          onClose={() => setRenameTarget(null)}
          onName={setRenamePlaylistName}
          onSubmit={submitRenamePlaylist}
          title="Rename Playlist"
          submitLabel="Rename"
        />
      )}
      {deleteTarget !== null && (
        <ConfirmModal
          title="Delete Playlist"
          message={`Delete "${deleteTarget.title}"?`}
          confirmLabel="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={submitDeletePlaylist}
        />
      )}
    </div>
  );
}

function itemsFromLibraryState(state: LibraryState): LibraryItem[] {
  return state.result?.kind === 'ok' ? state.result.items : EMPTY_LIBRARY_ITEMS;
}

function MobilePeekDrawer({
  canCreatePlaylist,
  editing,
  open,
  onCreatePlaylist,
  onDeletePlaylist,
  onEditToggle,
  onOpenPlaylist,
  onOpenQueue,
  onRenamePlaylist,
  onRefreshLibraries,
  playlistEntries,
  refreshBusy,
  refreshMessage,
  sidebar,
  setOpen,
}: {
  canCreatePlaylist: boolean;
  editing: boolean;
  open: boolean;
  onCreatePlaylist: () => void;
  onDeletePlaylist: (entry: PlaylistMenuEntry) => void;
  onEditToggle: () => void;
  onOpenPlaylist: (entry: PlaylistMenuEntry) => void;
  onOpenQueue: () => void;
  onRenamePlaylist: (entry: PlaylistMenuEntry) => void;
  onRefreshLibraries: () => void;
  playlistEntries: PlaylistMenuEntry[];
  refreshBusy: boolean;
  refreshMessage: string;
  sidebar: (typeof sideSections)[keyof typeof sideSections];
  setOpen: (open: boolean) => void;
}) {
  const dragStartXRef = useRef<number | null>(null);

  return (
    <div className="lg:hidden">
      {!open && (
        <button
          type="button"
          data-testid="mobile-menu-peek"
          aria-label="Open navigation"
          className="fixed left-0 top-[var(--mobile-drawer-top)] z-40 h-28 w-5 rounded-r-2xl border-y border-r border-zinc-200/70 bg-white/72 shadow-lg shadow-black/10 backdrop-blur-xl transition hover:w-7 dark:border-white/10 dark:bg-white/[0.09]"
          onClick={() => setOpen(true)}
          onPointerDown={(event) => {
            dragStartXRef.current = event.clientX;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const startX = dragStartXRef.current;
            if (startX === null) return;
            if (event.clientX - startX > 12) {
              setOpen(true);
              dragStartXRef.current = null;
            }
          }}
          onPointerUp={() => {
            dragStartXRef.current = null;
          }}
        />
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/35"
          role="presentation"
          onClick={() => {
            setOpen(false);
            if (editing) onEditToggle();
          }}
        >
          <nav
            aria-label="Mobile navigation"
            data-testid="mobile-navigation"
            data-glass
            className="absolute bottom-2 left-2 top-[var(--mobile-drawer-open-top)] flex w-[min(20rem,84vw)] flex-col overflow-hidden rounded-2xl border border-zinc-200/70 bg-white/88 px-5 py-5 text-zinc-950 shadow-2xl shadow-black/20 backdrop-blur-xl dark:border-white/10 dark:bg-surface/94 dark:text-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
              <span
                data-testid="mobile-menu-title"
                className="min-w-0 flex-1 truncate text-left text-2xl font-semibold"
              >
                {sidebar.title}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {canCreatePlaylist && (
                  <button
                    type="button"
                    data-testid="playlist-create-open"
                    aria-label="Create playlist"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-full text-2xl text-muted hover:bg-zinc-200/70 dark:hover:bg-white/10"
                    onClick={onCreatePlaylist}
                  >
                    +
                  </button>
                )}
                {canCreatePlaylist && (
                  <button
                    type="button"
                    data-testid="playlist-edit-toggle"
                    aria-pressed={editing}
                    className="inline-flex h-10 items-center justify-center rounded-full px-3 text-sm font-semibold text-muted hover:bg-zinc-200/70 aria-pressed:text-accent dark:hover:bg-white/10"
                    onClick={onEditToggle}
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close navigation"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full text-2xl text-muted hover:bg-zinc-200/70 dark:hover:bg-white/10"
                  onClick={() => setOpen(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <SidebarContent
              canCreatePlaylist={canCreatePlaylist}
              editing={editing}
              onCreatePlaylist={onCreatePlaylist}
              onDeletePlaylist={onDeletePlaylist}
              onNavigate={() => setOpen(false)}
              onEditToggle={onEditToggle}
              onOpenPlaylist={onOpenPlaylist}
              onOpenQueue={onOpenQueue}
              onRenamePlaylist={onRenamePlaylist}
              onRefreshLibraries={onRefreshLibraries}
              playlistEntries={playlistEntries}
              refreshBusy={refreshBusy}
              refreshMessage={refreshMessage}
              sidebar={sidebar}
              showTitle={false}
            />
          </nav>
        </div>
      )}
    </div>
  );
}

const MENU_SWIPE_BLOCK_SELECTOR =
  'input,select,textarea,video,[data-no-menu-swipe],[data-allow-scroll]';

function useLeftToRightMenuSwipe({
  enabled,
  onOpen,
}: {
  enabled: boolean;
  onOpen: () => void;
}) {
  const swipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const beginSwipe = (clientX: number, clientY: number, target: EventTarget | null) => {
    if (!enabled) return;
    if (target instanceof Element && target.closest(MENU_SWIPE_BLOCK_SELECTOR)) {
      return;
    }
    swipeRef.current = { startX: clientX, startY: clientY };
  };
  const moveSwipe = (clientX: number, clientY: number): 'none' | 'horizontal' | 'opened' => {
    const swipe = swipeRef.current;
    if (swipe === null) return 'none';
    const dx = clientX - swipe.startX;
    const dy = clientY - swipe.startY;
    const absDy = Math.abs(dy);
    if (dx > 52 && dx > absDy * 1.2) {
      swipeRef.current = null;
      onOpen();
      return 'opened';
    }
    if (absDy > 36 && absDy > dx) {
      swipeRef.current = null;
    }
    if (dx > 18 && dx > absDy * 1.2) {
      return 'horizontal';
    }
    return 'none';
  };
  const endSwipe = () => {
    swipeRef.current = null;
  };

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (!enabled) return;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      beginSwipe(event.clientX, event.clientY, event.target);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      moveSwipe(event.clientX, event.clientY);
    },
    onPointerUp: endSwipe,
    onPointerCancel: endSwipe,
    onTouchStart(event: ReactTouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      if (!touch) return;
      beginSwipe(touch.clientX, touch.clientY, event.target);
    },
    onTouchMove(event: ReactTouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      if (!touch) return;
      const swipeState = moveSwipe(touch.clientX, touch.clientY);
      if (swipeState !== 'none' && event.cancelable) {
        event.preventDefault();
      }
    },
    onTouchEnd: endSwipe,
    onTouchCancel: endSwipe,
  };
}

function usePreventPullToRefresh() {
  useEffect(() => {
    let startY = 0;
    const handleTouchStart = (event: TouchEvent) => {
      startY = event.touches[0]?.clientY ?? 0;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const currentY = event.touches[0]?.clientY ?? startY;
      if (currentY <= startY || canScrollUp(target)) return;
      if (!event.cancelable) return;
      event.preventDefault();
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
    };
  }, []);
}

function canScrollUp(target: Element): boolean {
  let node: Element | null = target;
  while (node !== null && node !== document.body) {
    if (
      node instanceof HTMLElement &&
      node.dataset.allowScroll !== undefined &&
      node.scrollTop > 0
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return window.scrollY > 0 || document.documentElement.scrollTop > 0;
}

function SegmentedTabs() {
  const location = useLocation();
  const activeLocation = backgroundLocationFrom(location) ?? location;
  return (
    <nav
      aria-label="Primary"
      data-glass
      className="inline-flex max-w-full rounded-full bg-zinc-200/30 p-1 shadow-sm ring-1 ring-black/[0.025] backdrop-blur-xl dark:bg-white/[0.045] dark:ring-white/[0.035]"
    >
      {primaryTabs.map((tab) => {
        const active = activeLocation.pathname.startsWith(tab.match);
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={
              active
                ? 'rounded-full bg-white/62 px-5 py-2 text-sm font-semibold text-zinc-950 shadow-sm dark:bg-white/[0.10] dark:text-foreground'
                : 'rounded-full px-5 py-2 text-sm font-semibold text-zinc-500 hover:text-zinc-950 dark:text-muted dark:hover:text-foreground'
            }
          >
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function SidebarContent({
  canCreatePlaylist,
  editing,
  onCreatePlaylist,
  onDeletePlaylist,
  onEditToggle,
  onNavigate,
  onOpenPlaylist,
  onOpenQueue,
  onRenamePlaylist,
  onRefreshLibraries,
  playlistEntries,
  refreshBusy,
  refreshMessage,
  showTitle = true,
  sidebar,
}: {
  canCreatePlaylist: boolean;
  editing: boolean;
  onCreatePlaylist: () => void;
  onDeletePlaylist: (entry: PlaylistMenuEntry) => void;
  onEditToggle: () => void;
  onNavigate?: () => void;
  onOpenPlaylist: (entry: PlaylistMenuEntry) => void;
  onOpenQueue: () => void;
  onRenamePlaylist: (entry: PlaylistMenuEntry) => void;
  onRefreshLibraries: () => void;
  playlistEntries: PlaylistMenuEntry[];
  refreshBusy: boolean;
  refreshMessage: string;
  showTitle?: boolean;
  sidebar: (typeof sideSections)[keyof typeof sideSections];
}) {
  const handleOpenQueue = () => {
    onOpenQueue();
    onNavigate?.();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
      {showTitle && (
        <div className="flex items-center justify-between gap-3">
          <Link
            to={sidebar.to}
            onClick={onNavigate}
            data-testid="sidebar-menu-title"
            className="min-w-0 truncate text-left text-3xl font-semibold tracking-tight text-zinc-950 dark:text-foreground"
          >
            {sidebar.title}
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            {canCreatePlaylist && (
              <button
                type="button"
                data-testid="playlist-create-open"
                aria-label="Create playlist"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-2xl text-muted hover:bg-zinc-200/70 dark:hover:bg-white/10"
                onClick={onCreatePlaylist}
              >
                +
              </button>
            )}
            {canCreatePlaylist && (
              <button
                type="button"
                data-testid="playlist-edit-toggle"
                aria-pressed={editing}
                className="inline-flex h-9 items-center justify-center rounded-full px-3 text-sm font-semibold text-muted hover:bg-zinc-200/70 aria-pressed:text-accent dark:hover:bg-white/10"
                onClick={onEditToggle}
              >
                Edit
              </button>
            )}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="space-y-1">
          {playlistEntries.length > 0
            ? playlistEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex w-full items-center gap-2 rounded-lg hover:bg-zinc-200/70 dark:hover:bg-white/10"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center justify-between rounded-lg px-3 py-2.5 text-left text-lg text-zinc-600 dark:text-muted dark:hover:text-foreground"
                    onClick={() => {
                      if (editing) return;
                      onOpenPlaylist(entry);
                      onNavigate?.();
                    }}
                  >
                    <span className="min-w-0 truncate">{entry.title}</span>
                    <span className="text-sm text-muted">{entry.count}</span>
                  </button>
                  {editing && entry.kind === 'custom' && (
                    <div className="flex shrink-0 items-center gap-1 pr-1">
                      <button
                        type="button"
                        aria-label={`Rename ${entry.title}`}
                        className="rounded-full px-2 py-1 text-xs font-semibold text-muted hover:bg-white/70 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRenamePlaylist(entry);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${entry.title}`}
                        className="rounded-full px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeletePlaylist(entry);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))
            : sidebar.items.map((label) =>
                sidebar.title === 'Settings' ? (
                  <a
                    key={label}
                    href={settingsAnchorFor(label)}
                    onClick={onNavigate}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-lg text-zinc-600 hover:bg-zinc-200/70 dark:text-muted dark:hover:bg-white/10 dark:hover:text-foreground"
                  >
                    <span>{label}</span>
                  </a>
                ) : (
                  <button
                    key={label}
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed items-center justify-between rounded-lg px-3 py-2.5 text-left text-lg text-zinc-400 opacity-70 dark:text-muted"
                  >
                    <span>{label}</span>
                    <span className="text-sm">Soon</span>
                  </button>
                ),
              )}
        </div>
      </div>
      <div className="mt-auto flex shrink-0 flex-col items-stretch gap-2 border-t border-zinc-200/70 pt-3 dark:border-white/10">
        {refreshMessage !== '' && (
          <span
            data-testid="menu-refresh-status"
            className="max-w-full text-right text-xs text-muted"
          >
            {refreshMessage}
          </span>
        )}
        <div
          data-testid="menu-bottom-actions"
          className="grid grid-cols-2 gap-2"
        >
          <button
            type="button"
            data-testid="menu-refresh-button"
            disabled={refreshBusy}
            aria-label="Refresh libraries"
            className="inline-flex h-9 min-w-0 items-center justify-center rounded-full border border-zinc-300/80 bg-white/65 px-3 text-sm font-semibold text-zinc-800 shadow-sm backdrop-blur-xl hover:bg-zinc-200/70 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground dark:hover:bg-white/10"
            onClick={onRefreshLibraries}
          >
            {refreshBusy ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            data-testid="menu-queue-button"
            className="inline-flex h-9 min-w-0 items-center justify-center rounded-full border border-zinc-300/80 bg-white/65 px-3 text-sm font-semibold text-zinc-800 shadow-sm backdrop-blur-xl hover:bg-zinc-200/70 dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground dark:hover:bg-white/10"
            onClick={handleOpenQueue}
          >
            Queue
          </button>
        </div>
      </div>
    </div>
  );
}

function CreatePlaylistModal({
  name,
  onClose,
  onName,
  onSubmit,
}: {
  name: string;
  onClose: () => void;
  onName: (name: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div
      data-testid="playlist-create-modal"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <section
        data-glass
        className="w-full max-w-sm rounded-2xl border border-white/14 bg-[#111113]/94 p-4 text-white shadow-2xl shadow-black/60 backdrop-blur-[76px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New Playlist</h2>
          <button
            type="button"
            aria-label="Close create playlist"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-2xl text-white/70 hover:bg-white/10"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <input
          data-testid="playlist-create-name"
          aria-label="Playlist name"
          value={name}
          onChange={(event) => onName(event.target.value)}
          className="mb-3 w-full rounded-full border border-white/15 bg-transparent px-4 py-2 text-sm outline-none"
        />
        <button
          type="button"
          data-testid="playlist-create-submit"
          className="inline-flex h-10 w-full items-center justify-center rounded-full bg-white px-4 text-sm font-semibold text-zinc-950 hover:bg-white/85"
          onClick={onSubmit}
        >
          Create
        </button>
      </section>
    </div>
  );
}

function PlaylistNameModal({
  name,
  onClose,
  onName,
  onSubmit,
  submitLabel,
  title,
}: {
  name: string;
  onClose: () => void;
  onName: (name: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  title: string;
}) {
  return (
    <div
      data-testid="playlist-rename-modal"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <section
        data-glass
        className="w-full max-w-sm rounded-2xl border border-white/14 bg-[#111113]/94 p-4 text-white shadow-2xl shadow-black/60 backdrop-blur-[76px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            aria-label={`Close ${title}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-2xl text-white/70 hover:bg-white/10"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <input
          data-testid="playlist-rename-name"
          aria-label="Playlist name"
          value={name}
          onChange={(event) => onName(event.target.value)}
          className="mb-3 w-full rounded-full border border-white/15 bg-transparent px-4 py-2 text-sm outline-none"
        />
        <button
          type="button"
          data-testid="playlist-rename-submit"
          className="inline-flex h-10 w-full items-center justify-center rounded-full bg-white px-4 text-sm font-semibold text-zinc-950 hover:bg-white/85"
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </section>
    </div>
  );
}

function ConfirmModal({
  confirmLabel,
  message,
  onClose,
  onConfirm,
  title,
}: {
  confirmLabel: string;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
}) {
  return (
    <div
      data-testid="confirm-modal"
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 px-4"
      onClick={onClose}
    >
      <section
        data-glass
        className="w-full max-w-sm rounded-2xl border border-white/14 bg-[#111113]/94 p-4 text-white shadow-2xl shadow-black/60 backdrop-blur-[76px]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-white/65">{message}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-full border border-white/14 px-4 text-sm font-semibold text-white/75 hover:bg-white/10"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="confirm-submit"
            className="inline-flex h-10 items-center justify-center rounded-full bg-accent px-4 text-sm font-semibold text-white hover:bg-accent/85"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function describeRefreshError(result: Exclude<MediaRootsResult, { kind: 'ok' }>) {
  if (result.kind === 'unreachable') {
    return `Refresh failed: ${result.message}`;
  }
  if (result.message && result.message.trim() !== '') {
    return `Refresh failed: HTTP ${result.statusCode} ${result.message.trim()}`;
  }
  return `Refresh failed: HTTP ${result.statusCode}`;
}

function describeRefreshWarnings(
  settings: Extract<MediaRootsResult, { kind: 'ok' }>['settings'],
): string {
  const warnings: string[] = [];
  if (settings.degradedRoots.length > 0) {
    warnings.push(
      `Kept last known files for ${settings.degradedRoots
        .map((root) => `${root.path} (${root.error})`)
        .join('; ')}.`,
    );
  }
  if (settings.index.lastError) {
    warnings.push(`Library index write is delayed: ${settings.index.lastError}`);
  }
  return warnings.length === 0 ? '' : ` ${warnings.join(' ')}`;
}

function sectionForPath(pathname: string): 'music' | 'video' | 'image' | 'settings' | null {
  if (pathname.startsWith('/library/music')) return 'music';
  if (pathname.startsWith('/library/video')) return 'video';
  if (pathname.startsWith('/library/image')) return 'image';
  if (pathname.startsWith('/settings')) return 'settings';
  return null;
}

function settingsAnchorFor(label: string): string {
  if (label === 'Appearance') return '#appearance';
  if (label === 'Backend Status') return '#backend-status';
  if (label === 'Media Folders') return '#media-folders';
  return '#runtime-notes';
}
