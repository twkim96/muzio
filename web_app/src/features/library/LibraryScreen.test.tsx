import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  LibraryFetchOptions,
  LibraryFetchResult,
} from '../../core/api/libraryClient';
import { LibraryProvider } from './LibraryContext';
import { LibraryScreen } from './LibraryScreen';
import { createLibraryStore } from './libraryStore';
import { PlayerProvider } from '../player/PlayerContext';
import { createPlayerStore } from '../player/playerStore';
import { PlaylistProvider } from '../playlists/PlaylistContext';
import { ProgressProvider } from '../progress/ProgressContext';
import type { ProgressRepository } from '../../core/storage/progressRepository';

function buildStores(audio: LibraryFetchResult, video: LibraryFetchResult, image: LibraryFetchResult) {
  return {
    audio: createLibraryStore({
      type: 'audio',
      fetcher: async () => audio,
    }),
    video: createLibraryStore({
      type: 'video',
      fetcher: async () => video,
    }),
    image: createLibraryStore({
      type: 'image',
      fetcher: async () => image,
    }),
  };
}

const emptyRepo: ProgressRepository = {
  read: () => null,
  write: () => {},
  clear: () => {},
  entries: () => [],
  mostRecent: () => null,
};

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;

beforeEach(() => {
  window.localStorage.clear();
});

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

function setNonMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 640px)' ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderScreen(
  type: 'audio' | 'video' | 'image',
  audio: LibraryFetchResult,
  video: LibraryFetchResult = { kind: 'ok', items: [] },
  image: LibraryFetchResult = { kind: 'ok', items: [] },
) {
  const stores = buildStores(audio, video, image);
  const playerStore = createPlayerStore();
  render(
    <LibraryProvider stores={stores}>
      <PlaylistProvider>
        <PlayerProvider store={playerStore}>
          <ProgressProvider repository={emptyRepo}>
            <MemoryRouter
              initialEntries={[
                `/library/${type === 'audio' ? 'music' : type === 'video' ? 'video' : 'image'}`,
              ]}
              future={routerFuture}
            >
              <LibraryScreen type={type} />
            </MemoryRouter>
          </ProgressProvider>
        </PlayerProvider>
      </PlaylistProvider>
    </LibraryProvider>,
  );
  return { stores, playerStore };
}

function firePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove',
  init: { pointerType: string; clientX: number; clientY: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: init.pointerType },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
  });
  fireEvent(target, event);
}

