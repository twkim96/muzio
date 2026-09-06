import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { PlaybackSource } from '../../core/playback/source/source';
import { PlayerProvider } from './PlayerContext';
import { QueueDrawer } from './QueueDrawer';
import { createPlayerStore } from './playerStore';

function queueTracks(count: number): PlaybackSource[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'remote' as const,
    mediaId: `audio-${index}`,
    mediaType: 'audio' as const,
    name: `Track ${index}`,
    url: `/api/media/audio-${index}`,
    queueEntryId: `queue-${index}`,
  }));
}

describe('QueueDrawer', () => {
  test('keeps the queue visible outside a hidden mini-player ancestor', () => {
    const store = createPlayerStore({ activityRepository: null, likedRepository: null });
    store.setState({ musicQueue: queueTracks(2), musicQueueIndex: 0 });
    const { container, rerender } = render(
      <PlayerProvider store={store}>
        <div data-testid="mini-player" style={{ display: 'none', transform: 'translateY(0)' }}>
          <QueueDrawer open onClose={vi.fn()} />
        </div>
      </PlayerProvider>,
    );

    expect(screen.getByTestId('queue-drawer').parentElement).toBe(document.body);
    expect(container).not.toContainElement(screen.getByTestId('queue-drawer'));
    expect(screen.getByRole('dialog', { name: 'Queue' })).toBeVisible();
    expect(screen.getByTestId('music-queue')).toHaveClass('scrollbar-none', 'overscroll-contain');
    expect(screen.getByTestId('music-queue')).toHaveAttribute('data-allow-scroll');
    expect(screen.queryByRole('button', { name: 'Back to sidebar' })).not.toBeInTheDocument();

    rerender(
      <PlayerProvider store={store}>
        <QueueDrawer open={false} onClose={vi.fn()} />
      </PlayerProvider>,
    );
    expect(screen.queryByTestId('queue-drawer')).not.toBeInTheDocument();
  });

  test('returns to the sidebar through the optional back action', () => {
    const store = createPlayerStore({ activityRepository: null, likedRepository: null });
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <PlayerProvider store={store}>
        <QueueDrawer open onClose={onClose} onBack={onBack} />
      </PlayerProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to sidebar' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('traps focus and preserves keyboard and backdrop dismissal', () => {
    const store = createPlayerStore({ activityRepository: null, likedRepository: null });
    store.setState({ musicQueue: queueTracks(2), musicQueueIndex: 0 });
    const onClose = vi.fn();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <PlayerProvider store={store}>
        <QueueDrawer open onClose={onClose} />
      </PlayerProvider>,
    );

    expect(screen.getByRole('dialog', { name: 'Queue' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByTestId('clear-music-queue')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Play Track 1' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByTestId('clear-music-queue')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByTestId('queue-drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  test('renders a bounded window around the current item', () => {
    const store = createPlayerStore({
      activityRepository: null,
      likedRepository: null,
    });
    store.setState({
      musicQueue: queueTracks(10_000),
      musicQueueIndex: 5_000,
    });

    render(
      <PlayerProvider store={store}>
        <QueueDrawer open onClose={vi.fn()} />
      </PlayerProvider>,
    );

    const queue = screen.getByTestId('music-queue');
    expect(queue).toHaveAttribute('data-total-count', '10000');
    expect(Number(queue.getAttribute('data-rendered-count'))).toBeLessThan(40);
    expect(screen.getByRole('button', { name: 'Play Track 5000' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play Track 0' })).not.toBeInTheDocument();
  });

  test('keeps play and clear behavior with a virtualized queue', () => {
    const store = createPlayerStore({
      activityRepository: null,
      likedRepository: null,
    });
    store.setState({
      musicQueue: queueTracks(100),
      musicQueueIndex: 50,
    });
    render(
      <PlayerProvider store={store}>
        <QueueDrawer open onClose={vi.fn()} />
      </PlayerProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Play Track 51' }));
    expect(store.getState().musicQueueIndex).toBe(51);

    fireEvent.click(screen.getByTestId('clear-music-queue'));
    expect(store.getState().musicQueue).toHaveLength(1);
    expect(store.getState().musicQueue[0].mediaId).toBe('audio-51');
  });
});
