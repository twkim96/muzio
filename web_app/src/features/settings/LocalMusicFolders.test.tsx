import { afterEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureAndroidShell } from '../../core/platform/androidShell';
import { LocalMusicFolders } from './LocalMusicFolders';
import { useNativeLocalLibrary } from '../library/nativeLocalLibrary';

afterEach(() => { configureAndroidShell(null); useNativeLocalLibrary.setState({ roots: [], items: [], busy: false, error: '' }); });
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
