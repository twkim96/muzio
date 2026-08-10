import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type {
  PlaybackSession,
  PlaybackState,
  SessionListener,
} from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';
import { MediaSessionSync } from './MediaSessionSync';
import { PlayerProvider } from './PlayerContext';
import { createPlayerStore } from './playerStore';

type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'
  | 'previoustrack'
  | 'nexttrack';

type MediaSessionActionHandler = (details: {
  action: MediaSessionAction;
  seekOffset?: number;
  seekTime?: number;
}) => void | Promise<void>;

interface FakeMediaSession {
  metadata: unknown | null;
  playbackState: 'none' | 'paused' | 'playing';
  handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>>;
  setActionHandler: ReturnType<
    typeof vi.fn<
      (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => void
    >
  >;
}

class FakeMediaMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: Array<{ src: string; sizes?: string; type?: string }>;

  constructor(init: {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: Array<{ src: string; sizes?: string; type?: string }>;
  }) {
    Object.assign(this, init);
  }
}

const originalMediaMetadata = window.MediaMetadata;
const originalMediaSession = Object.getOwnPropertyDescriptor(
  navigator,
  'mediaSession',
);

afterEach(() => {
  if (originalMediaMetadata === undefined) {
    Reflect.deleteProperty(window, 'MediaMetadata');
  } else {
    window.MediaMetadata = originalMediaMetadata;
  }
  if (originalMediaSession === undefined) {
    Reflect.deleteProperty(navigator, 'mediaSession');
  } else {
    Object.defineProperty(navigator, 'mediaSession', originalMediaSession);
  }
  vi.restoreAllMocks();
});

function installMediaSession(): FakeMediaSession {
  const mediaSession: FakeMediaSession = {
    metadata: null,
    playbackState: 'none',
    handlers: {},
    setActionHandler: vi.fn((action, handler) => {
      mediaSession.handlers[action] = handler;
    }),
  };
  Object.defineProperty(window, 'MediaMetadata', {
    configurable: true,
    value: FakeMediaMetadata,
  });
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: mediaSession,
  });
  return mediaSession;
}

function renderSync(store: ReturnType<typeof createPlayerStore>) {
  return render(
    <PlayerProvider store={store}>
      <MediaSessionSync />
    </PlayerProvider>,
  );
}

function fakeSession(initial: PlaybackState): PlaybackSession & {
  calls: {
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    seek: ReturnType<typeof vi.fn>;
  };
  setState(state: PlaybackState): void;
} {
  let state = initial;
  const listeners = new Set<SessionListener>();
  const emit = () => {
    for (const listener of [...listeners]) listener(state);
  };
  const calls = {
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
    load: vi.fn((source: PlaybackSource) => {
      state = {
        status: { kind: 'loading' },
        source,
        positionSec: 0,
        durationSec: source.durationSec ?? 0,
      };
      emit();
    }),
    play: calls.play,
    pause: calls.pause,
    seek: calls.seek,
    dispose: vi.fn(),
    calls,
    setState(next) {
      state = next;
      emit();
    },
  };
}

const audioSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'a1',
  mediaType: 'audio',
  url: '/api/media/a1',
  name: 'fallback.mp3',
  title: 'Rainy Night',
  artist: 'Lamp',
  rootName: 'Music',
};

const videoSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'v1',
  mediaType: 'video',
  url: '/api/media/v1',
  name: 'clip.mp4',
  title: 'Clip Title',
  rootName: 'Video',
};

