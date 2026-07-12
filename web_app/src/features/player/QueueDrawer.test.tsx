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
