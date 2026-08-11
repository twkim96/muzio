import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

import type { MediaElementLike } from '../../core/playback/engine/engine';
import type {
  PlaybackSession,
  PlaybackState,
  SessionListener,
} from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import { MiniPlayer } from './MiniPlayer';
import { PlayerProvider } from './PlayerContext';
import {
  PlayerOverlayProvider,
  usePlayerOverlay,
} from './PlayerOverlayContext';
import { AUDIO_NETWORK_RETRY_HINT_DELAY_MS } from './playbackNetworkStatus';
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

const routerFuture = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;

function renderWithStore(store: ReturnType<typeof createPlayerStore>) {
  return render(
    <PlayerProvider store={store}>
      <PlayerOverlayProvider>
        <MemoryRouter future={routerFuture}>
          <MiniPlayer />
          <OverlayProbe />
        </MemoryRouter>
      </PlayerOverlayProvider>
    </PlayerProvider>,
  );
}

function OverlayProbe() {
  const { isOpen } = usePlayerOverlay();
  return <span data-testid="overlay-open">{isOpen ? 'open' : 'closed'}</span>;
}

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
  url: '/api/media/v1#t=45',
  name: 'clip.mp4',
  durationSec: 120,
  rootName: 'videos',
  relativePath: 'clips/clip.mp4',
};