describe('MediaSessionSync', () => {
  test('writes audio metadata from the active source', async () => {
    const mediaSession = installMediaSession();
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 0,
        durationSec: 100,
      }),
    );

    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.metadata).toMatchObject({
        title: 'Rainy Night',
        artist: 'Lamp',
      });
    });
    expect(mediaSession.playbackState).toBe('playing');
  });

  test('publishes embedded cover artwork for the active audio source', async () => {
    const mediaSession = installMediaSession();
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          ...audioSource,
          artworkUrl: '/api/thumbnails/a1?v=cover&state=ready',
        },
        positionSec: 0,
        durationSec: 100,
      }),
    );

    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.metadata).toMatchObject({
        artwork: [
          {
            src: '/api/thumbnails/a1?v=cover&state=ready',
            type: 'image/jpeg',
          },
        ],
      });
    });
  });

  test('replaces stale video metadata when audio becomes active', async () => {
    const mediaSession = installMediaSession();
    mediaSession.metadata = new FakeMediaMetadata({ title: 'Old Video' });
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 0,
        durationSec: 100,
      }),
    );

    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.metadata).toMatchObject({
        title: 'Rainy Night',
      });
    });
  });

  test('uses the root name as secondary text when artist is missing', async () => {
    const mediaSession = installMediaSession();
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: {
          ...audioSource,
          artist: undefined,
        },
        positionSec: 0,
        durationSec: 100,
      }),
    );

    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.metadata).toMatchObject({
        title: 'Rainy Night',
        artist: 'Music',
      });
    });
  });

  test('updates metadata when switching between audio and video', async () => {
    const mediaSession = installMediaSession();
    const store = createPlayerStore();
    renderSync(store);

    act(() => {
      store.getState().setSessionForTests(
        'audio',
        fakeSession({
          status: { kind: 'playing' },
          source: audioSource,
          positionSec: 0,
          durationSec: 100,
        }),
      );
    });
    await waitFor(() => {
      expect(mediaSession.metadata).toMatchObject({ title: 'Rainy Night' });
    });

    act(() => {
      store.getState().setSessionForTests('audio', null);
      store.getState().setSessionForTests(
        'video',
        fakeSession({
          status: { kind: 'playing' },
          source: videoSource,
          positionSec: 0,
          durationSec: 100,
        }),
      );
    });
    await waitFor(() => {
      expect(mediaSession.metadata).toMatchObject({ title: 'Clip Title' });
    });
  });

  test('does nothing when the Media Session API is unavailable', () => {
    Reflect.deleteProperty(window, 'MediaMetadata');
    Reflect.deleteProperty(navigator, 'mediaSession');
    const store = createPlayerStore();

    expect(() => renderSync(store)).not.toThrow();
  });

  test('routes media session seek actions to the active player', async () => {
    const mediaSession = installMediaSession();
    const session = fakeSession({
      status: { kind: 'playing' },
      source: audioSource,
      positionSec: 40,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.handlers.seekto).toBeTypeOf('function');
    });
    act(() => {
      mediaSession.handlers.seekto?.({ action: 'seekto', seekTime: 75 });
    });
    expect(session.calls.seek).toHaveBeenLastCalledWith(75);

    act(() => {
      mediaSession.handlers.seekbackward?.({
        action: 'seekbackward',
        seekOffset: 15,
      });
    });
    expect(session.calls.seek).toHaveBeenLastCalledWith(60);

    act(() => {
      mediaSession.handlers.seekforward?.({
        action: 'seekforward',
        seekOffset: 30,
      });
    });
    expect(session.calls.seek).toHaveBeenLastCalledWith(90);

    act(() => {
      mediaSession.handlers.seekforward?.({
        action: 'seekforward',
        seekOffset: 30,
      });
    });
    expect(session.calls.seek).toHaveBeenLastCalledWith(100);

    act(() => {
      mediaSession.handlers.seekto?.({ action: 'seekto', seekTime: 150 });
    });
    expect(session.calls.seek).toHaveBeenLastCalledWith(100);

    act(() => {
      mediaSession.handlers.seekto?.({ action: 'seekto', seekTime: -5 });
    });
    expect(session.calls.seek).toHaveBeenLastCalledWith(0);
  });

  test('does not expose queue navigation as system media actions', async () => {
    const mediaSession = installMediaSession();
    const store = createPlayerStore();
    store.getState().setSessionForTests(
      'audio',
      fakeSession({
        status: { kind: 'playing' },
        source: audioSource,
        positionSec: 0,
        durationSec: 100,
      }),
    );
    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.handlers.play).toBeTypeOf('function');
    });
    expect(mediaSession.handlers.previoustrack).toBeUndefined();
    expect(mediaSession.handlers.nexttrack).toBeUndefined();
    expect(mediaSession.setActionHandler).not.toHaveBeenCalledWith(
      'previoustrack',
      expect.any(Function),
    );
    expect(mediaSession.setActionHandler).not.toHaveBeenCalledWith(
      'nexttrack',
      expect.any(Function),
    );
  });

  test('routes media session play and pause actions to the active player', async () => {
    const mediaSession = installMediaSession();
    const session = fakeSession({
      status: { kind: 'paused' },
      source: audioSource,
      positionSec: 0,
      durationSec: 100,
    });
    const store = createPlayerStore();
    store.getState().setSessionForTests('audio', session);
    renderSync(store);

    await waitFor(() => {
      expect(mediaSession.handlers.play).toBeTypeOf('function');
    });
    await act(async () => {
      await mediaSession.handlers.play?.({ action: 'play' });
    });
    await waitFor(() => {
      expect(session.calls.play).toHaveBeenCalledTimes(1);
    });

    act(() => {
      mediaSession.handlers.pause?.({ action: 'pause' });
    });
    expect(session.calls.pause).toHaveBeenCalledTimes(1);
  });

  test('cleans up supported media session handlers on unmount', async () => {
    const mediaSession = installMediaSession();
    const store = createPlayerStore();
    const view = renderSync(store);

    await waitFor(() => {
      expect(mediaSession.handlers.play).toBeDefined();
    });
    view.unmount();

    expect(mediaSession.handlers.play).toBeNull();
    expect(mediaSession.handlers.pause).toBeNull();
    expect(mediaSession.handlers.seekto).toBeNull();
  });

  test('ignores unsupported action handler registration failures', () => {
    const mediaSession = installMediaSession();
    mediaSession.setActionHandler.mockImplementation((action, handler) => {
      if (action === 'seekto') throw new Error('unsupported');
      mediaSession.handlers[action] = handler;
    });
    const store = createPlayerStore();

    expect(() => renderSync(store)).not.toThrow();
    expect(mediaSession.handlers.play).toBeTypeOf('function');
  });
});
