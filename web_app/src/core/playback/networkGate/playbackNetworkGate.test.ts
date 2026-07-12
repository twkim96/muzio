import { afterEach, describe, expect, test, vi } from 'vitest';

import { createPlaybackNetworkGate } from './playbackNetworkGate';

afterEach(() => {
  vi.useRealTimers();
});

describe('createPlaybackNetworkGate', () => {
  test('defers noncritical work during audio startup', () => {
    const gate = createPlaybackNetworkGate({
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    const end = gate.beginAudioStartup('song-a');

    expect(gate.shouldDefer('library-live-sync', 'watch')).toBe(true);
    expect(gate.shouldDefer('thumbnail', 'visible-list')).toBe(true);
    expect(gate.shouldDefer('manual-refresh', 'user')).toBe(false);

    end();
    expect(gate.shouldDefer('library-live-sync', 'watch')).toBe(false);
  });

  test('keeps seek sections bounded by timeout', () => {
    vi.useFakeTimers();
    const gate = createPlaybackNetworkGate({ timeoutMs: 100 });
    gate.beginAudioSeek('song-a', 1800);

    expect(gate.shouldDefer('library-live-sync', 'watch')).toBe(true);
    vi.advanceTimersByTime(99);
    expect(gate.shouldDefer('library-live-sync', 'watch')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(gate.shouldDefer('library-live-sync', 'watch')).toBe(false);
  });

  test('notifies subscribers when deferred work can resume', () => {
    const gate = createPlaybackNetworkGate({
      setTimeoutFn: () => 1,
      clearTimeoutFn: () => {},
    });
    const listener = vi.fn();
    const unsubscribe = gate.subscribe(listener);

    const end = gate.beginAudioStartup('song-a');
    end();

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    gate.beginAudioStartup('song-b');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
