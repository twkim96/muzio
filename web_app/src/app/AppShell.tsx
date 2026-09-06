import { useAndroidBack } from '../core/platform/androidShell';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { Heart } from '@phosphor-icons/react/dist/csr/Heart';
import { ChartBar } from '@phosphor-icons/react/dist/csr/ChartBar';
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { Playlist } from '@phosphor-icons/react/dist/csr/Playlist';
import { ImageSquare } from '@phosphor-icons/react/dist/csr/ImageSquare';
import { DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { GearSix } from '@phosphor-icons/react/dist/csr/GearSix';

import type { LibraryItem } from '../core/api/libraryClient';
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
import { GlassModal } from '../core/ui/GlassModal';
import { CloseGlyph, QueueGlyph } from '../core/ui/AppIcons';
import { SearchHostProvider } from './SearchHostContext';

const primaryTabs = [
  { to: '/library/music', label: 'Music', match: '/library/music' },
  { to: '/library/video', label: 'Video', match: '/library/video' },
  { to: '/library/image', label: 'Image', match: '/library/image' },
] as const;

const sideSections = {
  music: {
    title: 'Music',
    to: '/library/music',
    items: ['좋아하는 음악', '많이 재생한 음악'],
  },
  video: {
    title: 'Video',
    to: '/library/video',
    items: ['최근 시청한 영상'],
  },
  image: {
    title: 'Image',
    to: '/library/image',
    items: ['즐겨찾기', '최근 추가한 항목', '스크린샷', '다운로드'],
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
  const updateSourcePresentation = playerStore(
    (state) => state.updateSourcePresentation,
  );
  const activeAudioMediaId = playerStore(
    (state) => state.audio.source?.mediaId ?? null,
  );
  const activeVideoMediaId = playerStore(
    (state) => state.video.source?.mediaId ?? null,
  );
  const playerOverlay = usePlayerOverlay();
  const audioItems = libraryStores.audio(itemsFromLibraryState);
  const videoItems = libraryStores.video(itemsFromLibraryState);
  const imageItems = libraryStores.image(itemsFromLibraryState);
  const audioPresentation = libraryStores.audio(
    (state) => activeAudioMediaId === null ? undefined : state.presentation.get(activeAudioMediaId),
  );
  const videoPresentation = libraryStores.video(
    (state) => activeVideoMediaId === null ? undefined : state.presentation.get(activeVideoMediaId),
  );
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
  useAndroidBack(drawerOpen || queueOpen || playlistDrawer !== null, () => {
    if (queueOpen) setQueueOpen(false);
    else if (playlistDrawer !== null) setPlaylistDrawer(null);
    else setDrawerOpen(false);
  }, 50);
  const [filterHost, setFilterHost] = useState<HTMLElement | null>(null);
  const [searchHost, setSearchHost] = useState<HTMLElement | null>(null);
  const [searchPopoverHost, setSearchPopoverHost] = useState<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const navigationTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const closeDrawer = () => {
    setDrawerOpen(false);
    requestAnimationFrame(() => (navigationTriggerRef.current ?? menuButtonRef.current)?.focus());
  };
  useEffect(() => {
    if (!drawerOpen || createPlaylistOpen || renameTarget !== null || deleteTarget !== null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen, createPlaylistOpen, renameTarget, deleteTarget]);
  useEffect(() => {
    if (section === null || isImmersiveRoute) {
      closeDrawer();
    }
  }, [isImmersiveRoute, section]);
  useEffect(() => {
    if (!playerOverlay.playlistsOpen) return;
    if (section !== 'music' && section !== 'video') navigate('/library/music');
    setDrawerOpen(true);
    playerOverlay.closePlaylists();
  }, [navigate, playerOverlay.playlistsOpen, playerOverlay.closePlaylists, section]);
  useEffect(() => {
    for (const [mediaId, items, presentation] of [
      [activeAudioMediaId, audioItems, audioPresentation],
      [activeVideoMediaId, videoItems, videoPresentation],
    ] as const) {
      if (mediaId === null) continue;
      const item = items.find((candidate) => candidate.id === mediaId);
      if (item === undefined || !isPlayableLibraryItem(item)) continue;
      const thumbnail = presentation ?? item.thumbnail;
      updateSourcePresentation(
        playbackSourceFromLibraryItem(
          thumbnail === undefined ? item : { ...item, thumbnail },
        ),
      );
    }
  }, [
    activeAudioMediaId,
    activeVideoMediaId,
    audioItems,
    audioPresentation,
    updateSourcePresentation,
    videoItems,
    videoPresentation,
  ]);
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
  const activeTabIndex = primaryTabs.findIndex((tab) => shellLocation.pathname === tab.to);
  const librarySwipeHandlers = useLibrarySwipe({
    enabled: activeTabIndex >= 0 && location.pathname === shellLocation.pathname && !playerOverlay.isOpen && !drawerOpen && !queueOpen && playlistDrawer === null,
    onSwipe: (direction) => {
      const nextTab = primaryTabs[activeTabIndex + direction];
      if (nextTab) navigate(nextTab.to);
    },
  });

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
    <SearchHostProvider filterHost={filterHost} host={searchHost} popoverHost={searchPopoverHost}>
      <div
        data-testid="library-swipe-surface"
        onClickCapture={librarySwipeHandlers.onClickCapture}
        onPointerCancelCapture={librarySwipeHandlers.onPointerCancel}
        onPointerDownCapture={librarySwipeHandlers.onPointerDown}
        onPointerMoveCapture={librarySwipeHandlers.onPointerMove}
        onPointerUpCapture={librarySwipeHandlers.onPointerUp}
        onTouchCancelCapture={librarySwipeHandlers.onTouchCancel}
        onTouchEndCapture={librarySwipeHandlers.onTouchEnd}
        onTouchMoveCapture={librarySwipeHandlers.onTouchMove}
        onTouchStartCapture={librarySwipeHandlers.onTouchStart}
        className="min-h-screen touch-pan-y bg-zinc-50 text-zinc-950 transition-colors dark:bg-surface dark:text-foreground"
      >
        {!isImmersiveRoute && (
          <header className="sticky top-3 z-30 mx-auto mt-3 max-w-7xl px-3 sm:px-8 lg:px-10">
            {section !== null && (
              <div className="absolute top-[5.8px] hidden h-[46.4px] w-fit [--title-scale:1.16] md:block">
                <h1 className="w-fit text-lg font-semibold tracking-tight sm:text-xl">
                  <button
                    type="button"
                    aria-expanded={drawerOpen}
                    aria-controls="app-sidebar-drawer"
                    data-testid="title-navigation-button"
                    className="muzio-title relative flex h-8 w-fit origin-top-left scale-[var(--title-scale)] items-center px-4 sm:h-10"
                    onClick={(event) => {
                      navigationTriggerRef.current = event.currentTarget;
                      setDrawerOpen((open) => !open);
                    }}
                  >
                    <span className="scale-[calc(1/var(--title-scale))]">{sideSections[section].title}</span>
                  </button>
                </h1>
              </div>
            )}
            <div className="relative mx-auto w-fit max-w-full">
              <div className="muzio-topbar relative px-1.5 py-1.5">
                <div className="flex h-11 items-center justify-center gap-0.5 sm:gap-1">
                  {hasMobileMenu ? (
                    <button
                      ref={menuButtonRef}
                      type="button"
                      aria-label="Open navigation"
                      aria-expanded={drawerOpen}
                      aria-controls="app-sidebar-drawer"
                      data-testid="navigation-menu-button"
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground transition hover:bg-foreground/10"
                      onClick={(event) => {
                        navigationTriggerRef.current = event.currentTarget;
                        setDrawerOpen((open) => !open);
                      }}
                    >
                      <SidebarSimple aria-hidden className="h-6 w-6" weight="regular" />
                    </button>
                  ) : (
                    <span className="h-10 w-10 shrink-0" aria-hidden />
                  )}
                  <SegmentedTabs onNavigate={closeDrawer} />
                  <div ref={setFilterHost} data-testid="filter-host" className="flex h-10 w-10 shrink-0 items-center" />
                  <div
                    ref={setSearchHost}
                    data-testid="search-host"
                    className="flex h-10 w-10 shrink-0 items-center justify-end"
                  />
                </div>
              </div>
              <div ref={setSearchPopoverHost} />
            </div>
            <NavLink
              to="/settings"
              aria-label="Settings"
              onClick={closeDrawer}
              className="muzio-settings-button absolute right-3 top-[5.8px] hidden h-[46.4px] w-[46.4px] items-center justify-center text-foreground min-[480px]:flex sm:right-8 lg:right-10"
            >
              <GearSix aria-hidden className="h-[21.1px] w-[21.1px]" />
            </NavLink>
          </header>
        )}

        {sidebar !== null && !isImmersiveRoute && drawerOpen && (
          <SidebarDrawer
            modalOpen={createPlaylistOpen || renameTarget !== null || deleteTarget !== null}
            canCreatePlaylist={canCreatePlaylist}
            editing={menuEditing}
            onClose={closeDrawer}
            onCreatePlaylist={() => setCreatePlaylistOpen(true)}
            onDeletePlaylist={setDeleteTarget}
            onEditToggle={() => setMenuEditing((editing) => !editing)}
            onOpenPlaylist={openPlaylist}
            onOpenQueue={() => setQueueOpen(true)}
            onRenamePlaylist={openRenamePlaylist}
            playlistEntries={playlistEntries}
            sidebar={sidebar}
          />
        )}

        <main
          data-testid="app-main"
          className={isImmersiveRoute ? 'min-h-screen' : 'min-h-screen touch-pan-y pb-24'}
        >
          {children}
        </main>
      <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} onBack={() => { setQueueOpen(false); setDrawerOpen(true); }} />
      <PlaylistDrawer
        editable={playlistDrawer?.kind === 'custom'}
        items={playlistDrawer?.items ?? []}
        onClose={() => setPlaylistDrawer(null)}
        onBack={() => { setPlaylistDrawer(null); setDrawerOpen(true); }}
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
    </SearchHostProvider>
  );
}

function itemsFromLibraryState(state: LibraryState): LibraryItem[] {
  return state.result?.kind === 'ok' ? state.result.items : EMPTY_LIBRARY_ITEMS;
}

function SidebarDrawer({
  modalOpen,
  canCreatePlaylist,
  editing,
  onClose,
  onCreatePlaylist,
  onDeletePlaylist,
  onEditToggle,
  onOpenPlaylist,
  onOpenQueue,
  onRenamePlaylist,
  playlistEntries,
  sidebar,
}: {
  modalOpen: boolean;
  canCreatePlaylist: boolean;
  editing: boolean;
  onClose: () => void;
  onCreatePlaylist: () => void;
  onDeletePlaylist: (entry: PlaylistMenuEntry) => void;
  onEditToggle: () => void;
  onOpenPlaylist: (entry: PlaylistMenuEntry) => void;
  onOpenQueue: () => void;
  onRenamePlaylist: (entry: PlaylistMenuEntry) => void;
  playlistEntries: PlaylistMenuEntry[];
  sidebar: (typeof sideSections)[keyof typeof sideSections];
}) {
  const drawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer || modalOpen) return;
    const controls = () => Array.from(drawer.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
    ));
    drawer.querySelector<HTMLElement>('[aria-label="Close navigation"]')?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [modalOpen]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/35"
      role="presentation"
      onClick={() => {
        onClose();
        if (editing) onEditToggle();
      }}
    >
      <nav
        id="app-sidebar-drawer"
        ref={drawerRef}
        aria-label="Navigation"
        aria-modal="true"
        data-testid="mobile-navigation"
        data-glass
        className="muzio-sidebar muzio-side-sheet flex flex-col overflow-hidden rounded-2xl border border-zinc-200/70 bg-white/88 px-5 py-5 text-zinc-950 shadow-2xl shadow-black/20 backdrop-blur-xl dark:border-white/10 dark:bg-surface/94 dark:text-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1 flex shrink-0 flex-col items-start gap-3">
          <div className="flex w-full items-start justify-between gap-3">
            <h2
              data-testid="mobile-menu-title"
              className="muzio-sheet-title h-[46.4px] w-fit text-left [--title-scale:1.45] sm:[--title-scale:1.16]"
            >
              <span className="muzio-title relative flex h-8 w-fit origin-top-left scale-[var(--title-scale)] items-center px-4 text-lg font-semibold tracking-tight sm:h-10 sm:text-xl">
                <span className="scale-[calc(1/var(--title-scale))]">{sidebar.title}</span>
              </span>
            </h2>
            <button type="button" aria-label="Close navigation" onClick={onClose} className="muzio-sheet-header-action muzio-settings-button flex h-[46.4px] w-[46.4px] shrink-0 items-center justify-center">
              <CloseGlyph aria-hidden className="h-[21.1px] w-[21.1px]" />
            </button>
          </div>
          <div className="flex h-12 shrink-0 items-center gap-2 self-end">
            {canCreatePlaylist && (
              <button
                type="button"
                data-testid="playlist-edit-toggle"
                aria-pressed={editing}
                className="inline-flex h-10 items-center justify-center rounded-full px-3 text-sm font-semibold leading-none text-muted hover:bg-zinc-200/70 aria-pressed:text-accent dark:hover:bg-white/10"
                onClick={onEditToggle}
              >
                Edit
              </button>
            )}
            {canCreatePlaylist && (
              <button
                type="button"
                data-testid="playlist-create-open"
                aria-label="Create playlist"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-2xl text-muted hover:bg-zinc-200/70 dark:hover:bg-white/10"
                onClick={onCreatePlaylist}
              >
                <Plus aria-hidden className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <SidebarContent
          canCreatePlaylist={canCreatePlaylist}
          editing={editing}
          onCreatePlaylist={onCreatePlaylist}
          onDeletePlaylist={onDeletePlaylist}
          onNavigate={onClose}
          onEditToggle={onEditToggle}
          onOpenPlaylist={onOpenPlaylist}
          onOpenQueue={onOpenQueue}
          onRenamePlaylist={onRenamePlaylist}
          playlistEntries={playlistEntries}
          sidebar={sidebar}
          showTitle={false}
        />
      </nav>
    </div>
  );
}