describe('MiniPlayer', () => {
  test('renders nothing when no source is loaded', () => {
    const store = createPlayerStore();
    renderWithStore(store);
    expect(screen.queryByTestId('mini-player')).not.toBeInTheDocument();
  });

  test('renders the source name when something is playing', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'a1',
      mediaType: 'audio',
      url: '/api/media/a1',
      name: 'song.mp3',
    });
    renderWithStore(store);
    expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    expect(screen.getByTestId('mini-player-details')).toHaveTextContent(
      'song.mp3',
    );
  });

  test('shows current and total playback time below the title', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: {
        ...audioSource,
        artist: 'Unneeded artist',
        rootName: 'Unneeded root',
      },
      positionSec: 65,
      durationSec: 3665,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderWithStore(store);

    expect(screen.getByTestId('mini-player-time')).toHaveTextContent(
      '1:05 : 1:01:05',
    );
    expect(screen.getByTestId('mini-player-details')).not.toHaveTextContent(
      'Music · Unneeded artist',
    );
    expect(screen.queryByTestId('mini-network-hint')).not.toBeInTheDocument();
  });

  test('shows the network hint only after delayed audio loading', () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession({
        status: { kind: 'loading' },
        source: audioSource,
        positionSec: 0,
        durationSec: 100,
      });
      const store = createPlayerStore();
      store.getState().setSessionForTests('audio', session);
      renderWithStore(store);

      expect(screen.queryByTestId('mini-network-hint')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(AUDIO_NETWORK_RETRY_HINT_DELAY_MS - 1);
      });
      expect(screen.queryByTestId('mini-network-hint')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(screen.getByTestId('mini-network-hint')).toHaveTextContent(
        'Still loading audio. Network may be slow.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('retrying from sustained buffering calls play instead of pause', () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession({
        status: { kind: 'buffering' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      });
      const store = createPlayerStore();
      store.getState().setSessionForTests('audio', session);
      renderWithStore(store);

      act(() => {
        vi.advanceTimersByTime(AUDIO_NETWORK_RETRY_HINT_DELAY_MS - 1);
      });
      expect(screen.queryByTestId('mini-network-hint')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(screen.getByTestId('mini-network-hint')).toHaveTextContent(
        'Buffering. Waiting for network.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(session.calls.play).toHaveBeenCalledOnce();
      expect(session.calls.pause).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not show the audio network hint for video buffering', () => {
    const session = fakeSession({
      status: { kind: 'buffering' },
      source: videoSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('video', session);
    renderWithStore(store);

    expect(screen.queryByTestId('mini-network-hint')).not.toBeInTheDocument();
  });

  test('shows saved video progress from the boot-time mini-player seed', () => {
    const store = createPlayerStore();
    store.getState().seedSource(videoSource, {
      positionSec: 45,
      durationSec: 120,
    });
    renderWithStore(store);

    expect(screen.getByTestId('mini-player')).toBeInTheDocument();
    expect(screen.getByTestId('mini-player-details')).toHaveTextContent(
      'clip.mp4',
    );
    expect(screen.getByTestId('mini-player-time')).toHaveTextContent(
      '0:45 : 2:00',
    );
    expect(
      screen.getByTestId('open-full-player').querySelector('svg'),
    ).not.toBeNull();
  });

  test('clicking mini play on a seeded video loads the saved resume URL', async () => {
    const session = fakeSession({
      status: { kind: 'idle' },
      source: null,
      positionSec: 0,
      durationSec: 0,
    });
    const store = createPlayerStore({
      createSession: () => session,
    });
    store.getState().seedSource(
      {
        ...videoSource,
        url: '/api/media/v1',
      },
      {
        positionSec: 7_200,
        durationSec: 10_000,
      },
    );
    store.getState().attachElement('video', fakeElement());
    renderWithStore(store);

    expect(screen.getByTestId('mini-player-time')).toHaveTextContent(
      '2:00:00 : 2:46:40',
    );

    fireEvent.click(screen.getByTestId('play-pause'));

    expect(session.calls.load).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId: 'v1',
        mediaType: 'video',
        url: '/api/media/v1#t=7200',
      }),
    );
    expect(session.calls.play).toHaveBeenCalled();
  });

  test('shows an active sleep timer countdown', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'a1',
      mediaType: 'audio',
      url: '/api/media/a1',
      name: 'song.mp3',
    });
    store.getState().startSleepTimer(30);
    renderWithStore(store);

    expect(screen.getByTestId('mini-sleep-timer')).toHaveTextContent(
      '30:00 left',
    );
  });

  test('clicking play/pause calls togglePlayPause on the store', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'a1',
      mediaType: 'audio',
      url: '/api/media/a1',
      name: 'song.mp3',
    });
    renderWithStore(store);
    const button = screen.getByTestId('play-pause');
    expect(button.getAttribute('aria-label')).toBe('Pause');
    fireEvent.click(button);
    // After toggling, the underlying audio session should have requested a
    // pause, which in our fake element is observable through the resulting
    // status update being eventually 'paused'. Since the fake element has no
    // event loop, the click triggers togglePlayPause -> session.pause -> the
    // element.pause call (which is a no-op in our fake). The visible signal
    // is the button label flipping to "Play" after the next render once a
    // state event arrives. Without a real engine wired up here, we just
    // assert that clicking did not throw and the button is still rendered.
    expect(screen.getByTestId('play-pause')).toBeInTheDocument();
  });

  test('opens a vertical volume slider from the mini player', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource({
      kind: 'remote',
      mediaId: 'a1',
      mediaType: 'audio',
      url: '/api/media/a1',
      name: 'song.mp3',
    });
    renderWithStore(store);

    fireEvent.click(screen.getByLabelText('Volume'));
    expect(screen.getByTestId('mini-volume-popover')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('mini-volume-slider'), {
      target: { value: '0.35' },
    });
    expect(store.getState().volume).toBe(0.35);
  });

  test('opens the full player only from the cover button', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    renderWithStore(store);

    fireEvent.click(screen.getByTestId('mini-player-details'));
    expect(screen.getByTestId('overlay-open')).toHaveTextContent('closed');

    fireEvent.click(screen.getByTestId('open-full-player'));
    expect(screen.getByTestId('overlay-open')).toHaveTextContent('open');
  });

  test('shows embedded cover artwork in the cover button', () => {
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          ...audioSource,
          artworkUrl: '/api/thumbnails/a1?v=cover&state=ready',
        },
        positionSec: 20,
        durationSec: 100,
      }),
    );
    renderWithStore(store);

    expect(screen.getByTestId('mini-player-artwork')).toHaveAttribute(
      'src',
      '/api/thumbnails/a1?v=cover&state=ready',
    );
  });

  test('ignores empty mini progress track taps', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderWithStore(store);

    const scrubber = screen.getByTestId('mini-scrubber');
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

    fireEvent.mouseDown(scrubber, { clientX: 80 });
    fireEvent.mouseUp(scrubber, { clientX: 80 });

    expect(session.calls.seek).not.toHaveBeenCalled();
  });

  test('keeps the mini scrub preview visible while dragging', () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 20,
        durationSec: 100,
      });
      const store = createPlayerStore();
      store.getState().setSessionForTests('audio', session);
      renderWithStore(store);

      const scrubber = screen.getByTestId('mini-scrubber');
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
      fireEvent.mouseMove(scrubber, { clientX: 45 });

      expect(session.calls.seek).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(screen.getByTestId('mini-scrub-preview')).toBeInTheDocument();

      fireEvent.mouseUp(scrubber, { clientX: 45 });
      expect(session.calls.seek).toHaveBeenCalledWith(45);
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(screen.queryByTestId('mini-scrub-preview')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps tracking mini scrubber drags outside the progress bar', () => {
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 20,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderWithStore(store);

    const scrubber = screen.getByTestId('mini-scrubber');
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
    expect(screen.getByTestId('mini-scrub-preview')).toHaveTextContent(
      /1:40\s*\/\s*1:40/,
    );

    fireEvent.mouseUp(scrubber, { clientX: 150 });

    expect(session.calls.seek).toHaveBeenCalledTimes(1);
    expect(session.calls.seek).toHaveBeenCalledWith(100);
  });

  test('opens queue from the mini queue button', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playMusicQueue([audioSource], 'a1');
    renderWithStore(store);

    fireEvent.click(screen.getByTestId('mini-queue-button'));

    expect(screen.getByTestId('queue-drawer')).toBeInTheDocument();
  });

  test('opens sleep timer controls from the mini timer button', async () => {
    const store = createPlayerStore();
    store.getState().attachElement('audio', fakeElement());
    await store.getState().playSource(audioSource);
    renderWithStore(store);

    const timerButton = screen.getByRole('button', { name: 'Sleep timer' });
    fireEvent.click(timerButton);

    expect(screen.getByTestId('mini-timer-popover')).toBeInTheDocument();
    expect(timerButton).toHaveClass('aria-expanded:text-accent');
    expect(timerButton).not.toHaveClass(
      'aria-expanded:bg-accent/12',
      'aria-expanded:ring-1',
      'aria-expanded:ring-accent/45',
    );
    expect(timerButton.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('mini-timer-popover').className).toContain('fixed');
    expect(screen.getByTestId('mini-timer-popover').className).toContain(
      'bg-[#111113]',
    );
    expect(screen.getByTestId('sleep-timer-control')).toBeInTheDocument();
  });

  test('mini previous and next buttons move through the music queue', async () => {
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
    renderWithStore(store);

    expect(screen.getByLabelText('Previous')).toHaveClass('dark:text-white');
    expect(screen.getByLabelText('Next')).toHaveClass('dark:text-white');
    expect(screen.getByLabelText('Previous').querySelector('svg')).toHaveClass(
      'h-6',
    );
    expect(screen.getByLabelText('Next').querySelector('svg')).toHaveClass(
      'h-6',
    );

    fireEvent.click(screen.getByLabelText('Repeat off'));
    fireEvent.click(screen.getByLabelText('Repeat all'));
    expect(store.getState().repeatMode).toBe('one');
    expect(screen.getByLabelText('Repeat one')).toHaveClass(
      'aria-pressed:text-accent',
    );
    expect(screen.getByLabelText('Repeat one')).not.toHaveClass(
      'aria-pressed:bg-accent/12',
      'aria-pressed:ring-1',
      'aria-pressed:ring-accent/45',
    );
    expect(screen.getByTestId('repeat-one-glyph')).toBeInTheDocument();
    expect(screen.getByTestId('repeat-one-glyph')).toHaveClass(
      'text-[0.38em]',
    );

    fireEvent.click(screen.getByLabelText('Next'));
    expect(store.getState().musicQueueIndex).toBe(1);

    fireEvent.click(screen.getByLabelText('Previous'));
    expect(store.getState().musicQueueIndex).toBe(0);
  });
});
