import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { LibraryFetchResult } from '../core/api/libraryClient';
import { contentKeyForLibraryItem } from '../core/media/contentIdentity';
import type { ProgressRepository } from '../core/storage/progressRepository';
import { createLocalStoragePlaylistRepository } from '../core/storage/playlistRepository';
import { createBackendStatusStore } from '../features/settings/backendStatusStore';
import { BackendStatusProvider } from '../features/settings/BackendStatusContext';
import { createLibraryStore } from '../features/library/libraryStore';
import { LibraryProvider } from '../features/library/LibraryContext';
import {
  createPlayerStore,
  selectActiveState,
} from '../features/player/playerStore';
import { PlayerProvider } from '../features/player/PlayerContext';
import { ProgressProvider } from '../features/progress/ProgressContext';
import { App } from './App';

const emptyRepo: ProgressRepository = {
  read: () => null,
  write: () => {},
  clear: () => {},
  entries: () => [],
  mostRecent: () => null,
};

const audioResult: LibraryFetchResult = {
  kind: 'ok',
  items: [
    {
      id: 'a1',
      type: 'audio',
      rootName: 'music',
      relativePath: 'song.mp3',
      name: 'song.mp3',
      sizeBytes: 1024,
      modifiedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'a2',
      type: 'audio',
      rootName: 'music',
      relativePath: 'second.mp3',
      name: 'second.mp3',
      sizeBytes: 2048,
      modifiedAt: '2025-01-02T00:00:00Z',
    },
  ],
};

const videoResult: LibraryFetchResult = {
  kind: 'ok',
  items: [
    {
      id: 'v1',
      type: 'video',
      rootName: 'video',
      relativePath: 'clip.mp4',
      name: 'clip.mp4',
      sizeBytes: 2048,
      modifiedAt: '2025-01-01T00:00:00Z',
    },
    {
      id: 'v2',
      type: 'video',
      rootName: 'video',
      relativePath: 'newer.mp4',
      name: 'newer.mp4',
      sizeBytes: 4096,
      modifiedAt: '2025-01-02T00:00:00Z',
    },
  ],
};

