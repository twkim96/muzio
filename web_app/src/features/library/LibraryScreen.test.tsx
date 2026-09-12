import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  LibraryFetchOptions,
  LibraryFetchResult,
  LibraryItem,
} from '../../core/api/libraryClient';
import { LibraryProvider } from './LibraryContext';
import { LibraryScreen } from './LibraryScreen';
import { createLibraryStore } from './libraryStore';
import { PlayerProvider } from '../player/PlayerContext';
import { createPlayerStore } from '../player/playerStore';
import { PlaylistProvider } from '../playlists/PlaylistContext';
import { ProgressProvider } from '../progress/ProgressContext';
import type { ProgressRepository } from '../../core/storage/progressRepository';
import { GlassModal } from '../../core/ui/GlassModal';

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
  artistSearch?: string,
) {
  const stores = buildStores(audio, video, image);
  const playerStore = createPlayerStore();
  const view = render(
    <LibraryProvider stores={stores}>
      <PlaylistProvider>
        <PlayerProvider store={playerStore}>
          <ProgressProvider repository={emptyRepo}>
            <MemoryRouter
              initialEntries={[
                { pathname: `/library/${type === 'audio' ? 'music' : type === 'video' ? 'video' : 'image'}`, state: { artistSearch } },
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
  return {
    stores,
    playerStore,
    rerenderType: (nextType: 'audio' | 'video' | 'image') => view.rerender(
      <LibraryProvider stores={stores}>
        <PlaylistProvider>
          <PlayerProvider store={playerStore}>
            <ProgressProvider repository={emptyRepo}>
              <MemoryRouter
                initialEntries={[
                  `/library/${nextType === 'audio' ? 'music' : nextType === 'video' ? 'video' : 'image'}`,
                ]}
                future={routerFuture}
              >
                <LibraryScreen type={nextType} />
              </MemoryRouter>
            </ProgressProvider>
          </PlayerProvider>
        </PlaylistProvider>
      </LibraryProvider>,
    ),
    unmount: view.unmount,
  };
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
    expect(screen.queryByText('Album/')).not.toBeInTheDocument();
    expect(screen.getByText('track.mp3')).toBeInTheDocument();
  });

  test('sorts by column text in both directions and preserves filtering', async () => {
    const { stores } = renderScreen('audio', {
      kind: 'ok',
      revision: 1,
      items: [
        {
          id: 'b',
          type: 'audio',
          rootName: 'z-music',
          relativePath: 'b.mp3',
          name: 'b.mp3',
          sizeBytes: 20,
          modifiedAt: '2025-02-01T00:00:00Z',
          metadata: { title: 'Beta', artist: 'Zoo' },
        },
        {
          id: 'a',
          type: 'audio',
          rootName: 'a-music',
          relativePath: 'a.mp3',
          name: 'a.mp3',
          sizeBytes: 10,
          modifiedAt: '2025-01-01T00:00:00Z',
          metadata: { title: 'Alpha', artist: 'Aster' },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('library-item')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent('Beta');

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Song' }));
    expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent('Alpha');

    for (const [column, first, second] of [
      ['Artist', 'Alpha', 'Beta'],
      ['Size', 'Beta', 'Alpha'],
      ['Modified', 'Beta', 'Alpha'],
      ['Library', 'Alpha', 'Beta'],
    ]) {
      const button = screen.getByRole('button', { name: `Sort by ${column}` });
      fireEvent.click(button);
      expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent(first);
      fireEvent.click(button);
      expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent(second);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Song' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Song' }));
    expect(screen.getAllByTestId('library-item')[0]).toHaveTextContent('Beta');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Song' }));

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
    expect(screen.getByRole('button', { name: 'Sort by Song' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('sort-toggle')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('library-list')).toHaveAttribute('data-layout', 'video-cards');
    expect(screen.getByTestId('video-responsive-title')).toHaveClass('line-clamp-2');
    expect(screen.getByLabelText('Play clip.mp4')).toBeInTheDocument();
    expect(screen.getByTestId('library-item-more')).toHaveClass('inline-flex');
    expect(screen.getByTestId('library-item-progress')).toBeInTheDocument();
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
        '/api/media/v?v=2#t=7200',
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
      expect(screen.getByTestId('library-list')).toHaveAttribute('data-layout', 'video-cards');
    });
    expect(screen.getByTestId('video-responsive-title')).toHaveTextContent('clip.mp4');
    expect(screen.getByTestId('video-row-metadata')).toHaveTextContent('Series');
    expect(screen.getByLabelText('Play clip.mp4')).toBeInTheDocument();
  });

  test('keeps audio metadata in a compact two-line mobile row', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'Album/song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2026-08-10T00:00:00Z',
          metadata: {
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            durationSec: 125,
          },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('library-list')).toHaveAttribute(
        'data-row-height',
        '54',
      );
    });
    expect(screen.getByTestId('library-item')).toHaveStyle({ height: '54px' });
    expect(screen.getByTestId('audio-row-title')).toHaveTextContent(/^Song$/);
    expect(screen.getByTestId('audio-mobile-metadata')).not.toHaveTextContent('2026-08-10');
    expect(screen.getByTestId('audio-mobile-metadata')).toHaveTextContent(
      'Artist | 1.0 KB | music',
    );
    expect(
      screen.getByTestId('audio-mobile-metadata'),
    ).not.toHaveTextContent('Album');
    expect(
      screen.getByTestId('audio-mobile-metadata'),
    ).not.toHaveTextContent('2m');
  });

  test('shows the filename without parent directories when a song has no title metadata', async () => {
    renderScreen('audio', {
      kind: 'ok',
      items: [{
        id: 'untagged', type: 'audio', rootName: 'Phone',
        relativePath: 'EHGC/EHG collection 2/Track.mp3', name: 'Track.mp3',
        sizeBytes: 1024, modifiedAt: '2026-08-10T00:00:00Z',
      }],
    });

    expect(await screen.findByTestId('audio-row-title')).toHaveTextContent(/^Track\.mp3$/);
    expect(screen.getByTestId('audio-mobile-metadata')).toHaveTextContent(/^1\.0 KB \| Phone$/);
  });

  test('uses artist, size, modified date, and library columns on desktop', async () => {
    setNonMobileViewport(true);
    renderScreen('audio', {
      kind: 'ok',
      items: [
        {
          id: 'a',
          type: 'audio',
          rootName: 'music',
          relativePath: 'Album/song.mp3',
          name: 'song.mp3',
          sizeBytes: 1024,
          modifiedAt: '2026-08-10T00:00:00Z',
          metadata: {
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            durationSec: 125,
          },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('library-item')).toBeInTheDocument();
    });
    expect(screen.getByText('Size')).toBeInTheDocument();
    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getAllByText('1.0 KB').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-08-10').length).toBeGreaterThan(0);
    expect(screen.getAllByText('music').length).toBeGreaterThan(0);
    expect(screen.queryByText('Time')).not.toBeInTheDocument();
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
      'downloads | 2.0 KB',
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

  test('uses a thumbnail-only ready update when starting audio playback', async () => {
    const pendingItem: LibraryItem = {
      id: 'a',
      type: 'audio',
      rootName: 'music',
      relativePath: 'song.m4a',
      name: 'song.m4a',
      sizeBytes: 1024,
      modifiedAt: '2026-08-11T00:00:00Z',
      thumbnail: {
        url: '/api/thumbnails/a?v=cover&state=pending',
        kind: 'embedded-artwork',
        status: 'pending',
        cacheKey: 'cover',
      },
    };
    const { stores, playerStore } = renderScreen('audio', {
      kind: 'ok',
      revision: 1,
      items: [pendingItem],
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Play song.m4a')).toBeInTheDocument();
    });

    act(() => {
      stores.audio.getState().applyChanges({
        kind: 'ok',
        revision: 2,
        resetRequired: false,
        deletedIds: [],
        upserts: [
          {
            ...pendingItem,
            thumbnail: {
              ...pendingItem.thumbnail!,
              url: '/api/thumbnails/a?v=cover&state=ready',
              status: 'ready',
            },
          },
        ],
      });
    });
    fireEvent.click(screen.getByLabelText('Play song.m4a'));

    await waitFor(() => {
      expect(playerStore.getState().audio.source?.artworkUrl).toBe(
        '/api/thumbnails/a?v=cover&state=ready',
      );
    });
  });

  test('row add to library creates a custom playlist with the selected item', async () => {
    setNonMobileViewport(true);
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

    vi.useFakeTimers();
    firePointer(screen.getByLabelText('Play song.mp3'), 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
    act(() => vi.advanceTimersByTime(800));
    vi.useRealTimers();
    fireEvent.click(screen.getByTestId('selection-add-to-playlist'));
    expect(screen.getByTestId('add-to-playlist-modal').parentElement).toBe(document.body);
    expect(screen.getByRole('dialog', { name: 'Add to Playlist' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('No playlists yet. Use + to create one.')).toBeInTheDocument();
    expect(screen.queryByTestId('add-playlist-create-name')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('music.playlists.v1')).toBeNull();
    fireEvent.click(screen.getByLabelText('Create playlist'));
    expect(screen.getByTestId('add-playlist-create-name')).toHaveFocus();
    expect(screen.getByTestId('add-playlist-confirm')).toBeDisabled();
    fireEvent.change(screen.getByTestId('add-playlist-create-name'), { target: { value: 'Night' } });
    screen.getByTestId('add-playlist-confirm').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByLabelText('Close add to playlist')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByTestId('add-playlist-confirm')).toHaveFocus();
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

  test.each(['audio', 'video'] as const)('only one %s copy menu opens and copies the displayed title', async type => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const result = { kind: 'ok' as const, items: ['one', 'two'].map(id => ({
        id, type, rootName: 'library', relativePath: `${id}.mp4`, name: `${id}.mp4`,
        sizeBytes: 10, modifiedAt: '2026-01-01T00:00:00Z', metadata: { title: `Title ${id}` },
      })) };
      renderScreen(type, type === 'audio' ? result : { kind: 'ok', items: [] }, type === 'video' ? result : { kind: 'ok', items: [] });
      await screen.findByLabelText('More options for one.mp4');
      fireEvent.click(screen.getByLabelText('More options for one.mp4'));
      fireEvent.click(screen.getByLabelText('More options for two.mp4'));
      expect(screen.getAllByTestId('library-row-menu')).toHaveLength(1);
      expect(within(screen.getByTestId('library-row-menu')).getAllByRole('button')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: '누르면 복사됨' }));
      await screen.findByText('복사됨');
      expect(writeText).toHaveBeenCalledWith('Title two');
      expect(screen.queryByTestId('add-to-playlist-modal')).not.toBeInTheDocument();
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test('clears selection on media switches, text search, and applied filters', async () => {
    const item = (type: 'audio' | 'video' | 'image'): LibraryItem => ({
      id: type, type, rootName: type, relativePath: `${type}.mp4`, name: `${type}.mp4`,
      sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z',
    });
    const { rerenderType } = renderScreen('video', { kind: 'ok', items: [item('audio')] }, { kind: 'ok', items: [item('video')] }, { kind: 'ok', items: [item('image')] });
    const select = () => {
      vi.useFakeTimers();
      try {
        firePointer(screen.getByTestId('library-item'), 'pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
        act(() => vi.advanceTimersByTime(800));
      } finally { vi.useRealTimers(); }
      expect(screen.getByTestId('selection-actions')).toBeInTheDocument();
    };
    await screen.findByLabelText('Play video.mp4');
    select();
    rerenderType('audio');
    await screen.findByLabelText('Play audio.mp4');
    expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('library-item')).toHaveAttribute('data-selected', 'false');
    select();
    expect(screen.getByRole('group', { name: '1 selected items' })).toBeInTheDocument();
    rerenderType('image');
    await screen.findByLabelText('Open image.mp4');
    expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
    rerenderType('video');
    await screen.findByLabelText('Play video.mp4');
    select();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Video' }), { target: { value: 'video' } });
    expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
    select();
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    fireEvent.click(within(screen.getByTestId('library-filter-panel')).getByRole('button', { name: 'Show 1 items' }));
    expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
  });

  test('stacked glass modals isolate dismissal and restore focus and scroll', () => {
    setNonMobileViewport(true);
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    const underlyingPointer = vi.fn();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const overflow = document.body.style.overflow;
    const modal = (child: boolean) => (
      <div onPointerDown={underlyingPointer}>
        <GlassModal testId="parent-modal" title="Parent" onClose={closeParent}>
          <input aria-label="Parent name" />
          {child && <GlassModal testId="child-modal" title="Child" onClose={closeChild} alert>
            <input aria-label="Child name" />
          </GlassModal>}
        </GlassModal>
      </div>
    );
    const view = render(modal(false));
    expect(screen.getByLabelText('Parent name')).toHaveFocus();
    view.rerender(modal(true));
    expect(screen.getByRole('alertdialog', { name: 'Child' })).toBeInTheDocument();
    expect(screen.getByLabelText('Child name')).toHaveFocus();
    fireEvent.pointerDown(screen.getByLabelText('Close Child'));
    expect(underlyingPointer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('parent-modal'));
    expect(closeParent).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).not.toHaveBeenCalled();
    view.rerender(modal(false));
    expect(screen.getByLabelText('Parent name')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    view.unmount();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe(overflow);
    trigger.remove();
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

  test.each(['mouse', 'touch'])('long press with %s appends selected tracks using an icon-only queue button', async (pointerType) => {
    const items = ['song', 'track'].map((name, i) => ({ id: name, type: 'audio' as const, rootName: 'music', relativePath: name + '.mp3', name: name + '.mp3', sizeBytes: 1024, modifiedAt: `2025-01-0${i + 1}T00:00:00Z` }));
    const { playerStore } = renderScreen('audio', { kind: 'ok', items });
    await waitFor(() => expect(screen.getAllByTestId('library-item')).toHaveLength(2));
    fireEvent.click(screen.getByLabelText('Play song.mp3'));
    const before = playerStore.getState();
    vi.useFakeTimers();
    try {
      firePointer(screen.getByLabelText('Play track.mp3'), 'pointerdown', { pointerType, clientX: 120, clientY: 240 });
      act(() => { vi.advanceTimersByTime(800); });
      fireEvent.click(screen.getByLabelText('Play track.mp3'));
      fireEvent.click(screen.getByLabelText('Play song.mp3'));
      const button = screen.getByRole('button', { name: 'Add selected items to queue' });
      expect(button.textContent).toBe('');
      fireEvent.click(button);
      const after = playerStore.getState();
      expect(after.musicQueue.slice(-2).map(s => s.mediaId)).toEqual(['track', 'song']);
      expect(after.musicQueue).toHaveLength(before.musicQueue.length + 2);
      expect(after.musicQueueIndex).toBe(before.musicQueueIndex);
      expect(after.audio).toBe(before.audio);
      expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(localStorage.getItem('music.playlists.v1')).toBeNull();
    } finally { vi.useRealTimers(); }
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

      const trackRow = screen.getByLabelText('Play track.mp3').closest('li')!;
      const songRow = screen.getByLabelText('Play song.mp3').closest('li')!;
      expect(trackRow).toHaveAttribute('data-selected', 'true');
      expect(trackRow).toContainElement(screen.getByTestId('selection-actions'));
      fireEvent.click(screen.getByLabelText('Play track.mp3')); // Suppress long-press release click.
      fireEvent.click(screen.getByLabelText('Play song.mp3'));
      expect(songRow).toHaveAttribute('data-selected', 'true');
      expect(songRow.className).not.toContain('hover:bg-');
      expect(songRow).toContainElement(screen.getByTestId('selection-actions'));
      expect(trackRow).toHaveAttribute('data-selected', 'true');
      fireEvent.click(screen.getByTestId('selection-add-to-playlist'));
      fireEvent.click(screen.getByLabelText('Create playlist'));
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
      expect(songRow).toHaveAttribute('data-selected', 'false');
      expect(trackRow).toHaveAttribute('data-selected', 'false');

      // A second batch targets the existing playlist immediately and excludes duplicates.
      const hold = () => {
        firePointer(screen.getByLabelText('Play track.mp3'), 'pointerdown', {
          pointerType: 'touch', clientX: 120, clientY: 240,
        });
        act(() => { vi.advanceTimersByTime(800); });
        fireEvent.click(screen.getByLabelText('Play track.mp3'));
      };
      hold();
      fireEvent.click(screen.getByLabelText('Play song.mp3'));
      fireEvent.click(screen.getByTestId('selection-add-to-playlist'));
      fireEvent.click(screen.getByLabelText('Create playlist'));
      fireEvent.change(screen.getByTestId('add-playlist-create-name'), { target: { value: 'Cancelled' } });
      fireEvent.click(within(screen.getByTestId('add-to-playlist-modal')).getByRole('button', { name: /^Cancel$/ }));
      expect(JSON.parse(window.localStorage.getItem('music.playlists.v1')!).playlists).toHaveLength(1);
      fireEvent.click(within(screen.getByTestId('add-to-playlist-modal')).getByRole('button', { name: 'Batch' }));
      expect(screen.queryByTestId('add-to-playlist-modal')).not.toBeInTheDocument();
      expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem('music.playlists.v1')!).playlists[0].items).toHaveLength(2);

      hold();
      fireEvent.click(screen.getByLabelText('Play song.mp3'));
      fireEvent.click(screen.getByLabelText('Play song.mp3')); // Anchor falls back to remaining selection.
      expect(trackRow).toContainElement(screen.getByTestId('selection-actions'));
      fireEvent.click(screen.getByLabelText('Play track.mp3'));
      expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
      hold();
      fireEvent.click(screen.getByLabelText('Clear selection'));
      expect(screen.queryByTestId('selection-actions')).not.toBeInTheDocument();
      expect(trackRow).toHaveAttribute('data-selected', 'false');

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

  test('video cards reach the final item after scrolling and remain reachable after resize', async () => {
    let scrollTop = 0;
    let width = 1000;
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'library-list'
        ? { ...originalRect.call(this), top: -scrollTop, width } as DOMRect
        : originalRect.call(this);
    });
    try {
      renderScreen('video', { kind: 'ok', items: [] }, {
        kind: 'ok', items: Array.from({ length: 500 }, (_, index) => ({
          id: `video-${index}`, type: 'video' as const, rootName: 'videos',
          relativePath: `clip-${String(index).padStart(3, '0')}.mp4`,
          name: `clip-${String(index).padStart(3, '0')}.mp4`, sizeBytes: 1024,
          modifiedAt: '2025-01-01T00:00:00Z',
        })),
      });
      await waitFor(() => expect(screen.getByTestId('library-list')).toHaveAttribute('data-total-count', '500'));
      const list = screen.getByTestId('library-list');
      expect(Number(list.dataset.columns)).toBeGreaterThan(1);
      expect(screen.getAllByTestId('library-item').length).toBeLessThan(100);
      scrollTop = parseFloat(list.style.height) - window.innerHeight;
      fireEvent.scroll(window);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
      await waitFor(() => expect(screen.getByLabelText('Play clip-499.mp4')).toBeInTheDocument());
      width = 390;
      fireEvent.resize(window);
      await waitFor(() => expect(list).toHaveAttribute('data-columns', '1'));
      scrollTop = parseFloat(list.style.height) - window.innerHeight;
      fireEvent.scroll(window);
      await waitFor(() => expect(screen.getByLabelText('Play clip-499.mp4')).toBeInTheDocument());
      expect(screen.getAllByTestId('library-item').length).toBeLessThan(100);
    } finally {
      rectSpy.mockRestore();
    }
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


describe('library filter panel', () => {
  const items: LibraryItem[] = Array.from({ length: 32 }, (_, index) => ({
    id: `filter-${index}`, type: 'audio', name: `Track ${index}.mp3`, relativePath: `Track ${index}.mp3`,
    rootName: index % 2 === 0 ? 'Device' : 'Server', location: index % 2 === 0 ? 'local' : 'network',
    storageId: index % 2 === 0 ? 'phone' : undefined, sizeBytes: index + 1, modifiedAt: '2026-06-01T00:00:00Z',
    metadata: { artist: `Artist ${String(index).padStart(2, '0')}`, title: `Track ${index}` },
  }));
  test('pages full-library artist tags by 15 and applies storage/source facets', async () => {
    renderScreen('audio', { kind: 'ok', items });
    await screen.findByTestId('library-list');
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    const panel = screen.getByTestId('library-filter-panel');
    expect(within(screen.getByTestId('visible-artist-tags')).getAllByTestId('artist-filter-tag')).toHaveLength(15);
    fireEvent.click(within(panel).getByText('More artists (15)'));
    expect(within(screen.getByTestId('visible-artist-tags')).getAllByTestId('artist-filter-tag')).toHaveLength(30);
    fireEvent.click(within(panel).getByText('More artists (15)'));
    expect(within(screen.getByTestId('visible-artist-tags')).getAllByTestId('artist-filter-tag')).toHaveLength(32);
    expect(within(panel).queryByText('More artists (15)')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Storage Device (Offline)' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Offline source' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 16 items' }));
    expect(screen.getAllByTestId('library-item').every((row) => Number(row.getAttribute('data-media-id')?.split('-')[1]) % 2 === 0)).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove Offline source' })).toBeInTheDocument();
  });
  test('toggles sort direction with one control and applies the selected order', async () => {
    renderScreen('audio', { kind: 'ok', items: items.slice(0, 3) });
    await screen.findByTestId('library-list');
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    const panel = screen.getByTestId('library-filter-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Panel sort by Size' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Descending: switch to ascending' }));
    expect(within(panel).getByRole('button', { name: 'Ascending: switch to descending' })).toBeEnabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 3 items' }));
    expect(screen.getAllByTestId('library-item').map((row) => row.getAttribute('data-media-id'))).toEqual(['filter-0', 'filter-1', 'filter-2']);
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ascending: switch to descending' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 items' }));
    expect(screen.getAllByTestId('library-item').map((row) => row.getAttribute('data-media-id'))).toEqual(['filter-2', 'filter-1', 'filter-0']);
  });
  test('synchronizes panel sorting, query artist tags, chips and reset', async () => {
    renderScreen('audio', { kind: 'ok', items });
    await screen.findByTestId('library-list');
    const search = screen.getByRole('textbox', { name: 'Filter Music' });
    fireEvent.change(search, { target: { value: 'Track #Artist 02' } });
    await waitFor(() => expect(screen.getAllByTestId('library-item')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Remove artist Artist 02' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    const panel = screen.getByTestId('library-filter-panel');
    expect(within(panel).getByRole('button', { name: 'Artist Artist 02' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(panel).getByRole('button', { name: 'Panel sort by Size' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 1 items' }));
    expect(screen.getByRole('button', { name: 'Sort by Size' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove artist Artist 02' }));
    expect(search).toHaveValue('Track');
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show 32 items' }));
    expect(search).toHaveValue('');
    expect(screen.queryByRole('button', { name: /Remove artist/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort by Modified' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('restores query, artist tag, and sort after reopening the library', async () => {
    const audio: LibraryFetchResult = {
      kind: 'ok',
      items: [
        {
          id: 'restore-a', type: 'audio', rootName: 'music', relativePath: 'alpha.mp3', name: 'alpha.mp3',
          sizeBytes: 2, modifiedAt: '2026-01-01T00:00:00Z', metadata: { title: 'Alpha', artist: 'Muse' },
        },
        {
          id: 'restore-b', type: 'audio', rootName: 'music', relativePath: 'beta.mp3', name: 'beta.mp3',
          sizeBytes: 1, modifiedAt: '2026-01-02T00:00:00Z', metadata: { title: 'Beta', artist: 'Other' },
        },
      ],
    };
    const first = renderScreen('audio', audio);
    await screen.findByTestId('library-list');
    const search = screen.getByRole('textbox', { name: 'Filter Music' });
    fireEvent.change(search, { target: { value: '#Muse' } });
    await waitFor(() => expect(screen.getAllByTestId('library-item')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    const panel = screen.getByTestId('library-filter-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Panel sort by Size' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 1 items' }));
    first.unmount();

    renderScreen('audio', audio);
    await screen.findByTestId('library-list');
    expect(screen.getByRole('textbox', { name: 'Filter Music' })).toHaveValue('#"Muse"');
    expect(screen.getByRole('button', { name: 'Remove artist Muse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort by Size' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('library-item')).toHaveLength(1);
    expect(screen.getByTestId('library-item')).toHaveAttribute('data-media-id', 'restore-a');
  });

  test('keeps query and sort isolated when switching media types', async () => {
    const { rerenderType } = renderScreen('audio', {
      kind: 'ok',
      items: [{
        id: 'audio-isolated', type: 'audio', rootName: 'music', relativePath: 'audio.mp3', name: 'audio.mp3',
        sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z', metadata: { title: 'Audio', artist: 'Audio Artist' },
      }],
    }, {
      kind: 'ok',
      items: [{
        id: 'video-isolated', type: 'video', rootName: 'video', relativePath: 'video.mp4', name: 'video.mp4',
        sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z',
      }],
    });
    await screen.findByTestId('library-list');
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Music' }), { target: { value: 'Audio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    let panel = screen.getByTestId('library-filter-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Panel sort by Size' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 1 items' }));

    rerenderType('video');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Filter Video' })).toHaveValue(''));
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Video' }), { target: { value: 'Video' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter library' }));
    panel = screen.getByTestId('library-filter-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Panel sort by Modified' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Show 1 items' }));

    rerenderType('audio');
    expect(screen.getByRole('textbox', { name: 'Filter Music' })).toHaveValue('Audio');
    expect(screen.getByRole('button', { name: 'Sort by Size' })).toHaveAttribute('aria-pressed', 'true');
    rerenderType('video');
    expect(screen.getByRole('textbox', { name: 'Filter Video' })).toHaveValue('Video');
    expect(screen.getByRole('button', { name: 'Sort by Modified' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test('player artist navigation filters by artist rather than a title substring', async () => {
  const item = (id: string, artist: string): LibraryItem => ({ id, name: `${id}.mp3`, type: 'audio',
    rootName: 'Music', relativePath: `${id}.mp3`, sizeBytes: 100, modifiedAt: '',
    metadata: { artist, title: id } });
  renderScreen('audio', { kind: 'ok', items: [item('match', 'Artist Name'), item('Artist Name in title', 'Other')] },
    undefined, undefined, 'Artist Name');
  await waitFor(() => expect(screen.getAllByTestId('library-item')).toHaveLength(1));
  expect(screen.getByTestId('library-item')).toHaveTextContent('match');
  expect(screen.getByRole('button', { name: 'Remove artist Artist Name' })).toBeInTheDocument();
});
