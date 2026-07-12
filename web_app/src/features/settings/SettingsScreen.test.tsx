import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createLibraryStore } from '../library/libraryStore';
import { LibraryProvider } from '../library/LibraryContext';
import { BackendStatusProvider } from './BackendStatusContext';
import { createBackendStatusStore } from './backendStatusStore';
import { SettingsScreen } from './SettingsScreen';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.theme;
});

describe('SettingsScreen', () => {
  test('customizes theme colors from settings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            audioRoots: [],
            videoRoots: [],
            imageRoots: [],
            persistent: true,
            index: {
              enabled: true,
              loadedItems: 42,
              lastVerifiedAt: '2026-06-11T00:00:00Z',
              lastError: 'disk busy',
            },
            degradedRoots: [
              { name: 'music', path: '/music', error: 'offline' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    render(
      <BackendStatusProvider store={createBackendStatusStore()}>
        <LibraryProvider
          stores={{
            audio: createLibraryStore({ type: 'audio' }),
            video: createLibraryStore({ type: 'video' }),
            image: createLibraryStore({ type: 'image' }),
          }}
        >
          <SettingsScreen />
        </LibraryProvider>
      </BackendStatusProvider>,
    );

    fireEvent.change(screen.getByTestId('theme-color-accentColor-picker'), {
      target: { value: '#1c6417' },
    });

    expect(document.documentElement.dataset.theme).toBe('custom');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('28 100 23');
    expect(screen.getByText('Current: Custom')).toBeInTheDocument();
    expect(await screen.findByText(/Kept last known files for \/music/)).toBeInTheDocument();
    expect(screen.getByText(/Library index write is delayed: disk busy/)).toBeInTheDocument();
  });

  test('saves music, video, and image roots together', async () => {
    let putBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              audioRoots: ['/music'],
              videoRoots: ['/video'],
              imageRoots: ['/pictures'],
              itemCount: 3,
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

    const audioFetcher = vi.fn(async () => ({ kind: 'ok' as const, items: [] }));
    const videoFetcher = vi.fn(async () => ({ kind: 'ok' as const, items: [] }));
    const imageFetcher = vi.fn(async () => ({ kind: 'ok' as const, items: [] }));
    const backendStatusStore = createBackendStatusStore({
      probe: async () => ({ kind: 'ok', service: 'test' }),
    });

    render(
      <BackendStatusProvider store={backendStatusStore}>
        <LibraryProvider
          stores={{
            audio: createLibraryStore({ type: 'audio', fetcher: audioFetcher }),
            video: createLibraryStore({ type: 'video', fetcher: videoFetcher }),
            image: createLibraryStore({ type: 'image', fetcher: imageFetcher }),
          }}
        >
          <SettingsScreen />
        </LibraryProvider>
      </BackendStatusProvider>,
    );

    const imageInput = await screen.findByLabelText('Image folders 1');
    expect(imageInput).toHaveValue('/images');

    fireEvent.change(imageInput, { target: { value: ' /pictures ' } });
    fireEvent.click(screen.getByTestId('save-media-roots'));

    await waitFor(() => {
      expect(putBody).toEqual({
        audioRoots: ['/music'],
        videoRoots: ['/video'],
        imageRoots: ['/pictures'],
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('media-roots-status')).toHaveTextContent(
        'Saved and refreshed 3 items.',
      );
    });
    expect(audioFetcher).toHaveBeenCalled();
    expect(videoFetcher).toHaveBeenCalled();
    expect(imageFetcher).toHaveBeenCalled();
  });

  test('shows live watcher and manual refresh root status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            audioRoots: ['/music', '/network'],
            videoRoots: [],
            imageRoots: [],
            persistent: true,
            index: {
              enabled: true,
              loadedItems: 12,
            },
            watcher: {
              enabled: true,
              backend: 'fsevents',
              roots: [
                {
                  path: '/music',
                  enabled: true,
                  backend: 'fsevents',
                },
                {
                  path: '/network',
                  enabled: false,
                  backend: 'fsevents',
                  reason: 'network filesystem uses manual refresh',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    render(
      <BackendStatusProvider store={createBackendStatusStore()}>
        <LibraryProvider
          stores={{
            audio: createLibraryStore({ type: 'audio' }),
            video: createLibraryStore({ type: 'video' }),
            image: createLibraryStore({ type: 'image' }),
          }}
        >
          <SettingsScreen />
        </LibraryProvider>
      </BackendStatusProvider>,
    );

    expect(await screen.findByText(/Live updates active via fsevents/)).toBeInTheDocument();
    expect(screen.getByText(/Manual refresh required for \/network/)).toBeInTheDocument();
  });

});
