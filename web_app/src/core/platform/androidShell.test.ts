import { afterEach, describe, expect, test, vi } from 'vitest';
import { migrateNativePreferences, registerAndroidBack, type AndroidShellBridge } from './androidShell';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe('native preference migration', () => {
  const values = { 'music.likes.v1': '["native"]', 'music.playlists.v1': '{"playlists":[]}', 'music.activity.v1': '[]', unrelated: 'ignored' };
  function bridge() { return { request: vi.fn(async (command: string) => command === 'shell.legacyPreferences' ? { values } : undefined) } as unknown as AndroidShellBridge; }
  test('copies only missing allowed keys, preserving existing preferences', async () => {
    localStorage.setItem('music.likes.v1', '["web"]');
    const native = bridge();
    await migrateNativePreferences(native);
    expect(localStorage.getItem('music.likes.v1')).toBe('["web"]');
    expect(localStorage.getItem('music.playlists.v1')).toBe(values['music.playlists.v1']);
    expect(localStorage.getItem('unrelated')).toBeNull();
    expect(native.request).toHaveBeenLastCalledWith('shell.finishMigration');
  });
  test('does not acknowledge quota failure and retry retains successful writes', async () => {
    const native = bridge();
    const write = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'music.playlists.v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      write.call(this, key, value);
    });
    await expect(migrateNativePreferences(native)).rejects.toThrow('Quota exceeded');
    expect(native.request).not.toHaveBeenCalledWith('shell.finishMigration');
    spy.mockRestore();
    localStorage.setItem('music.likes.v1', '["changed after failure"]');
    await migrateNativePreferences(native);
    expect(localStorage.getItem('music.likes.v1')).toBe('["changed after failure"]');
    expect(localStorage.getItem('music.activity.v1')).toBe('[]');
    expect(native.request).toHaveBeenLastCalledWith('shell.finishMigration');
  });
});
test('Android back closes only the highest, latest surface then falls through', () => {
  const route = vi.fn(), drawer = vi.fn(), firstModal = vi.fn(), secondModal = vi.fn();
  const cleanups = [registerAndroidBack(route), registerAndroidBack(drawer, 50), registerAndroidBack(firstModal, 100), registerAndroidBack(secondModal, 100)];
  const back = () => { const event = new Event('muzio-back', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(back()).toBe(true); expect(secondModal).toHaveBeenCalledOnce(); expect(firstModal).not.toHaveBeenCalled();
  cleanups.pop()!(); back(); expect(firstModal).toHaveBeenCalledOnce();
  cleanups.pop()!(); back(); expect(drawer).toHaveBeenCalledOnce();
  cleanups.pop()!(); back(); expect(route).toHaveBeenCalledOnce();
  cleanups.pop()!(); expect(back()).toBe(false);
});