const imageResult: LibraryFetchResult = {
  kind: 'ok',
  items: [
    {
      id: 'i1',
      type: 'image',
      rootName: 'images',
      relativePath: 'photo.jpg',
      name: 'photo.jpg',
      sizeBytes: 512,
      modifiedAt: '2025-01-02T00:00:00Z',
    },
  ],
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function renderApp(pathname: string) {
  window.history.pushState({}, '', pathname);
  const backendStatusStore = createBackendStatusStore({
    probe: async () => ({ kind: 'ok', service: 'test' }),
  });
  const libraryStores = {
    audio: createLibraryStore({
      type: 'audio',
      fetcher: async () => audioResult,
    }),
    video: createLibraryStore({
      type: 'video',
      fetcher: async () => videoResult,
    }),
    image: createLibraryStore({
      type: 'image',
      fetcher: async () => imageResult,
    }),
  };
  const playerStore = createPlayerStore();

  render(
    <BackendStatusProvider store={backendStatusStore}>
      <LibraryProvider stores={libraryStores}>
        <PlayerProvider store={playerStore}>
          <ProgressProvider repository={emptyRepo}>
            <App />
          </ProgressProvider>
        </PlayerProvider>
      </LibraryProvider>
    </BackendStatusProvider>,
  );

  return { playerStore };
}

describe('App routes', () => {
  test('redirects the root route to the music library', async () => {
    renderApp('/');

    await waitFor(() => {
      expect(window.location.pathname).toBe('/library/music');
    });
    expect(screen.getByRole('heading', { name: 'Music' })).toBeInTheDocument();
  });

  test('opens the full player as an overlay over the existing library route', async () => {
    const { playerStore } = renderApp('/library/music');
    act(() => {
      playerStore.getState().seedSource({
        kind: 'remote',
        mediaId: 'a1',
        mediaType: 'audio',
        url: '/api/media/a1',
        name: 'song.mp3',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('open-full-player'));

    expect(window.location.pathname).toBe('/library/music');
    expect(screen.getByTestId('player-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('player-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('mini-player')).not.toBeInTheDocument();
    expect(screen.queryByTestId('player-library-backdrop')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('library-list')).getByText('song.mp3')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('player-close'));

    expect(window.location.pathname).toBe('/library/music');
    expect(screen.queryByTestId('player-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('mini-player')).toBeInTheDocument();
  });

  test('player overlay swipes do not open the background mobile navigation', async () => {
    const { playerStore } = renderApp('/library/music');
    act(() => {
      playerStore.getState().seedSource({
        kind: 'remote',
        mediaId: 'a1',
        mediaType: 'audio',
        url: '/api/media/a1',
        name: 'song.mp3',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('open-full-player'));

    const playerScreen = screen.getByTestId('player-screen');
    fireEvent.touchStart(playerScreen, {
      touches: [{ clientX: 220, clientY: 300 }],
    });
    fireEvent.touchMove(playerScreen, {
      touches: [{ clientX: 315, clientY: 310 }],
    });
    fireEvent.touchEnd(playerScreen);

    expect(screen.queryByTestId('mobile-navigation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('player-close'));

    expect(screen.queryByTestId('player-overlay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-navigation')).not.toBeInTheDocument();
  });

  test('lowers the mobile peek drawer on menu screens', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    const shell = screen.getByTestId('mobile-menu-peek').closest('[style]');
    expect(shell).not.toBeNull();
    expect((shell as HTMLElement).style.getPropertyValue('--mobile-drawer-top')).toBe(
      '13.75rem',
    );
    expect(
      (shell as HTMLElement).style.getPropertyValue('--mobile-drawer-open-top'),
    ).toBe('10.75rem');
    expect(screen.getByTestId('mobile-menu-peek').className).toContain(
      'top-[var(--mobile-drawer-top)]',
    );
  });

  test('uses the same mobile drawer placement on settings', async () => {
    renderApp('/settings');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    const shell = screen.getByTestId('mobile-menu-peek').closest('[style]');
    expect(shell).not.toBeNull();
    expect((shell as HTMLElement).style.getPropertyValue('--mobile-drawer-top')).toBe(
      '13.75rem',
    );
    expect(
      (shell as HTMLElement).style.getPropertyValue('--mobile-drawer-open-top'),
    ).toBe('10.75rem');
  });

  test('mobile navigation shows one section title and opens queue from the bottom actions', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));
    const navigation = screen.getByTestId('mobile-navigation');
    expect(within(navigation).getAllByText('Music')).toHaveLength(1);
    expect(within(navigation).queryByText('Library')).not.toBeInTheDocument();
    expect(navigation.className).toContain('flex');
    expect(navigation.className).toContain('overflow-hidden');

    expect(
      within(navigation).getByRole('button', { name: 'Close navigation' }),
    ).toBeInTheDocument();
    const bottomActions = within(navigation).getByTestId('menu-bottom-actions');
    expect(bottomActions.className).toContain('grid-cols-2');
    const actionButtons = within(bottomActions).getAllByRole('button');
    expect(actionButtons[0]).toHaveTextContent('Refresh');
    expect(actionButtons[1]).toHaveTextContent('Queue');
    fireEvent.click(within(navigation).getByTestId('menu-queue-button'));

    expect(screen.queryByTestId('mobile-navigation')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-drawer')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('queue-drawer-backdrop'));
    expect(screen.queryByTestId('queue-drawer')).not.toBeInTheDocument();
  });

  test('creates a custom playlist from the mobile menu plus button', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));
    fireEvent.click(
      within(screen.getByTestId('mobile-navigation')).getByLabelText(
        'Create playlist',
      ),
    );
    fireEvent.change(screen.getByTestId('playlist-create-name'), {
      target: { value: 'Night' },
    });
    fireEvent.click(screen.getByTestId('playlist-create-submit'));

    const navigation = screen.getByTestId('mobile-navigation');
    expect(within(navigation).getByText('Night')).toBeInTheDocument();
  });

  test('mobile menu edit mode renames and deletes custom playlists only after confirmation', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));
    const navigation = screen.getByTestId('mobile-navigation');
    expect(within(navigation).getByTestId('mobile-menu-title')).toHaveClass(
      'text-left',
    );
    const headerButtons = within(navigation).getAllByRole('button');
    expect(headerButtons[0]).toHaveAttribute('aria-label', 'Create playlist');
    expect(headerButtons[1]).toHaveTextContent('Edit');
    expect(headerButtons[2]).toHaveAttribute('aria-label', 'Close navigation');

    fireEvent.click(within(navigation).getByLabelText('Create playlist'));
    fireEvent.change(screen.getByTestId('playlist-create-name'), {
      target: { value: 'Night' },
    });
    fireEvent.click(screen.getByTestId('playlist-create-submit'));

    fireEvent.click(within(navigation).getByTestId('playlist-edit-toggle'));

    expect(
      within(navigation).queryByLabelText('Rename Liked Music'),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByLabelText('Delete Liked Music'),
    ).not.toBeInTheDocument();

    fireEvent.click(within(navigation).getByLabelText('Rename Night'));
    fireEvent.change(screen.getByTestId('playlist-rename-name'), {
      target: { value: 'Nightfall' },
    });
    fireEvent.click(screen.getByTestId('playlist-rename-submit'));

    expect(within(navigation).getByText('Nightfall')).toBeInTheDocument();

    fireEvent.click(within(navigation).getByLabelText('Delete Nightfall'));
    expect(screen.getByTestId('confirm-modal')).toHaveTextContent(
      'Delete "Nightfall"?',
    );
    expect(within(navigation).getByText('Nightfall')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-submit'));

    expect(within(navigation).queryByText('Nightfall')).not.toBeInTheDocument();
  });

  test('custom playlist drawer edit mode deletes selected items and preserves the rest', async () => {
    const repository = createLocalStoragePlaylistRepository();
    repository.create('Road', 'road');
    repository.addItems('road', [
      contentKeyForLibraryItem(audioResult.items[0]),
      contentKeyForLibraryItem(audioResult.items[1]),
    ]);
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByText('second.mp3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));
    fireEvent.click(within(screen.getByTestId('mobile-navigation')).getByText('Road'));

    const drawer = screen.getByTestId('playlist-drawer');
    expect(within(drawer).getByText('song.mp3')).toBeInTheDocument();
    expect(within(drawer).getByText('second.mp3')).toBeInTheDocument();

    fireEvent.click(within(drawer).getByTestId('playlist-drawer-edit'));
    fireEvent.click(within(drawer).getByLabelText('Select song.mp3'));
    fireEvent.click(within(drawer).getByTestId('playlist-drawer-delete'));
    fireEvent.click(screen.getByTestId('playlist-drawer-confirm-delete'));

    expect(within(drawer).queryByText('song.mp3')).not.toBeInTheDocument();
    expect(within(drawer).getByText('second.mp3')).toBeInTheDocument();
    expect(repository.list()[0]?.items.map((item) => item.contentKey)).toEqual([
      contentKeyForLibraryItem(audioResult.items[1]),
    ]);
  });

  test('liked music playlist opens a drawer and plays into queue', async () => {
    const { playerStore } = renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Like song.mp3'));

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));
    const navigation = screen.getByTestId('mobile-navigation');
    fireEvent.click(within(navigation).getByText('Liked Music'));

    expect(screen.getByTestId('playlist-drawer')).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByTestId('playlist-drawer')).getByLabelText('Play song.mp3'),
    );

    await waitFor(() => {
      expect(playerStore.getState().musicQueue.map((item) => item.mediaId)).toEqual([
        'a1',
      ]);
    });
  });

  test('opens mobile navigation from a horizontal swipe on library content', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('app-main')).toBeInTheDocument();
    });

    const main = screen.getByTestId('app-main');
    fireEvent.touchStart(main, {
      touches: [{ clientX: 240, clientY: 260 }],
    });
    fireEvent.touchMove(main, {
      touches: [{ clientX: 330, clientY: 270 }],
    });
    fireEvent.touchEnd(main);

    await waitFor(() => {
      expect(screen.getByTestId('mobile-navigation')).toBeInTheDocument();
    });
  });

  test('does not open mobile navigation from a mini player swipe', async () => {
    const { playerStore } = renderApp('/library/music');
    act(() => {
      playerStore.getState().seedSource({
        kind: 'remote',
        mediaId: 'a1',
        mediaType: 'audio',
        url: '/api/media/a1',
        name: 'song.mp3',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    });

    const miniPlayer = screen.getByTestId('mini-player');
    fireEvent.touchStart(miniPlayer, {
      touches: [{ clientX: 240, clientY: 720 }],
    });
    fireEvent.touchMove(miniPlayer, {
      touches: [{ clientX: 330, clientY: 730 }],
    });
    fireEvent.touchEnd(miniPlayer);

    expect(screen.queryByTestId('mobile-navigation')).not.toBeInTheDocument();
  });

  test('desktop mouse clicks are not captured by the mobile swipe handler', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toBeInTheDocument();
    });

    const playButton = screen.getByLabelText('Play song.mp3');
    fireEvent.pointerDown(playButton, {
      pointerType: 'mouse',
      button: 0,
      clientX: 260,
      clientY: 260,
    });
    fireEvent.click(playButton);

    await waitFor(() => {
      expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('mobile-navigation')).not.toBeInTheDocument();
  });

  test('opens settings mobile navigation from a horizontal swipe', async () => {
    renderApp('/settings');

    await waitFor(() => {
      expect(screen.getByTestId('app-main')).toBeInTheDocument();
    });

    const main = screen.getByTestId('app-main');
    fireEvent.touchStart(main, {
      touches: [{ clientX: 220, clientY: 240 }],
    });
    fireEvent.touchMove(main, {
      touches: [{ clientX: 310, clientY: 250 }],
    });
    fireEvent.touchEnd(main);

    await waitFor(() => {
      expect(screen.getByTestId('mobile-navigation')).toBeInTheDocument();
    });
    const navigation = screen.getByTestId('mobile-navigation');
    expect(within(navigation).getByText('Backend Status')).toBeInTheDocument();
    expect(within(navigation).getByTestId('menu-refresh-button')).toBeInTheDocument();
    expect(within(navigation).getByTestId('menu-queue-button')).toBeInTheDocument();
  });

  test('video mobile menu exposes the recently watching playlist', async () => {
    renderApp('/library/video');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));

    expect(
      within(screen.getByTestId('mobile-navigation')).getByText(
        'Recently Watching',
      ),
    ).toBeInTheDocument();
  });

  test('recently watching drawer shows count and newest playback first', async () => {
    const { playerStore } = renderApp('/library/video');

    await waitFor(() => {
      expect(screen.getByText('newer.mp4')).toBeInTheDocument();
    });
    act(() => {
      playerStore.getState().importPlaybackActivity({
        version: 1,
        records: [
          {
            contentKey: contentKeyForLibraryItem(videoResult.items[0]),
            mediaId: 'v1',
            mediaType: 'video',
            name: 'clip.mp4',
            artist: null,
            playCount: 9,
            lastPlayedAt: '2026-06-01T10:00:00.000Z',
            lastPositionSec: 10,
            durationSec: 100,
            completed: false,
            events: [],
          },
          {
            contentKey: contentKeyForLibraryItem(videoResult.items[1]),
            mediaId: 'v2',
            mediaType: 'video',
            name: 'newer.mp4',
            artist: null,
            playCount: 1,
            lastPlayedAt: '2026-06-03T10:00:00.000Z',
            lastPositionSec: 20,
            durationSec: 100,
            completed: false,
            events: [],
          },
        ],
      });
    });

    fireEvent.click(screen.getByTestId('mobile-menu-peek'));
    const navigation = screen.getByTestId('mobile-navigation');
    const entry = within(navigation).getByRole('button', {
      name: /Recently Watching/,
    });
    expect(entry).toHaveTextContent('2');
    fireEvent.click(entry);

    const drawer = screen.getByTestId('playlist-drawer');
    const playButtons = within(drawer).getAllByRole('button', { name: /^Play / });
    expect(playButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Play newer.mp4',
      'Play clip.mp4',
    ]);
  });

  test('refreshes all libraries from the menu refresh button', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          audioRoots: [],
          videoRoots: [],
          imageRoots: [],
          itemCount: 9,
          persistent: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('menu-refresh-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('menu-refresh-button'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/media-roots',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(screen.getByTestId('menu-refresh-status')).toHaveTextContent(
        'Refreshed 9 items.',
      );
    });
  });

  test('prevents top-level downward touchmove for mobile pull-to-refresh', async () => {
    renderApp('/library/music');

    await waitFor(() => {
      expect(screen.getByTestId('mobile-menu-peek')).toBeInTheDocument();
    });

    const target = screen.getByTestId('mobile-menu-peek');
    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', {
      value: [{ clientY: 100 }],
    });
    target.dispatchEvent(start);

    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(move, 'touches', {
      value: [{ clientY: 132 }],
    });
    target.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
  });

  test('supports direct player links without a background route', async () => {
    const { playerStore } = renderApp('/player');
    act(() => {
      playerStore.getState().seedSource({
        kind: 'remote',
        mediaId: 'a1',
        mediaType: 'audio',
        url: '/api/media/a1',
        name: 'song.mp3',
      });
    });

    expect(screen.queryByTestId('player-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('player-screen')).toHaveTextContent(
      'song.mp3',
    );
  });

  test('opens the image viewer without clearing active playback', async () => {
    const { playerStore } = renderApp('/library/image');
    act(() => {
      playerStore.getState().seedSource({
        kind: 'remote',
        mediaId: 'a1',
        mediaType: 'audio',
        url: '/api/media/a1',
        name: 'song.mp3',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Open photo.jpg')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Open photo.jpg'));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/image/i1');
    });
    expect(screen.getByTestId('image-viewer-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
    expect(screen.getByTestId('image-viewer-image')).toHaveAttribute(
      'src',
      '/api/media/i1',
    );
    expect(screen.getByTestId('library-list')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('library-list')).getAllByText('photo.jpg'),
    ).not.toHaveLength(0);
    expect(screen.queryByTestId('mini-player')).not.toBeInTheDocument();
    expect(selectActiveState(playerStore.getState()).source?.mediaId).toBe('a1');

    fireEvent.click(screen.getByTestId('image-viewer-close'));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/library/image');
    });
    await waitFor(() => {
      expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    });
  });
});