const LIBRARY_SWIPE_BLOCK_SELECTOR =
  '.muzio-side-sheet,.muzio-modal-backdrop,[role="dialog"],input,select,textarea,video,audio,[role="slider"],[contenteditable="true"],[data-no-menu-swipe],[data-allow-scroll],[data-row-action],[data-row-options-shell]';

function useLibrarySwipe({
  enabled,
  onSwipe,
}: {
  enabled: boolean;
  onSwipe: (direction: -1 | 1) => void;
}) {
  const swipeRef = useRef<{ startX: number; startY: number } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const beginSwipe = (clientX: number, clientY: number, target: EventTarget | null) => {
    swipeRef.current = null;
    suppressClickUntilRef.current = 0;
    if (!enabled) return;
    if (target instanceof Element) {
      if (target.closest(LIBRARY_SWIPE_BLOCK_SELECTOR)) return;
      const control = target.closest('button,a,[role="button"]');
      // Row primary actions are the library's swipe surface; auxiliary actions stay isolated.
      if (control && !control.matches('[data-testid="library-item"] button:not([data-row-action])')) return;
    }
    swipeRef.current = { startX: clientX, startY: clientY };
  };
  const moveSwipe = (clientX: number, clientY: number): 'none' | 'horizontal' | 'navigated' => {
    const swipe = swipeRef.current;
    if (!enabled || swipe === null) return 'none';
    const dx = clientX - swipe.startX;
    const dy = clientY - swipe.startY;
    const absDy = Math.abs(dy);
    const absDx = Math.abs(dx);
    if (absDx > 52 && absDx > absDy * 1.2) {
      swipeRef.current = null;
      suppressClickUntilRef.current = Date.now() + 800;
      onSwipe(dx < 0 ? 1 : -1);
      return 'navigated';
    }
    if (absDy > 36 && absDy > absDx) {
      swipeRef.current = null;
    }
    if (absDx > 18 && absDx > absDy * 1.2) {
      return 'horizontal';
    }
    return 'none';
  };
  const endSwipe = () => {
    swipeRef.current = null;
  };

  return {
    onClickCapture(event: ReactMouseEvent<HTMLElement>) {
      if (event.detail === 0 || Date.now() > suppressClickUntilRef.current) return;
      suppressClickUntilRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      suppressClickUntilRef.current = 0;
      if (!enabled) return;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      beginSwipe(event.clientX, event.clientY, event.target);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      moveSwipe(event.clientX, event.clientY);
    },
    onPointerUp: endSwipe,
    onPointerCancel: endSwipe,
    onTouchStart(event: ReactTouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        endSwipe();
        return;
      }
      beginSwipe(touch.clientX, touch.clientY, event.target);
    },
    onTouchMove(event: ReactTouchEvent<HTMLElement>) {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        endSwipe();
        return;
      }
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

function SegmentedTabs({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const activeLocation = backgroundLocationFrom(location) ?? location;
  return (
    <nav
      aria-label="Primary"
      className="inline-flex min-w-0 items-center"
    >
      {primaryTabs.map((tab) => {
        const active = activeLocation.pathname.startsWith(tab.match);
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            onClick={onNavigate}
            className={
              active
                ? 'rounded-full bg-white/62 px-2 py-2 max-[359px]:px-1.5 text-base max-[359px]:text-sm font-medium leading-5 text-zinc-950 shadow-sm sm:px-5 dark:bg-white/[0.10] dark:text-foreground'
                : 'rounded-full px-2 py-2 max-[359px]:px-1.5 text-base max-[359px]:text-sm font-medium leading-5 text-zinc-500 hover:text-zinc-950 sm:px-5 dark:text-muted dark:hover:text-foreground'
            }
          >
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

function SidebarEntryIcon({ id }: { id: string }) {
  const icon = id.includes('liked-music') || id.includes('image-favorites') ? Heart
    : id.includes('most-played') ? ChartBar
    : id.includes('recently-') ? ClockCounterClockwise
    : id.includes('image-downloads') ? DownloadSimple
    : id.includes('image-') ? ImageSquare : Playlist;
  const Icon = icon;
  return <Icon aria-hidden className="h-6 w-6 shrink-0" weight="regular" />;
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
  playlistEntries,
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
  playlistEntries: PlaylistMenuEntry[];
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
                <Plus aria-hidden className="h-5 w-5" />
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
      <div data-allow-scroll className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        <div className="space-y-1">
          {playlistEntries.length > 0
            ? playlistEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex w-full items-center gap-2 rounded-lg hover:bg-zinc-200/70 dark:hover:bg-white/10"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-lg text-zinc-800 dark:text-foreground dark:hover:text-foreground"
                    onClick={() => {
                      if (editing) return;
                      onOpenPlaylist(entry);
                      onNavigate?.();
                    }}
                  >
                    <SidebarEntryIcon id={entry.id} />
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
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
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-lg text-zinc-600 hover:bg-zinc-200/70 dark:text-muted dark:hover:bg-white/10 dark:hover:text-foreground"
                  >
                    <GearSix aria-hidden className="h-6 w-6 shrink-0" /><span className="flex-1">{label}</span>
                  </a>
                ) : (
                  <button
                    key={label}
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed items-center justify-between rounded-lg px-3 py-2.5 text-left text-lg text-zinc-400 opacity-70 dark:text-muted"
                  >
                    <GearSix aria-hidden className="h-6 w-6 shrink-0" /><span className="flex-1">{label}</span>
                    <span className="text-sm">Soon</span>
                  </button>
                ),
              )}
        </div>
      </div>
      <div className="mt-auto flex shrink-0 flex-col items-stretch gap-2 border-t border-zinc-200/70 pt-3 dark:border-white/10">
        <div
          data-testid="menu-bottom-actions"
          className="grid grid-cols-2 gap-2"
        >
          <Link
            to="/settings"
            onClick={onNavigate}
            data-testid="menu-settings-button"
            className="inline-flex h-12 min-w-0 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-200/70 dark:text-foreground dark:hover:bg-white/10"
          >
            <GearSix aria-hidden className="h-6 w-6" />
            Setting
          </Link>
          <button
            type="button"
            data-testid="menu-queue-button"
            className="inline-flex h-12 min-w-0 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-200/70 dark:text-foreground dark:hover:bg-white/10"
            onClick={handleOpenQueue}
          >
            <QueueGlyph className="h-6 w-6" />
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
    <GlassModal
      testId="playlist-create-modal"
      title="New Playlist"
      closeLabel="Close create playlist"
      onClose={onClose}
      footer={
        <button type="button" data-testid="playlist-create-submit" className="muzio-glass-action" onClick={onSubmit}>
          Create
        </button>
      }
    >
      <input data-testid="playlist-create-name" aria-label="Playlist name" value={name}
        onChange={(event) => onName(event.target.value)} className="muzio-glass-input" />
    </GlassModal>
  );
}

function PlaylistNameModal({ name, onClose, onName, onSubmit, submitLabel, title }: {
  name: string;
  onClose: () => void;
  onName: (name: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  title: string;
}) {
  return (
    <GlassModal testId="playlist-rename-modal" title={title} onClose={onClose}
      footer={
        <button type="button" data-testid="playlist-rename-submit" className="muzio-glass-action" onClick={onSubmit}>
          {submitLabel}
        </button>
      }
    >
      <input data-testid="playlist-rename-name" aria-label="Playlist name" value={name}
        onChange={(event) => onName(event.target.value)} className="muzio-glass-input" />
    </GlassModal>
  );
}

function ConfirmModal({ confirmLabel, message, onClose, onConfirm, title }: {
  confirmLabel: string;
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
}) {
  return (
    <GlassModal testId="confirm-modal" title={title} onClose={onClose} alert
      footer={<>
        <button type="button" className="muzio-glass-action muzio-glass-action-secondary" onClick={onClose}>Cancel</button>
        <button type="button" data-testid="confirm-submit" className="muzio-glass-action" onClick={onConfirm}>{confirmLabel}</button>
      </>}
    >
      <p className="text-sm text-muted">{message}</p>
    </GlassModal>
  );
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
