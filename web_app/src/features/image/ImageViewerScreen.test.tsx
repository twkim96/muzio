import { render, screen, fireEvent } from '@testing-library/react';
import { expect, test } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LibraryProvider } from '../library/LibraryContext';
import { createLibraryStore } from '../library/libraryStore';
import { PlayerProvider } from '../player/PlayerContext';
import { createPlayerStore } from '../player/playerStore';
import { ImageViewerScreen } from './ImageViewerScreen';

test('image arrows and side list navigate and disable at the boundaries', async () => {
  const items = ['a', 'b', 'c'].map(id => ({ id, type: 'image' as const, rootName: 'Downloads-1234abcd', relativePath: `${id}.png`, name: `${id}.png`, sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z' }));
  const stores = {
    audio: createLibraryStore({ type: 'audio', fetcher: async () => ({ kind: 'ok', items: [] }) }),
    video: createLibraryStore({ type: 'video', fetcher: async () => ({ kind: 'ok', items: [] }) }),
    image: createLibraryStore({ type: 'image', fetcher: async () => ({ kind: 'ok', items }) }),
  };
  render(<LibraryProvider stores={stores}><PlayerProvider store={createPlayerStore()}><MemoryRouter><ImageViewerScreen mediaIdOverride="a" /></MemoryRouter></PlayerProvider></LibraryProvider>);
  await screen.findByTestId('image-viewer-image');
  expect(screen.getByLabelText('Previous image')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Next image'));
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('src', '/api/media/b?v=2');
  fireEvent.click(screen.getByRole('button', { name: 'c.png' }));
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('src', '/api/media/c?v=2');
  expect(screen.getByLabelText('Next image')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Previous image'));
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'b.png');
  fireEvent.wheel(screen.getByLabelText('Image list'), { deltaY: 100 });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'b.png');
  fireEvent.wheel(screen.getByTestId('image-navigation-area'), { deltaY: 100, ctrlKey: true });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'b.png');
  fireEvent.wheel(screen.getByTestId('image-navigation-area'), { deltaY: -100 });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'a.png');
  fireEvent.wheel(screen.getByTestId('image-navigation-area'), { deltaY: 100 });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'a.png');
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'b.png');
  fireEvent.keyDown(document, { key: 'ArrowDown' });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'c.png');
  fireEvent.keyDown(document, { key: 'ArrowUp' });
  fireEvent.keyDown(document, { key: 'ArrowLeft' });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'a.png');
  fireEvent.click(screen.getByTestId('image-viewer-image'));
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'b.png');
  fireEvent.click(screen.getByTestId('image-viewer-image'), { metaKey: true });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'a.png');
  const input = document.createElement('input');
  document.body.append(input);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(screen.getByTestId('image-viewer-image')).toHaveAttribute('alt', 'a.png');
  input.remove();

});