describe('LibraryScreen', () => {
  test('shows loading state on first render', async () => {
    let release!: (value: LibraryFetchResult) => void;
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        fetcher: () =>
          new Promise<LibraryFetchResult>((resolve) => {
            release = resolve;
          }),
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };

    render(
      <LibraryProvider stores={stores}>
        <PlaylistProvider>
          <PlayerProvider store={createPlayerStore()}>
            <ProgressProvider repository={emptyRepo}>
              <MemoryRouter future={routerFuture}>
                <LibraryScreen type="audio" />
              </MemoryRouter>
            </ProgressProvider>
          </PlayerProvider>
        </PlaylistProvider>
      </LibraryProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-loading')).toBeInTheDocument();
    });

    // Drain the in-flight promise so React is allowed to settle the next
    // state update inside act, otherwise the test exits while the store is
    // mid-resolution and the runtime warns.
    release({ kind: 'ok', items: [] });
    await waitFor(() => {
      expect(screen.queryByTestId('library-loading')).not.toBeInTheDocument();
    });
  });

  test('renders cached audio immediately and revalidates in the background', async () => {
    const seenEtags: Array<string | undefined> = [];
    const stores = {
      audio: createLibraryStore({
        type: 'audio',
        snapshotCache: {
          read: () => ({
            revision: 9,
            etag: 'W/"library-9-audio"',
            complete: true,
            items: [
              {
                id: 'cached-audio',
                type: 'audio',
                rootName: 'music',
                relativePath: 'cached.mp3',
                name: 'cached.mp3',
                sizeBytes: 1,
                modifiedAt: '2026-01-01T00:00:00Z',
              },
            ],
          }),
          write: () => {},
          clear: () => {},
        },
        fetcher: async (_type, options?: LibraryFetchOptions) => {
          seenEtags.push(options?.ifNoneMatch);
          return {
            kind: 'notModified',
            etag: options?.ifNoneMatch,
          };
        },
      }),
      video: createLibraryStore({ type: 'video' }),
      image: createLibraryStore({ type: 'image' }),
    };

    render(
      <LibraryProvider stores={stores}>
        <PlaylistProvider>
          <PlayerProvider store={createPlayerStore()}>
            <ProgressProvider repository={emptyRepo}>
              <MemoryRouter future={routerFuture}>
                <LibraryScreen type="audio" />
              </MemoryRouter>
            </ProgressProvider>
          </PlayerProvider>
        </PlaylistProvider>
      </LibraryProvider>,
    );

    expect(screen.getByText('cached.mp3')).toBeInTheDocument();
    expect(screen.queryByTestId('library-loading')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(seenEtags).toEqual(['W/"library-9-audio"']);
    });
    await waitFor(() => {
      expect(stores.audio.getState().stale).toBe(false);
    });
  });

  test('renders an empty state hint when there are no items', async () => {
    renderScreen('audio', { kind: 'ok', items: [] });
    await waitFor(() => {
      expect(screen.getByTestId('library-empty')).toBeInTheDocument();
    });
  });

  test('renders item rows on success', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
        {
          id: 'b',
          type: 'audio',
          rootName: 'music',
          relativePath: 'Album/track.mp3',
          name: 'track.mp3',
          sizeBytes: 1024 * 1024 * 5,
          modifiedAt: '2025-02-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('library-item')).toHaveLength(2);
    });
    expect(screen.getByText('song.mp3')).toBeInTheDocument();
    expect(screen.getByText('Album/')).toBeInTheDocument();
  });

  test('filters and toggles latest/name sorting', async () => {
    const { stores } = renderScreen('audio', {
      kind: 'ok',
      revision: 1,
      items: [
        {
          id: 'b',
          type: 'audio',
          rootName: 'music',
          relativePath: 'b.mp3',
          name: 'b.mp3',
          sizeBytes: 1,
          modifiedAt: '2025-02-01T00:00:00Z',
          metadata: { title: 'Beta', artist: 'Zoo' },
        },
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'a.mp3',
          name: 'a.mp3',
          sizeBytes: 1,
          modifiedAt: '2025-01-01T00:00:00Z',
          metadata: { title: 'Alpha', artist: 'Aster' },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('library-item')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent('Beta');

    fireEvent.click(screen.getByTestId('sort-toggle'));
    expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent('Alpha');

    fireEvent.change(screen.getByLabelText('Filter Music'), {
      target: { value: 'zoo' },
    });
    expect(screen.getAllByTestId('library-item')).toHaveLength(1);
    expect(screen.getByText('Beta')).toBeInTheDocument();

    act(() => {
      stores.audio.getState().applyChanges({
        kind: 'ok',
        revision: 2,
        deletedIds: [],
        resetRequired: false,
        upserts: [
          {
            id: 'c',
            type: 'audio',
            rootName: 'music',
            relativePath: 'c.mp3',
            name: 'c.mp3',
            sizeBytes: 1,
            modifiedAt: '2025-03-01T00:00:00Z',
            metadata: { title: 'Gamma', artist: 'Zoo' },
          },
        ],
      });
    });

    expect(screen.getByLabelText('Filter Music')).toHaveValue('zoo');
    expect(screen.getByTestId('sort-toggle')).toHaveAccessibleName(
      'Sort Music: Name order',
    );
    expect(screen.getByTestId('sort-toggle').querySelector('svg')).not.toBeNull();
    expect(screen.getAllByTestId('library-item')).toHaveLength(2);
    expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent('Beta');
  });

  test('keeps the three-line video row on mobile', async () => {
    const progressRepo: ProgressRepository = {
      ...emptyRepo,
      read: () => ({
        mediaId: 'v',
        positionSec: 30,
        durationSec: 120,
        lastPlayedAt: '2026-06-04T00:00:00Z',
        updatedAt: '2026-06-04T00:00:00Z',
      }),
    };
    const stores = buildStores(
      { kind: 'ok', items: [] },
      {
        kind: 'ok',
        items: [
          {
            id: 'v',
            type: 'video',
            rootName: 'videos',
            relativePath: 'clip.mp4',
            name: 'clip.mp4',
            sizeBytes: 1024,
            modifiedAt: '2026-06-04T00:00:00Z',
          },
        ],
      },
      { kind: 'ok', items: [] },
    );
    render(
      <LibraryProvider stores={stores}>
        <PlaylistProvider>
          <PlayerProvider store={createPlayerStore()}>
            <ProgressProvider repository={progressRepo}>
              <MemoryRouter initialEntries={['/library/video']} future={routerFuture}>
                <LibraryScreen type="video" />
              </MemoryRouter>
            </ProgressProvider>
          </PlayerProvider>
        </PlaylistProvider>
      </LibraryProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('clip.mp4').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('library-list')).toHaveAttribute('data-row-height', '78');
    expect(screen.getByTestId('library-list')).toHaveStyle({ height: '78px' });
    expect(screen.getByTestId('library-item')).toHaveClass('relative', 'overflow-hidden');
    expect(screen.getByTestId('library-item')).toHaveStyle({ height: '78px' });
    expect(screen.getByTestId('video-responsive-title')).toHaveClass(
      'max-h-12',
      'overflow-clip',
      'sm:truncate',
    );
    expect(screen.getByTestId('library-item-progress')).toHaveClass(
      'absolute',
      'bottom-0',
      'left-3',
      'right-3',
    );
  });

  test('plays a progress-marked video row from its saved position', async () => {
    const progressRepo: ProgressRepository = {
      ...emptyRepo,
      read: (id) =>
        id === 'v'
          ? {
              positionSec: 7_200,
              durationSec: 13_584,
              lastPlayedAt: '2026-07-04T00:00:00Z',
              source: {
                mediaType: 'video',
                name: 'clip.mp4',
                rootName: 'videos',
                relativePath: 'clip.mp4',
              },
            }
          : null,
    };
    const stores = buildStores(
      { kind: 'ok', items: [] },
      {
        kind: 'ok',
        items: [
          {
            id: 'v',
            type: 'video',
            rootName: 'videos',
            relativePath: 'clip.mp4',
            name: 'clip.mp4',
            sizeBytes: 1024,
            modifiedAt: '2026-07-04T00:00:00Z',
            metadata: { title: 'clip.mp4', durationSec: 13_584 },
          },
        ],
      },
      { kind: 'ok', items: [] },
    );
    const playerStore = createPlayerStore();
    render(
      <LibraryProvider stores={stores}>
        <PlaylistProvider>
          <PlayerProvider store={playerStore}>
            <ProgressProvider repository={progressRepo}>
              <MemoryRouter
                initialEntries={['/library/video']}
                future={routerFuture}
              >
                <LibraryScreen type="video" />
              </MemoryRouter>
            </ProgressProvider>
          </PlayerProvider>
        </PlaylistProvider>
      </LibraryProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('video-row-metadata')).toHaveTextContent('53%');
    });

    fireEvent.click(screen.getByLabelText('Play clip.mp4'));

    await waitFor(() => {
      expect(playerStore.getState().video.source?.url).toBe(
        '/api/media/v#t=7200',
      );
    });
  });

  test('uses a compact two-line video row on tablet and desktop', async () => {
    setNonMobileViewport(true);
    renderScreen(
      'video',
      { kind: 'ok', items: [] },
      {
        kind: 'ok',
        items: [
          {
            id: 'v',
            type: 'video',
            rootName: 'videos',
            relativePath: 'Series/clip.mp4',
            name: 'clip.mp4',
            sizeBytes: 1024,
            modifiedAt: '2026-06-04T00:00:00Z',
          },
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toHaveAttribute(
        'data-row-height',
        '54',
      );
    });
    expect(screen.getByTestId('library-item')).toHaveStyle({ height: '54px' });
    expect(screen.getByTestId('video-row-layout')).toHaveClass(
      'grid-cols-[minmax(0,1fr)_auto]',
    );
    expect(screen.getByTestId('video-responsive-title')).toHaveTextContent(
      'Series/clip.mp4',
    );
    expect(screen.getByLabelText('Play clip.mp4')).toBeInTheDocument();
  });

  test('keeps image text inside a comfortable mobile row', async () => {
    renderScreen(
      'image',
      { kind: 'ok', items: [] },
      { kind: 'ok', items: [] },
      {
        kind: 'ok',
        items: [
          {
            id: 'i',
            type: 'image',
            rootName: 'downloads',
            relativePath: 'Screenshots/스크린샷 06-07 오후 2 20 01.png',
            name: '스크린샷 06-07 오후 2 20 01.png',
            sizeBytes: 2048,
            modifiedAt: '2026-06-07T00:00:00Z',
          },
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toHaveAttribute(
        'data-row-height',
        '78',
      );
    });
    expect(screen.getByTestId('library-item')).toHaveStyle({ height: '78px' });
    expect(screen.getByTestId('image-row-layout')).toHaveClass(
      'grid-cols-[minmax(0,1fr)_auto]',
    );
    expect(screen.getByTestId('image-responsive-title')).toHaveClass(
      'max-h-12',
      'overflow-clip',
      'whitespace-normal',
    );
    expect(screen.getByTestId('image-row-metadata')).toHaveTextContent(
      'downloads · 2.0 KB',
    );
  });

  test('uses a compact two-line image row on tablet and desktop', async () => {
    setNonMobileViewport(true);
    renderScreen(
      'image',
      { kind: 'ok', items: [] },
      { kind: 'ok', items: [] },
      {
        kind: 'ok',
        items: [
          {
            id: 'i',
            type: 'image',
            rootName: 'downloads',
            relativePath: 'Screenshots/capture.png',
            name: 'capture.png',
            sizeBytes: 2048,
            modifiedAt: '2026-06-07T00:00:00Z',
          },
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toHaveAttribute(
        'data-row-height',
        '54',
      );
    });
    expect(screen.getByTestId('library-item')).toHaveStyle({ height: '54px' });
    expect(screen.getByTestId('image-responsive-title')).toHaveTextContent(
      'Screenshots/capture.png',
    );
    expect(screen.getByLabelText('Open capture.png')).toBeInTheDocument();
  });

  test('playing an audio row seeds the full music queue', async () => {
    const { playerStore } = renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
        {
          id: 'b',
          type: 'audio',
          rootName: 'music',
          relativePath: 'Album/track.mp3',
          name: 'track.mp3',
          sizeBytes: 1024 * 1024 * 5,
          modifiedAt: '2025-02-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('library-item')).toHaveLength(2);
    });
    fireEvent.click(screen.getByLabelText('Play track.mp3'));

    await waitFor(() => {
      expect(playerStore.getState().musicQueue.map((item) => item.mediaId)).toEqual([
        'b',
        'a',
      ]);
      expect(playerStore.getState().musicQueueIndex).toBe(0);
    });

    fireEvent.click(screen.getByLabelText('Play song.mp3'));

    await waitFor(() => {
      expect(playerStore.getState().musicQueue.map((item) => item.mediaId)).toEqual([
        'b',
        'a',
        'a',
      ]);
      expect(playerStore.getState().musicQueueIndex).toBe(1);
    });
  });

  test('row add to library creates a custom playlist with the selected item', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('library-item-more'));
    const rowMenu = screen.getByTestId('library-row-menu');
    expect(rowMenu.parentElement).toBe(document.body);
    expect(rowMenu).toHaveClass('fixed');
    fireEvent.scroll(document);
    expect(screen.queryByTestId('library-row-menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('library-item-more'));
    fireEvent.click(screen.getByText('Add to Playlist'));
    expect(
      screen.getByLabelText('Close add to playlist').querySelector('svg'),
    ).not.toBeNull();
    fireEvent.change(screen.getByTestId('add-playlist-create-name'), {
      target: { value: 'Night' },
    });
    fireEvent.click(screen.getByTestId('add-playlist-confirm'));

    const stored = JSON.parse(
      window.localStorage.getItem('music.playlists.v1') ?? 'null',
    );
    expect(stored.playlists[0].name).toBe('Night');
    expect(stored.playlists[0].items).toHaveLength(1);
  });

  test('short mobile hold does not enter selection mode', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      firePointer(screen.getByLabelText('Play song.mp3'), 'pointerdown', {
        pointerType: 'touch',
        clientX: 120,
        clientY: 240,
      });
      act(() => {
        vi.advanceTimersByTime(650);
      });

      expect(screen.queryByTestId('selection-add-to-playlist')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('unknown pointer short hold uses the safer mobile threshold', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      const event = new Event('pointerdown', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(event, {
        clientX: { value: 120 },
        clientY: { value: 240 },
      });
      fireEvent(screen.getByLabelText('Play song.mp3'), event);
      act(() => {
        vi.advanceTimersByTime(650);
      });

      expect(screen.queryByTestId('selection-add-to-playlist')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('mobile tap playback clears pending long press timer', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      firePointer(screen.getByLabelText('Play song.mp3'), 'pointerdown', {
        pointerType: 'touch',
        clientX: 120,
        clientY: 240,
      });
      fireEvent.click(screen.getByLabelText('Play song.mp3'));
      await act(async () => {});
      act(() => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.queryByTestId('selection-add-to-playlist')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('mobile drag movement cancels long press selection mode', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      const row = screen.getByTestId('library-item');
      firePointer(row, 'pointerdown', {
        pointerType: 'touch',
        clientX: 120,
        clientY: 240,
      });
      firePointer(row, 'pointermove', {
        pointerType: 'touch',
        clientX: 120,
        clientY: 260,
      });
      act(() => {
        vi.advanceTimersByTime(800);
      });

      expect(screen.queryByTestId('selection-add-to-playlist')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('mobile touch swipe cancels long press selection mode', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      const row = screen.getByTestId('library-item');
      firePointer(row, 'pointerdown', {
        pointerType: 'touch',
        clientX: 120,
        clientY: 240,
      });
      fireEvent.touchMove(row, {
        touches: [{ clientX: 220, clientY: 245 }],
      });
      act(() => {
        vi.advanceTimersByTime(900);
      });

      expect(screen.queryByTestId('selection-add-to-playlist')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('mouse long press can still enter selection mode on desktop', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });

    vi.useFakeTimers();
    try {
      firePointer(screen.getByLabelText('Play song.mp3'), 'pointerdown', {
        pointerType: 'mouse',
        clientX: 120,
        clientY: 240,
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByTestId('selection-add-to-playlist')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('long press selection mode batch adds items to a custom playlist', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
        {
          id: 'b',
          type: 'audio',
          rootName: 'music',
          relativePath: 'track.mp3',
          name: 'track.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-02T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('library-item')).toHaveLength(2);
    });

    vi.useFakeTimers();
    try {
      firePointer(screen.getByLabelText('Play track.mp3'), 'pointerdown', {
        pointerType: 'touch',
        clientX: 120,
        clientY: 240,
      });
      act(() => {
        vi.advanceTimersByTime(800);
      });

      expect(screen.getByTestId('selection-add-to-playlist')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Play track.mp3'));
      fireEvent.click(screen.getByLabelText('Play song.mp3'));
      fireEvent.click(screen.getByTestId('selection-add-to-playlist'));
      fireEvent.change(screen.getByTestId('add-playlist-create-name'), {
        target: { value: 'Batch' },
      });
      fireEvent.click(screen.getByTestId('add-playlist-confirm'));

      const stored = JSON.parse(
        window.localStorage.getItem('music.playlists.v1') ?? 'null',
      );
      expect(stored.playlists[0].name).toBe('Batch');
      expect(stored.playlists[0].items).toHaveLength(2);
      expect(screen.queryByTestId('selection-add-to-playlist')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('audio rows can toggle liked state', async () => {
    const { playerStore } = renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });
    expect(
      screen.getByLabelText('Play song.mp3').querySelector('svg'),
    ).not.toBeNull();
    expect(screen.queryByTestId('library-item-download')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('library-item-more').querySelector('svg'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('library-item-like').querySelector('svg'),
    ).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Like song.mp3'));

    expect(playerStore.getState().likedMediaIds).toEqual(['audio:title:song']);
    expect(screen.getByLabelText('Unlike song.mp3')).toBeInTheDocument();
  });

  test('does not mount hidden music collections in the main list', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('music-collections-panel')).not.toBeInTheDocument();
  });

  test('virtualizes large lists instead of mounting every row', async () => {
    renderScreen('image', { kind: 'ok', items: [] }, { kind: 'ok', items: [] }, {
      kind: 'ok',
      items: Array.from({ length: 500 }, (_, index) => ({
        id: `image-${index}`,
        type: 'image',
        rootName: 'downloads',
        relativePath: `photo-${index}.jpg`,
        name: `photo-${index}.jpg`,
        sizeBytes: 1024,
        modifiedAt: `2025-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      })),
    });

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toHaveAttribute(
        'data-total-count',
        '500',
      );
    });
    expect(screen.getAllByTestId('library-item').length).toBeLessThan(80);
    expect(screen.getByTestId('library-list')).toHaveAttribute(
      'data-rendered-count',
      String(screen.getAllByTestId('library-item').length),
    );
  });

  test('image rows use bounded server previews only for mounted virtual rows', async () => {
    renderScreen('image', { kind: 'ok', items: [] }, { kind: 'ok', items: [] }, {
      kind: 'ok',
      items: Array.from({ length: 120 }, (_, index) => ({
        id: `image-${index}`,
        type: 'image',
        rootName: 'downloads',
        relativePath: `photo-${index}.jpg`,
        name: `photo-${index}.jpg`,
        sizeBytes: 1024,
        modifiedAt: '2025-01-01T00:00:00Z',
        thumbnail: {
          url: `/api/thumbnails/image-${index}?v=abc`,
          kind: 'generated-fallback',
          status: 'ready',
          cacheKey: 'abc',
        },
      })),
    });

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toHaveAttribute(
        'data-total-count',
        '120',
      );
    });
    const rows = screen.getAllByTestId('library-item');
    expect(rows.length).toBeLessThan(40);
    const image = rows[0].querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe(
      '/api/thumbnails/image-0?v=abc',
    );
    expect(image?.getAttribute('src')).not.toContain('/api/media/');
  });

  test('video rows show the revalidating fallback while a frame is pending', async () => {
    const item = {
      id: 'video-pending',
      type: 'video' as const,
      rootName: 'downloads',
      relativePath: 'video-pending.mp4',
      name: 'video-pending.mp4',
      sizeBytes: 1024,
      modifiedAt: '2025-01-01T00:00:00Z',
      thumbnail: {
        url: '/api/thumbnails/video-pending?v=abc&state=pending',
        kind: 'generated-frame',
        status: 'pending',
        cacheKey: 'abc',
      },
    };
    const { stores } = renderScreen(
      'video',
      { kind: 'ok', items: [] },
      { kind: 'ok', revision: 1, items: [item] },
    );

    await waitFor(() => {
      const image = screen.getByTestId('library-item').querySelector('img');
      expect(image?.getAttribute('src')).toContain('state=pending');
    });

    act(() => {
      stores.video.getState().applyChanges({
        kind: 'ok',
        revision: 2,
        deletedIds: [],
        resetRequired: false,
        upserts: [
          {
            ...item,
            thumbnail: {
              ...item.thumbnail,
              url: '/api/thumbnails/video-pending?v=abc&state=ready',
              status: 'ready',
            },
          },
        ],
      });
    });

    await waitFor(() => {
      const image = screen.getByTestId('library-item').querySelector('img');
      expect(image?.getAttribute('src')).toContain('state=ready');
    });
  });


  test('renders an error message on unreachable backend', async () => {
    renderScreen('audio', { kind: 'unreachable', message: 'refused' });
    await waitFor(() => {
      expect(screen.getByTestId('library-error')).toHaveTextContent(
        /Backend unreachable: refused/,
      );
    });
  });

  test('renders an error message on bad response', async () => {
    renderScreen('audio', { kind: 'badResponse', statusCode: 500 });
    await waitFor(() => {
      expect(screen.getByTestId('library-error')).toHaveTextContent(
        /HTTP 500/,
      );
    });
  });

  test('uses the audio store when type=audio and the video store when type=video', async () => {
    const audioOnly: LibraryFetchResult = {
      kind: 'ok',
      items: [
        {
          id: 'audio-only',
          type: 'audio',
          rootName: 'r',
          relativePath: 'song.mp3',
          name: 'song.mp3',
          sizeBytes: 1,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    };
    const videoOnly: LibraryFetchResult = {
      kind: 'ok',
      items: [
        {
          id: 'video-only',
          type: 'video',
          rootName: 'r',
          relativePath: 'clip.mp4',
          name: 'clip.mp4',
          sizeBytes: 1,
          modifiedAt: '2025-01-01T00:00:00Z',
        },
      ],
    };

    renderScreen('audio', audioOnly, videoOnly);
    await waitFor(() => {
      expect(screen.getByText('song.mp3')).toBeInTheDocument();
    });
    expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument();
  });

  test('does not render a screen-level refresh button', async () => {
    renderScreen('audio', { kind: 'ok', items: [] });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Music' })).toBeInTheDocument();
    });

    expect(screen.queryByTestId('refresh-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('library-refresh-status')).not.toBeInTheDocument();
  });
});
