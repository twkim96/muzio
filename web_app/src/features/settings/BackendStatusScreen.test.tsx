import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { HealthCheckResult } from '../../core/api/healthCheck';
import { createLibraryStore } from '../library/libraryStore';
import { LibraryProvider } from '../library/LibraryContext';
import { BackendStatusProvider } from './BackendStatusContext';
import { BackendStatusScreen } from './BackendStatusScreen';
import { createBackendStatusStore } from './backendStatusStore';

function renderScreen(probeResult: HealthCheckResult) {
  mockMediaRootsFetch();
  const store = createBackendStatusStore({
    probe: async () => probeResult,
  });
  const audioFetcher = vi.fn(async () => ({ kind: 'ok' as const, items: [] }));
  const videoFetcher = vi.fn(async () => ({ kind: 'ok' as const, items: [] }));
  const imageFetcher = vi.fn(async () => ({ kind: 'ok' as const, items: [] }));
  const libraryStores = {
    audio: createLibraryStore({ type: 'audio', fetcher: audioFetcher }),
    video: createLibraryStore({ type: 'video', fetcher: videoFetcher }),
    image: createLibraryStore({ type: 'image', fetcher: imageFetcher }),
  };
  render(
    <BackendStatusProvider store={store}>
      <LibraryProvider stores={libraryStores}>
        <BackendStatusScreen />
      </LibraryProvider>
    </BackendStatusProvider>,
  );
  return { audioFetcher, imageFetcher, store, videoFetcher };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BackendStatusScreen', () => {
  test('renders the consolidated settings sections', async () => {
    renderScreen({ kind: 'ok', service: 'muzio-backend' });

    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backend Status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Media Folders' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Runtime Notes' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('media-roots-status')).not.toHaveTextContent(
        'Loading media folders...',
      );
    });
  });

  test('renders without a result on first paint', async () => {
    renderScreen({ kind: 'ok', service: 'muzio-backend' });
    expect(screen.queryByTestId('probe-result')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('media-roots-status')).not.toHaveTextContent(
        'Loading media folders...',
      );
    });
  });

  test('shows the formatted ok result after Test connection', async () => {
    renderScreen({ kind: 'ok', service: 'muzio-backend' });

    fireEvent.click(screen.getByTestId('test-button'));

    await waitFor(() => {
      expect(screen.getByTestId('probe-result')).toHaveTextContent(
        'Connected to muzio-backend',
      );
    });
  });

  test('shows the formatted unreachable result', async () => {
    renderScreen({ kind: 'unreachable', message: 'refused' });

    fireEvent.click(screen.getByTestId('test-button'));

    await waitFor(() => {
      expect(screen.getByTestId('probe-result')).toHaveTextContent(
        'Unreachable: refused',
      );
    });
  });

  test('refreshes media folders manually', async () => {
    const { audioFetcher, imageFetcher, videoFetcher } = renderScreen({
      kind: 'ok',
      service: 'muzio-backend',
    });

    await waitFor(() => {
      expect(screen.getByTestId('refresh-media-roots')).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId('refresh-media-roots'));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/settings/media-roots',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('media-roots-status')).toHaveTextContent(
        'Rescanned 4 items.',
      );
    });
    expect(audioFetcher).toHaveBeenCalled();
    expect(videoFetcher).toHaveBeenCalled();
    expect(imageFetcher).toHaveBeenCalled();
  });
});

function mockMediaRootsFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/settings/media-roots') {
        return new Response('{}', { status: 404 });
      }
      if (init?.method === 'PUT' || init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            audioRoots: ['/music'],
            videoRoots: ['/video'],
            imageRoots: ['/images'],
            itemCount: init?.method === 'POST' ? 4 : 0,
            persistent: true,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          audioRoots: ['/music'],
          videoRoots: ['/video'],
          imageRoots: ['/images'],
          persistent: true,
        }),
        { status: 200 },
      );
    }),
  );
}
