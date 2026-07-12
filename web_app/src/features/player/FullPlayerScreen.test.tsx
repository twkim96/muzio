import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import * as fallbackClient from '../../core/api/fallbackClient';
import type { LibraryFetchResult, LibraryItem } from '../../core/api/libraryClient';
import type { MediaElementLike } from '../../core/playback/engine/engine';
import type {
  PlaybackSession,
  PlaybackState,
  SessionListener,
} from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import { createLocalStorageProgressRepository } from '../../core/storage/progressRepository';
import { LibraryProvider, type LibraryStores } from '../library/LibraryContext';
import { createLibraryStore } from '../library/libraryStore';
import { ProgressProvider } from '../progress/ProgressContext';
import { FullPlayerScreen } from './FullPlayerScreen';
import { PlayerProvider } from './PlayerContext';
import { AUDIO_NETWORK_RETRY_HINT_DELAY_MS } from './playbackNetworkStatus';
import { VideoSurfaceProvider } from './VideoMount';
import { createPlayerStore } from './playerStore';

function fakeElement(): MediaElementLike {
  return {
    src: '',
    currentTime: 0,
    duration: NaN,
    paused: true,
    load: () => {},
    play: async () => {},
    pause: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function dispatchPointerEvent(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: {
    button?: number;
    buttons?: number;
    clientX: number;
    clientY?: number;
    pointerId: number;
    pointerType: string;
  },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    buttons: { value: init.buttons ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY ?? 0 },
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
  });
  fireEvent(target, event);
}

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;

const audioSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'a1',
  mediaType: 'audio',
  url: '/api/media/a1',
  name: 'song.mp3',
};

const videoSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'v1',
  mediaType: 'video',
  url: '/api/media/v1',
  name: 'clip.mp4',
  rootName: 'videos',
  relativePath: 'clips/clip.mp4',
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeSession(initial: PlaybackState): PlaybackSession & {
  calls: {
    load: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    seek: ReturnType<typeof vi.fn>;
  };
} {
  let state = initial;
  const listeners = new Set<SessionListener>();
  const emit = () => {
    for (const listener of [...listeners]) listener(state);
  };
  const calls = {
    load: vi.fn((source: PlaybackSource) => {
      state = {
        status: { kind: 'loading' },
        source,
        positionSec: 0,
        durationSec: 0,
      };
      emit();
    }),
    pause: vi.fn(() => {
      state = { ...state, status: { kind: 'paused' } };
      emit();
    }),
    play: vi.fn(async () => {
      state = { ...state, status: { kind: 'playing' } };
      emit();
    }),
    seek: vi.fn((positionSec: number) => {
      state = { ...state, positionSec };
      emit();
    }),
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: calls.load,
    play: calls.play,
    pause: calls.pause,
    seek: calls.seek,
    dispose: vi.fn(),
    calls,
  };
}

function createTestLibraryStores(
  video: LibraryFetchResult = { kind: 'ok', items: [] },
): LibraryStores {
  return {
    audio: createLibraryStore({
      type: 'audio',
      fetcher: async () => ({ kind: 'ok', items: [] }),
    }),
    video: createLibraryStore({
      type: 'video',
      fetcher: async () => video,
    }),
    image: createLibraryStore({
      type: 'image',
      fetcher: async () => ({ kind: 'ok', items: [] }),
    }),
  };
}

