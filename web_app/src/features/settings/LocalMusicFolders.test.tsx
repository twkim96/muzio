import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureAndroidShell } from '../../core/platform/androidShell';
import { LocalMusicFolders } from './LocalMusicFolders';
import { useNativeLocalLibrary } from '../library/nativeLocalLibrary';

afterEach(() => { configureAndroidShell(null); useNativeLocalLibrary.setState({ roots: [], items: [], busy: false, error: '', enrichment: undefined }); });
test('local folder controls are app-only', () => {
  render(<LocalMusicFolders query="" />);
  expect(screen.queryByRole('button', { name: '로컬 폴더 추가' })).not.toBeInTheDocument();
});
test('folder picker results appear in settings and remove sends only folder identity', async () => {
  const root = { id: 'folder-one', name: 'Music QA', uri: 'content://authorized/tree/one', available: true };
  const request = vi.fn().mockResolvedValueOnce({ roots: [root], items: [] }).mockResolvedValueOnce({ roots: [], items: [] });
  configureAndroidShell({ request });
  render(<LocalMusicFolders query="" />);
  fireEvent.click(screen.getByRole('button', { name: '로컬 폴더 추가' }));
  expect(await screen.findByText('Music QA')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith('localLibrary.add', undefined);
  fireEvent.click(screen.getByRole('button', { name: '로컬 폴더 제거 Music QA' }));
  await waitFor(() => expect(screen.queryByText('Music QA')).not.toBeInTheDocument());
  expect(request).toHaveBeenCalledWith('localLibrary.remove', { id: 'folder-one' });
});

test('background enrichment shows progress while folder controls remain usable', () => {
  configureAndroidShell({ request: vi.fn() });
  useNativeLocalLibrary.setState({ enrichment: { pending: 750, total: 1001 } });
  render(<LocalMusicFolders query="" />);
  expect(screen.getByRole('status')).toHaveTextContent('251/1001곡');
  expect(screen.getByRole('status')).toHaveTextContent('지금 재생할 수 있습니다');
  expect(screen.getByRole('button', { name: '로컬 폴더 추가' })).toBeEnabled();
});

test('iOS hides local folders and never requests the unsupported library', () => {
  const request = vi.fn();
  configureAndroidShell({ platform: 'ios', capabilities: { localLibrary: false, nativeAudio: true }, request });
  render(<LocalMusicFolders query="" />);
  expect(screen.queryByText('Local Music')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '로컬 폴더 추가' })).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});
