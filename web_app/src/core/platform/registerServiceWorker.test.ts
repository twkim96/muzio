import { afterEach, expect, test, vi } from 'vitest';
import { registerServiceWorker } from './registerServiceWorker';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test.each(['ios', 'android'] as const)('does not register a service worker in the %s host', (platform) => {
  vi.stubEnv('PROD', true);
  const addEventListener = vi.fn();
  vi.stubGlobal('window', { MuzioNative: { platform, postMessage: vi.fn() }, addEventListener });
  registerServiceWorker();
  expect(addEventListener).not.toHaveBeenCalled();
});

test('ordinary production web still registers the service worker', () => {
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_MUZIO_ANDROID', '');
  const register = vi.fn().mockResolvedValue({ update: vi.fn() });
  vi.stubGlobal('navigator', { serviceWorker: { register } });
  const addEventListener = vi.fn();
  vi.stubGlobal('window', { addEventListener, setInterval: vi.fn() });
  registerServiceWorker();
  expect(addEventListener).toHaveBeenCalledWith('load', expect.any(Function));
  addEventListener.mock.calls[0][1]();
  expect(register).toHaveBeenCalledWith('/sw.js');
});