function renderScreen(
  store: ReturnType<typeof createPlayerStore>,
  options: {
    libraryStores?: LibraryStores;
    progressRepository?: ReturnType<typeof createLocalStorageProgressRepository>;
  } = {},
) {
  const progressRepository =
    options.progressRepository ?? createLocalStorageProgressRepository();
  return render(
    <LibraryProvider stores={options.libraryStores ?? createTestLibraryStores()}>
      <PlayerProvider store={store}>
        <ProgressProvider repository={progressRepository}>
          <VideoSurfaceProvider>
            <MemoryRouter future={routerFuture} initialEntries={['/player']}>
              <FullPlayerScreen />
              <LocationProbe />
            </MemoryRouter>
          </VideoSurfaceProvider>
        </ProgressProvider>
      </PlayerProvider>
    </LibraryProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function CollapsiblePlayerHarness() {
  const [open, setOpen] = useState(true);
  return open ? (
    <FullPlayerScreen onCollapse={() => setOpen(false)} />
  ) : (
    <div data-testid="collapsed-target">Collapsed</div>
  );
}

function videoItem(
  id: string,
  name: string,
  overrides: Partial<LibraryItem> = {},
): LibraryItem {
  return {
    id,
    type: 'video',
    rootName: 'videos',
    relativePath: `clips/${name}`,
    name,
    mimeType: 'video/mp4',
    sizeBytes: 1048576,
    modifiedAt: '2026-07-04T00:00:00Z',
    metadata: {
      title: name.replace(/\.[^.]+$/, ''),
      durationSec: 120,
    },
    thumbnail: {
      url: `/api/thumbnails/${id}?v=1`,
      kind: 'video',
      status: 'ready',
      cacheKey: '1',
    },
    subtitles: [],
    ...overrides,
  };
}

describe('FullPlayerScreen', () => {
  test('renders the empty placeholder when nothing is loaded', () => {
    const store = createPlayerStore();
    renderScreen(store);
    expect(screen.getByText('Nothing is playing.')).toBeInTheDocument();
  });

  test('renders the now-playing art for audio sources', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'a1',
      mediaType: 'audio',
      url: '/api/media/a1',
      name: 'song.mp3',
    });
    renderScreen(store);
    expect(screen.getByTestId('now-playing-art')).toBeInTheDocument();
    const close = screen.getByTestId('player-close');
    expect(close).toHaveAccessibleName('Collapse music player');
    expect(close).not.toHaveTextContent('×');
    fireEvent.click(close);
    expect(screen.getByTestId('location')).toHaveTextContent('/library/music');
    expect(screen.queryByTestId('video-viewport')).not.toBeInTheDocument();
  });

  test('renders a flat icon-only action row without horizontal scrolling', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );

    renderScreen(store);

    const actionRail = screen.getByTestId('player-action-rail');
    expect(actionRail).toBeInTheDocument();
    expect(screen.getByTestId('full-status')).toHaveClass('invisible');
    expect(actionRail).toHaveClass('grid-cols-6');
    expect(actionRail).toHaveClass('overflow-visible');
    expect(actionRail).not.toHaveClass('overflow-x-auto');
    expect(screen.queryByTestId('full-network-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('transport-controls')).toBeInTheDocument();
    expect(screen.getByTestId('stop-after-current')).toBeInTheDocument();
    expect(screen.queryByTestId('single-track-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen-toggle')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Fullscreen')).not.toBeInTheDocument();
    expect(screen.getByTestId('shuffle-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('repeat-toggle')).toBeInTheDocument();
    for (const button of actionRail.querySelectorAll('button')) {
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.textContent).toBe('');
    }

    fireEvent.click(screen.getByLabelText('Sleep timer'));
    expect(screen.getByTestId('sleep-timer-control')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('sleep-timer-control')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Volume'));
    expect(screen.getByTestId('volume-control')).toBeInTheDocument();
    expect(screen.queryByText('Like')).not.toBeInTheDocument();
    expect(screen.queryByText('Timer')).not.toBeInTheDocument();
  });

  test('shows a delayed audio loading network hint in full player', () => {
    vi.useFakeTimers();
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'loading' },
        source: audioSource,
        positionSec: 0,
        durationSec: 100,
      }),
    );

    renderScreen(store);
    expect(screen.queryByTestId('full-network-hint')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(AUDIO_NETWORK_RETRY_HINT_DELAY_MS - 1);
    });
    expect(screen.queryByTestId('full-network-hint')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByTestId('full-network-hint')).toHaveTextContent(
      'Still loading audio. Network may be slow.',
    );
  });

  test('full player retry from playback error calls play', () => {
    const session = fakeSession({
      status: { kind: 'error', message: 'network failed' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);

    renderScreen(store);
    expect(screen.getByTestId('full-network-hint')).toHaveTextContent(
      'Playback error. Retry when ready.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(session.calls.play).toHaveBeenCalledOnce();
  });

  test('full player volume keeps tracking touch drags after leaving the input', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    renderScreen(store);

    fireEvent.click(screen.getByLabelText('Volume'));
    const slider = screen.getByTestId('volume-slider');
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 0,
          width: 100,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect,
    });

    fireEvent.touchStart(slider, {
      touches: [{ clientX: 40, clientY: 360 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 20, clientY: 500 }],
    });

    expect(store.getState().volume).toBe(0.2);

    fireEvent.touchEnd(document, {
      changedTouches: [{ clientX: 80, clientY: 500 }],
    });

    expect(store.getState().volume).toBe(0.8);
  });

  test('action row ignores horizontal scroll gestures and keeps buttons clickable', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );

    renderScreen(store);

    const actionRail = screen.getByTestId('player-action-rail');
    Object.defineProperty(actionRail, 'clientWidth', {
      configurable: true,
      value: 240,
    });
    Object.defineProperty(actionRail, 'scrollWidth', {
      configurable: true,
      value: 900,
    });

    const like = screen.getByTestId('like-current');
    dispatchPointerEvent(like, 'pointerdown', {
      button: 0,
      clientX: 160,
      pointerId: 1,
      pointerType: 'touch',
    });
    dispatchPointerEvent(actionRail, 'pointermove', {
      clientX: 100,
      pointerId: 1,
      pointerType: 'touch',
    });
    dispatchPointerEvent(actionRail, 'pointerup', {
      clientX: 100,
      pointerId: 1,
      pointerType: 'touch',
    });
    fireEvent.wheel(actionRail, { deltaX: 0, deltaY: 50 });
    fireEvent.click(like);

    expect(actionRail.scrollLeft).toBe(0);
    expect(store.getState().likedMediaIds).toContain('audio:title:song');
  });

  test('pc mouse clicks on flat action buttons work', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );

    renderScreen(store);

    const timer = screen.getByLabelText('Sleep timer');
    dispatchPointerEvent(timer, 'pointerdown', {
      button: 0,
      clientX: 160,
      pointerId: 2,
      pointerType: 'mouse',
    });
    fireEvent.click(timer);

    expect(screen.getByTestId('sleep-timer-control')).toBeInTheDocument();

    const like = screen.getByTestId('like-current');
    fireEvent.mouseDown(like, {
      button: 0,
      clientX: 160,
    });
    fireEvent.click(like);

    expect(store.getState().likedMediaIds).toContain('audio:title:song');
  });

  test('contains browser pull-to-refresh while the full player is mounted', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );

    const { unmount } = renderScreen(store);
    expect(document.documentElement.style.overscrollBehaviorY).toBe('contain');
    expect(document.body.style.overscrollBehaviorY).toBe('contain');

    unmount();
    expect(document.documentElement.style.overscrollBehaviorY).toBe('');
    expect(document.body.style.overscrollBehaviorY).toBe('');
  });

  test('pulling down on the music player follows the drag and collapses past threshold', () => {
    vi.useFakeTimers();
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );

    renderScreen(store);
    const player = screen.getByTestId('player-screen');
    const motionLayer = screen.getByTestId('player-motion-layer');

    fireEvent.mouseDown(player, { clientX: 120, clientY: 40 });
    fireEvent.mouseMove(player, { clientX: 124, clientY: 90 });
    expect(motionLayer).toHaveStyle({ transform: 'translateY(50px)' });
    fireEvent.mouseUp(player, { clientX: 124, clientY: 90 });
    expect(screen.getByTestId('location')).toHaveTextContent('/player');
    expect(motionLayer).toHaveStyle({ transform: 'translateY(0px)' });

    act(() => {
      vi.advanceTimersByTime(220);
    });

    fireEvent.mouseDown(player, { clientX: 120, clientY: 40 });
    fireEvent.mouseMove(player, { clientX: 124, clientY: 180 });
    fireEvent.mouseUp(player, { clientX: 124, clientY: 180 });
    expect(screen.getByTestId('location')).toHaveTextContent('/player');

    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/library/music');
  });

  test('keyboard controls toggle playback and seek the active session', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderScreen(store);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: ' ' });

    expect(session.calls.seek).toHaveBeenCalledWith(30);
    expect(session.calls.pause).toHaveBeenCalledTimes(1);
  });

  test('full player scrubber seeks only after the drag ends', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderScreen(store);

    const scrubber = screen.getByTestId('scrubber');
    fireEvent.pointerDown(scrubber);
    fireEvent.change(scrubber, {
      target: { value: '55' },
    });

    expect(session.calls.seek).not.toHaveBeenCalled();
    expect(screen.getByTestId('full-scrub-preview')).toHaveTextContent(
      /0:55\s*\/\s*1:40/,
    );

    fireEvent.pointerUp(scrubber);

    expect(session.calls.seek).toHaveBeenCalledTimes(1);
    expect(session.calls.seek).toHaveBeenCalledWith(55);
  });

  test('full player scrubber uses the final touch value on release', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderScreen(store);

    const scrubber = screen.getByTestId('scrubber');
    fireEvent.touchStart(scrubber);
    fireEvent.change(scrubber, {
      target: { value: '70' },
    });

    expect(session.calls.seek).not.toHaveBeenCalled();

    fireEvent.touchEnd(scrubber);

    expect(session.calls.seek).toHaveBeenCalledTimes(1);
    expect(session.calls.seek).toHaveBeenCalledWith(70);
  });

  test('full player scrubber keeps tracking drags outside the progress bar', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderScreen(store);

    const scrubber = screen.getByTestId('scrubber');
    Object.defineProperty(scrubber, 'getBoundingClientRect', {
      value: () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 0,
          width: 100,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect,
    });

    fireEvent.mouseDown(scrubber, { clientX: 20 });
    fireEvent.mouseMove(scrubber, { clientX: 150 });

    expect(session.calls.seek).not.toHaveBeenCalled();
    expect(screen.getByTestId('full-scrub-preview')).toHaveTextContent(
      /1:40\s*\/\s*1:40/,
    );

    fireEvent.mouseUp(scrubber, { clientX: 150 });

    expect(session.calls.seek).toHaveBeenCalledTimes(1);
    expect(session.calls.seek).toHaveBeenCalledWith(100);
  });

  test('full player scrubber keeps tracking touch drags after leaving the input', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderScreen(store);

    const scrubber = screen.getByTestId('scrubber');
    Object.defineProperty(scrubber, 'getBoundingClientRect', {
      value: () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 0,
          width: 100,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        }) as DOMRect,
    });

    fireEvent.touchStart(scrubber, {
      touches: [{ clientX: 20, clientY: 620 }],
    });
    fireEvent.touchMove(document, {
      touches: [{ clientX: 150, clientY: 700 }],
    });

    expect(session.calls.seek).not.toHaveBeenCalled();
    expect(screen.getByTestId('full-scrub-preview')).toHaveTextContent(
      /1:40\s*\/\s*1:40/,
    );

    fireEvent.touchEnd(document, {
      changedTouches: [{ clientX: 150, clientY: 700 }],
    });

    expect(session.calls.seek).toHaveBeenCalledTimes(1);
    expect(session.calls.seek).toHaveBeenCalledWith(100);
  });

  test('sleep timer preset starts a visible countdown', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    renderScreen(store);

    fireEvent.click(screen.getByLabelText('Sleep timer'));
    fireEvent.click(screen.getByText('15m'));

    expect(store.getState().sleepTimer.kind).toBe('running');
    expect(screen.getByTestId('sleep-timer-status')).toHaveTextContent(
      '15:00',
    );
  });

  test('renders music queue controls for an audio queue', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playMusicQueue(
      [
        audioSource,
        {
          ...audioSource,
          mediaId: 'a2',
          url: '/api/media/a2',
          name: 'second.mp3',
        },
      ],
      'a1',
    );

    renderScreen(store);

    fireEvent.click(screen.getByLabelText('Open queue'));
    expect(screen.getByTestId('queue-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('music-now-playing')).toBeInTheDocument();
    expect(screen.getByTestId('music-queue')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('queue-drawer-backdrop'));
    expect(screen.queryByTestId('queue-drawer')).not.toBeInTheDocument();

    expect(screen.getByTestId('shuffle-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(screen.getByTestId('shuffle-toggle'));
    expect(store.getState().shuffle).toBe(true);
    fireEvent.click(screen.getByTestId('repeat-toggle'));
    expect(store.getState().repeatMode).toBe('all');
    fireEvent.click(screen.getByTestId('repeat-toggle'));
    expect(store.getState().repeatMode).toBe('one');
    expect(screen.getByTestId('repeat-one-glyph')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('like-current'));
    expect(store.getState().likedMediaIds).toContain('audio:title:song');
  });

  test('queue drawer row click and transport next/previous change tracks', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playMusicQueue(
      [
        audioSource,
        {
          ...audioSource,
          mediaId: 'a2',
          url: '/api/media/a2',
          name: 'second.mp3',
        },
      ],
      'a1',
    );

    renderScreen(store);

    fireEvent.click(screen.getByLabelText('Next'));
    expect(store.getState().musicQueueIndex).toBe(1);

    fireEvent.click(screen.getByLabelText('Previous'));
    expect(store.getState().musicQueueIndex).toBe(0);

    fireEvent.click(screen.getByLabelText('Open queue'));
    fireEvent.click(screen.getByLabelText('Play second.mp3'));
    expect(store.getState().musicQueueIndex).toBe(1);
  });

  test('renders the video element for video sources', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    store.getState().attachElement('video', fakeElement());
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'v1',
      mediaType: 'video',
      url: '/api/media/v1',
      name: 'clip.mp4',
    });
    // Sanity-check the store before rendering. Helps identify whether a
    // failure here is in the store or in the screen projection.
    const s = store.getState();
    expect(s.active).toBe('video');
    expect(s.video.source?.mediaId).toBe('v1');
    renderScreen(store);
    expect(await screen.findByTestId('video-mount')).toBeInTheDocument();
    expect(screen.getByTestId('player-screen')).toHaveClass(
      'h-[100svh]',
      'touch-auto',
    );
    expect(screen.getByTestId('video-watch-layout')).toHaveClass(
      'h-full',
      'min-h-0',
      'grid-rows-[auto_minmax(0,1fr)]',
      'content-stretch',
      'lg:min-h-screen',
      'lg:grid-rows-none',
    );
    expect(screen.getByTestId('video-watch-layout')).not.toHaveClass(
      'min-h-screen',
    );
    expect(screen.getByTestId('video-primary-column')).toBeInTheDocument();
    expect(screen.getByTestId('video-primary-column')).not.toHaveClass(
      'touch-none',
    );
    expect(screen.getByTestId('video-side-list')).toHaveAttribute(
      'data-no-dismiss-gesture',
    );
    expect(screen.getByTestId('video-side-list')).toHaveClass('touch-pan-y');
    expect(screen.getByTestId('video-secondary-column')).toContainElement(
      screen.getByTestId('video-description'),
    );
    expect(screen.getByTestId('video-secondary-column')).toContainElement(
      screen.getByTestId('video-side-list'),
    );
    expect(screen.getByTestId('video-secondary-column')).toHaveAttribute(
      'data-allow-scroll',
    );
    expect(screen.getByTestId('video-primary-column')).not.toContainElement(
      screen.getByTestId('video-description'),
    );
    expect(screen.getByTestId('video-secondary-column')).toHaveClass(
      'min-h-0',
      'touch-pan-y',
      'overflow-y-auto',
      'overscroll-contain',
    );
    expect(screen.getByTestId('video-secondary-column')).not.toHaveClass(
      'max-h-[var(--video-watch-list-mobile-max-height)]',
    );
    expect(screen.getByTestId('video-side-scrollport')).toHaveClass(
      'touch-pan-y',
      'lg:overflow-y-auto',
      'lg:overscroll-contain',
    );
    expect(screen.getByTestId('video-side-scrollport')).not.toHaveClass(
      'overflow-y-auto',
    );
    expect(screen.getByTestId('video-viewport')).not.toHaveAttribute(
      'data-no-dismiss-gesture',
    );
    expect(screen.getByTestId('video-viewport')).toHaveClass('touch-none');
    expect(screen.getByTestId('video-info')).toBeInTheDocument();
    expect(screen.getByTestId('video-description')).toBeInTheDocument();
    expect(screen.getByTestId('video-player-title')).toHaveTextContent(
      'clip.mp4',
    );
    expect(screen.getByTestId('video-open-stream')).toHaveTextContent(
      'Open stream',
    );
    expect(screen.getByTestId('video-share-stream')).toHaveTextContent(
      'Share stream',
    );
    expect(screen.getByTestId('video-theater-toggle')).toHaveAccessibleName(
      'Enter theater mode',
    );
    expect(screen.getByTestId('video-theater-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    const theaterToggle = screen.getByTestId('video-theater-toggle');
    const fullscreenToggle = screen
      .getByTestId('video-mount')
      .querySelector('.vds-fullscreen-button');
    const controls = theaterToggle.closest('.vds-controls');
    expect(controls).not.toBeNull();
    expect(fullscreenToggle).not.toBeNull();
    expect(controls).toContainElement(theaterToggle);
    expect(controls).toContainElement(fullscreenToggle as HTMLElement);
    expect(
      Boolean(
        theaterToggle.compareDocumentPosition(fullscreenToggle as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(screen.getByTestId('player-close')).toHaveAccessibleName(
      'Collapse video player',
    );
    expect(screen.queryByTestId('now-playing-art')).not.toBeInTheDocument();
  });

  test('video external playback actions pass the stream URL without changing playback', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          ...videoSource,
          url: '/api/media/v1#t=120',
          title: 'clip title',
        },
        positionSec: 120,
        durationSec: 600,
      }),
    );
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const share = vi.fn(async () => {});
    const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share,
    });

    try {
      renderScreen(store);

      const beforeSource = store.getState().video.source;
      fireEvent.click(screen.getByTestId('video-open-stream'));

      expect(open).toHaveBeenCalledWith(
        new URL('/api/media/v1#t=120', window.location.href).href,
        '_blank',
        'noopener,noreferrer',
      );
      expect(store.getState().video.source).toEqual(beforeSource);

      await act(async () => {
        fireEvent.click(screen.getByTestId('video-share-stream'));
      });

      await waitFor(() => {
        expect(share).toHaveBeenCalledWith({
          title: 'clip title',
          url: new URL('/api/media/v1#t=120', window.location.href).href,
        });
      });
      expect(store.getState().active).toBe('video');
      expect(store.getState().video.source?.mediaId).toBe('v1');
      expect(store.getState().video.source).toEqual(beforeSource);
    } finally {
      if (originalShare === undefined) {
        Reflect.deleteProperty(navigator, 'share');
      } else {
        Object.defineProperty(navigator, 'share', originalShare);
      }
    }
  });

  test('video theater mode expands the viewport across the watch screen', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    renderScreen(store);

    expect(await screen.findByTestId('video-mount')).toBeInTheDocument();
    const layout = screen.getByTestId('video-watch-layout');
    const primaryColumn = screen.getByTestId('video-primary-column');
    const secondaryColumn = screen.getByTestId('video-secondary-column');
    const viewport = screen.getByTestId('video-viewport');
    const toggle = screen.getByTestId('video-theater-toggle');

    expect(layout).toHaveClass('max-w-[var(--video-watch-max-width)]');
    expect(layout).not.toHaveClass('max-w-none');
    expect(primaryColumn).not.toHaveClass('lg:col-span-full');
    expect(secondaryColumn).toHaveClass('lg:contents');
    expect(viewport).not.toHaveClass('lg:rounded-none');

    fireEvent.click(toggle);

    expect(toggle).toHaveAccessibleName('Exit theater mode');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(layout).toHaveClass(
      'max-w-none',
      'lg:grid-cols-1',
      'lg:grid-rows-[auto_minmax(0,1fr)]',
    );
    expect(layout).not.toHaveClass('max-w-[var(--video-watch-max-width)]');
    expect(primaryColumn).toHaveClass('lg:col-span-full');
    expect(viewport).toHaveClass('aspect-video', 'w-full', 'lg:rounded-none');
    expect(secondaryColumn).toHaveClass(
      'lg:overflow-y-auto',
      'lg:overscroll-contain',
    );
    expect(secondaryColumn).not.toHaveClass('lg:contents');
  });

  test('video title upward swipe scrolls the mobile video list', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [
        videoItem('v1', 'clip.mp4'),
        videoItem('v2', 'next.mp4'),
        videoItem('v3', 'third.mp4'),
      ],
    });

    try {
      renderScreen(store, { libraryStores });

      expect(await screen.findByTestId('video-up-next-list')).toBeInTheDocument();
      const secondaryScrollport = screen.getByTestId('video-secondary-column');
      expect(secondaryScrollport.scrollTop).toBe(0);

      fireEvent.touchStart(screen.getByTestId('video-player-title'), {
        touches: [{ clientX: 120, clientY: 320 }],
      });
      fireEvent.touchMove(screen.getByTestId('video-player-title'), {
        touches: [{ clientX: 122, clientY: 220 }],
      });
      fireEvent.touchEnd(screen.getByTestId('video-player-title'), {
        changedTouches: [{ clientX: 122, clientY: 220 }],
      });

      expect(secondaryScrollport.scrollTop).toBe(100);
      expect(screen.getByTestId('location')).toHaveTextContent('/player');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  test('mobile video list leaves the first drag to native scrolling', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [
        videoItem('v1', 'clip.mp4'),
        videoItem('v2', 'next.mp4'),
        videoItem('v3', 'third.mp4'),
      ],
    });

    try {
      renderScreen(store, { libraryStores });

      expect(await screen.findByTestId('video-up-next-list')).toBeInTheDocument();
      const secondaryScrollport = screen.getByTestId('video-secondary-column');
      const move = new Event('touchmove', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(move, 'touches', {
        value: [{ clientX: 122, clientY: 300 }],
      });
      fireEvent.touchStart(secondaryScrollport, {
        touches: [{ clientX: 120, clientY: 420 }],
      });
      fireEvent(secondaryScrollport, move);

      expect(move.defaultPrevented).toBe(false);
      expect(screen.getByTestId('player-motion-layer')).toHaveStyle({
        transform: 'translateY(0px)',
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/player');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  test('wide video list drag does not move or dismiss the watch screen', async () => {
	const originalMatchMedia = window.matchMedia;
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		value: vi.fn((query: string): MediaQueryList => ({
			matches: query === '(min-width: 1024px)',
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})),
	});
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [
        videoItem('v1', 'clip.mp4'),
        videoItem('v2', 'next.mp4'),
        videoItem('v3', 'third.mp4'),
      ],
    });

	try {
		renderScreen(store, { libraryStores });

		expect(await screen.findByTestId('video-up-next-list')).toBeInTheDocument();
		vi.useFakeTimers();
		const list = screen.getByTestId('video-side-scrollport');
		const motionLayer = screen.getByTestId('player-motion-layer');
		const move = new Event('touchmove', {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(move, 'touches', {
			value: [{ clientX: 122, clientY: 380 }],
		});

		fireEvent.touchStart(list, {
			touches: [{ clientX: 120, clientY: 180 }],
		});
		fireEvent(list, move);
		fireEvent.touchEnd(list, {
			changedTouches: [{ clientX: 122, clientY: 380 }],
		});

		expect(move.defaultPrevented).toBe(false);
		expect(motionLayer).toHaveStyle({ transform: 'translateY(0px)' });
		act(() => {
			vi.advanceTimersByTime(220);
		});
		expect(screen.getByTestId('location')).toHaveTextContent('/player');
	} finally {
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: originalMatchMedia,
		});
	}
  });

  test('video swipe dismisses from the viewport but not from the list scroller', async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [
        videoItem('v1', 'clip.mp4'),
        videoItem('v2', 'next.mp4'),
      ],
    });

    try {
      renderScreen(store, { libraryStores });

      expect(await screen.findByTestId('video-up-next-list')).toBeInTheDocument();
      vi.useFakeTimers();
      const secondaryScrollport = screen.getByTestId('video-secondary-column');
      fireEvent.touchStart(secondaryScrollport, {
        touches: [{ clientX: 120, clientY: 200 }],
      });
      fireEvent.touchMove(secondaryScrollport, {
        touches: [{ clientX: 122, clientY: 390 }],
      });
      fireEvent.touchEnd(secondaryScrollport, {
        changedTouches: [{ clientX: 122, clientY: 390 }],
      });
      act(() => {
        vi.advanceTimersByTime(180);
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/player');

      fireEvent.touchStart(screen.getByTestId('video-description'), {
        touches: [{ clientX: 120, clientY: 180 }],
      });
      fireEvent.touchMove(screen.getByTestId('video-description'), {
        touches: [{ clientX: 122, clientY: 360 }],
      });
      fireEvent.touchEnd(screen.getByTestId('video-description'), {
        changedTouches: [{ clientX: 122, clientY: 360 }],
      });
      act(() => {
        vi.advanceTimersByTime(180);
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/player');

      fireEvent.touchStart(secondaryScrollport, {
        touches: [{ clientX: 120, clientY: 390 }],
      });
      fireEvent.touchMove(secondaryScrollport, {
        touches: [{ clientX: 122, clientY: 200 }],
      });
      fireEvent.touchEnd(secondaryScrollport, {
        changedTouches: [{ clientX: 122, clientY: 200 }],
      });
      act(() => {
        vi.advanceTimersByTime(180);
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/player');

      fireEvent.touchStart(screen.getByTestId('video-player-title'), {
        touches: [{ clientX: 120, clientY: 40 }],
      });
      fireEvent.touchMove(screen.getByTestId('video-player-title'), {
        touches: [{ clientX: 122, clientY: 230 }],
      });
      fireEvent.touchEnd(screen.getByTestId('video-player-title'), {
        changedTouches: [{ clientX: 122, clientY: 230 }],
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/player');

      act(() => {
        vi.advanceTimersByTime(180);
      });

      expect(screen.getByTestId('location')).toHaveTextContent('/library/video');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  test('video mouse movement near controls does not dismiss the watch screen', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    renderScreen(store);

    expect(await screen.findByTestId('video-mount')).toBeInTheDocument();
    vi.useFakeTimers();
    const viewport = screen.getByTestId('video-viewport');
    dispatchPointerEvent(viewport, 'pointermove', {
      clientX: 222,
      clientY: 650,
      pointerId: 9,
      pointerType: 'mouse',
    });
    dispatchPointerEvent(viewport, 'pointerup', {
      clientX: 222,
      clientY: 650,
      pointerId: 9,
      pointerType: 'mouse',
    });
    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/player');
  });

  test('video mouse drag down dismisses the watch screen on desktop', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    renderScreen(store);

    expect(await screen.findByTestId('video-mount')).toBeInTheDocument();
    vi.useFakeTimers();
    const viewport = screen.getByTestId('video-viewport');
    const motionLayer = screen.getByTestId('player-motion-layer');
    dispatchPointerEvent(viewport, 'pointerdown', {
      button: 0,
      buttons: 1,
      clientX: 220,
      clientY: 180,
      pointerId: 10,
      pointerType: 'mouse',
    });
    dispatchPointerEvent(viewport, 'pointermove', {
      buttons: 1,
      clientX: 222,
      clientY: 360,
      pointerId: 10,
      pointerType: 'mouse',
    });
    expect(motionLayer).toHaveStyle({ transform: 'translateY(180px)' });
    dispatchPointerEvent(viewport, 'pointerup', {
      clientX: 222,
      clientY: 360,
      pointerId: 10,
      pointerType: 'mouse',
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/player');

    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(screen.getByTestId('location')).toHaveTextContent('/library/video');
  });

  test('video viewport swipes up into fullscreen and down back to watch screen', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const originalRequestFullscreen = HTMLElement.prototype.requestFullscreen;
    const originalExitFullscreen = Object.getOwnPropertyDescriptor(
      document,
      'exitFullscreen',
    );
    const originalFullscreenElement = Object.getOwnPropertyDescriptor(
      document,
      'fullscreenElement',
    );
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );

    try {
      renderScreen(store);
      expect(await screen.findByTestId('video-mount')).toBeInTheDocument();

      const viewport = screen.getByTestId('video-viewport');
      fireEvent.touchStart(viewport, {
        touches: [{ clientX: 120, clientY: 150 }],
      });
      fireEvent.touchMove(viewport, {
        touches: [{ clientX: 122, clientY: 40 }],
      });
      fireEvent.touchEnd(viewport, {
        changedTouches: [{ clientX: 122, clientY: 40 }],
      });

      expect(requestFullscreen).toHaveBeenCalled();
      expect(screen.getByTestId('location')).toHaveTextContent('/player');

      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => screen.getByTestId('video-mount'),
      });

      fireEvent.touchStart(viewport, {
        touches: [{ clientX: 120, clientY: 40 }],
      });
      fireEvent.touchMove(viewport, {
        touches: [{ clientX: 122, clientY: 230 }],
      });
      fireEvent.touchEnd(viewport, {
        changedTouches: [{ clientX: 122, clientY: 230 }],
      });

      expect(exitFullscreen).toHaveBeenCalled();
      expect(screen.getByTestId('location')).toHaveTextContent('/player');
    } finally {
      if (originalRequestFullscreen === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
      } else {
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
          configurable: true,
          value: originalRequestFullscreen,
        });
      }
      if (originalExitFullscreen === undefined) {
        Reflect.deleteProperty(document, 'exitFullscreen');
      } else {
        Object.defineProperty(document, 'exitFullscreen', originalExitFullscreen);
      }
      if (originalFullscreenElement === undefined) {
        Reflect.deleteProperty(document, 'fullscreenElement');
      } else {
        Object.defineProperty(
          document,
          'fullscreenElement',
          originalFullscreenElement,
        );
      }
    }
  });

  test('video watch list renders library videos and plays another item in place', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const progressRepository = createLocalStorageProgressRepository();
    progressRepository.write('v2', {
      positionSec: 45,
      durationSec: 120,
      lastPlayedAt: '2026-07-04T00:00:00Z',
      source: {
        mediaType: 'video',
        name: 'next.mp4',
        rootName: 'videos',
        relativePath: 'clips/next.mp4',
      },
    });
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [
        videoItem('v1', 'clip.mp4'),
        videoItem('v2', 'next.mp4'),
        videoItem('v3', 'third.mp4', {
          thumbnail: {
            url: '',
            kind: 'video',
            status: 'missing',
            cacheKey: '',
          },
        }),
      ],
    });

    renderScreen(store, { libraryStores, progressRepository });

    expect(await screen.findByTestId('video-up-next-list')).toBeInTheDocument();
    expect(screen.getByLabelText('Now playing clip.mp4')).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByLabelText('Now playing clip.mp4')).toBeDisabled();
    expect(screen.getByLabelText('Play next.mp4')).toBeInTheDocument();
    expect(screen.getByLabelText('Play third.mp4')).toBeInTheDocument();
    expect(screen.getByText('Now playing')).toBeInTheDocument();
    expect(screen.getByText('38% watched')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Now playing clip.mp4'));

    expect(store.getState().video.source?.mediaId).toBe('v1');

    fireEvent.click(screen.getByLabelText('Play next.mp4'));

    expect(store.getState().video.source?.mediaId).toBe('v2');
    expect(store.getState().video.source?.url).toBe('/api/media/v2#t=45');
  });

  test('video watch list does not reload stale videos while already loading', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const load = vi.fn(async () => {});
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [videoItem('v1', 'clip.mp4')],
    });
    libraryStores.video.setState({
      status: 'loading',
      stale: true,
      load,
    });

    renderScreen(store, { libraryStores });

    await screen.findByTestId('video-watch-layout');
    expect(load).not.toHaveBeenCalled();
  });

  test('video watch list reloads stale ok results with preservation', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: videoSource,
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const load = vi.fn(async () => {});
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [videoItem('v1', 'clip.mp4')],
    });
    libraryStores.video.setState({
      status: 'ok',
      stale: true,
      load,
    });

    renderScreen(store, { libraryStores });

    await waitFor(() => {
      expect(load).toHaveBeenCalledWith({ preserveResult: true });
    });
  });

  test('video watch list marks the current item without forcing scroll', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView as
      | Element['scrollIntoView']
      | undefined;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          ...videoSource,
          mediaId: 'v5',
          url: '/api/media/v5',
          name: 'video-05.mp4',
        },
        positionSec: 20,
        durationSec: 100,
      }),
    );
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: Array.from({ length: 25 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0');
        return videoItem(`v${index + 1}`, `video-${number}.mp4`);
      }),
    });

    try {
      renderScreen(store, { libraryStores });

      expect(await screen.findByLabelText('Play video-01.mp4')).toBeInTheDocument();
      expect(screen.getByLabelText('Play video-04.mp4')).toBeInTheDocument();
      expect(screen.getByLabelText('Now playing video-05.mp4')).toHaveAttribute(
        'aria-current',
        'true',
      );
      expect(screen.getByLabelText('Play video-06.mp4')).toBeInTheDocument();
      expect(screen.getByLabelText('Play video-24.mp4')).toBeInTheDocument();
      expect(
        screen.queryByLabelText('Play video-25.mp4'),
      ).not.toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (originalScrollIntoView === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      } else {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScrollIntoView,
        });
      }
    }
  });

  test('video watch list resumes a previously watched video after switching away', async () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          ...videoSource,
          mediaId: 'v2',
          url: '/api/media/v2',
          name: 'next.mp4',
        },
        positionSec: 30,
        durationSec: 120,
      }),
    );
    const progressRepository = createLocalStorageProgressRepository();
    progressRepository.write('v1', {
      positionSec: 900,
      durationSec: 1_800,
      lastPlayedAt: '2026-07-04T00:00:00Z',
      source: {
        mediaType: 'video',
        name: 'clip.mp4',
        rootName: 'videos',
        relativePath: 'clips/clip.mp4',
      },
    });
    const libraryStores = createTestLibraryStores({
      kind: 'ok',
      items: [
        videoItem('v1', 'clip.mp4'),
        videoItem('v2', 'next.mp4'),
      ],
    });

    renderScreen(store, { libraryStores, progressRepository });

    expect(await screen.findByLabelText('Play clip.mp4')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Play clip.mp4'));

    expect(store.getState().video.source?.mediaId).toBe('v1');
    expect(store.getState().video.source?.url).toBe('/api/media/v1#t=900');
  });

  test('renders <VideoMount> on a queued video request before any element is attached', async () => {
    // Reproduces the real flow: the user clicks a video row, playSource
    // queues the source on the store before /player has rendered. The
    // screen must mount <VideoMount> on next paint so attachElement can
    // drain the queue and start playback.
    const store = createPlayerStore();
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'v1',
      mediaType: 'video',
      url: '/api/media/v1',
      name: 'clip.mp4',
    });
    expect(store.getState().active).toBe('video');
    expect(store.getState().video.source?.mediaId).toBe('v1');

    renderScreen(store);
    expect(await screen.findByTestId('video-mount')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is playing.')).not.toBeInTheDocument();
  });

  test('collapsing the video player keeps the persistent video session alive', async () => {
    const session = fakeSession({
      status: { kind: 'idle' },
      source: null,
      positionSec: 0,
      durationSec: 0,
    });
    const store = createPlayerStore({
      createSession: () => session,
    });

    await act(async () => {
      await store.getState().playSource(videoSource);
    });

    render(
      <LibraryProvider stores={createTestLibraryStores()}>
        <PlayerProvider store={store}>
          <ProgressProvider repository={createLocalStorageProgressRepository()}>
            <VideoSurfaceProvider>
              <MemoryRouter future={routerFuture} initialEntries={['/library/video']}>
                <CollapsiblePlayerHarness />
              </MemoryRouter>
            </VideoSurfaceProvider>
          </ProgressProvider>
        </PlayerProvider>
      </LibraryProvider>,
    );

    await waitFor(() => {
      expect(store.getState().video.status.kind).toBe('playing');
    });
    expect(screen.getByTestId('video-mount')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('player-close'));

    expect(screen.getByTestId('collapsed-target')).toBeInTheDocument();
    expect(store.getState().active).toBe('video');
    expect(store.getState().video.source?.mediaId).toBe('v1');
    expect(store.getState().video.status.kind).toBe('playing');
    expect(session.calls.pause).not.toHaveBeenCalled();
  });

  test('loads and renders fallback status for unsupported media', async () => {
    vi.spyOn(fallbackClient, 'fetchFallbackPlan').mockResolvedValue({
      kind: 'ok',
      plan: {
        mediaId: 'v1',
        mimeType: 'video/x-fake',
        browserSupport: 'no',
        action: 'remux',
        status: 'available',
        reason: 'container fallback can try remux before transcode',
        directUrl: '/api/media/v1',
        ffmpeg: { available: true, version: 'ffmpeg version 7.0' },
        policy: {
          systemFfmpegPreferred: true,
          nativeBundling: 'disabled',
          docker: 'allowed',
          remux: 'preferred',
          transcode: 'bounded',
          limits: {
            maxConcurrentJobs: 1,
            maxInputBytes: 8589934592,
            jobTimeoutSeconds: 1800,
          },
        },
      },
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'video',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          kind: 'remote',
          mediaId: 'v1',
          mediaType: 'video',
          url: '/api/media/v1',
          mimeType: 'video/x-fake',
          name: 'clip.mkv',
        },
        positionSec: 0,
        durationSec: 100,
      }),
    );

    renderScreen(store);

    expect(screen.getByTestId('unsupported-banner')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('fallback-status')).toHaveTextContent(
        'Fallback available: remux',
      );
    });
    expect(fallbackClient.fetchFallbackPlan).toHaveBeenCalledWith(
      'v1',
      'no',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
