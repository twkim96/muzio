import { expect, it, vi } from 'vitest';
import { createNativeBridge, type NativeMessagePort } from './nativeBridge';

it('matches replies by request id and delivers playback events independently', async () => {
  const port: NativeMessagePort = { postMessage: vi.fn() };
  const bridge = createNativeBridge(port)!;
  const listener = vi.fn(); bridge.subscribe(listener);
  const first = bridge.request('playback.snapshot');
  const second = bridge.request('playback.pause');
  const calls = vi.mocked(port.postMessage).mock.calls.map(([data]) => JSON.parse(data));
  port.onmessage!({ data: JSON.stringify({ type: 'response', id: calls[1].id, ok: true, result: 'paused' }) });
  port.onmessage!({ data: JSON.stringify({ type: 'playback', state: { positionSec: 20 } }) });
  port.onmessage!({ data: JSON.stringify({ type: 'response', id: calls[0].id, ok: true, result: 'snapshot' }) });
  expect(await first).toBe('snapshot'); expect(await second).toBe('paused');
  expect(listener).toHaveBeenCalledWith({ type: 'playback', state: { positionSec: 20 } });
  bridge.dispose(); expect(port.onmessage).toBeNull();
});
it('rejects native errors instead of reporting a successful handoff', async () => {
  const port: NativeMessagePort = { postMessage: vi.fn() };
  const bridge = createNativeBridge(port)!;
  const result = bridge.request('playback.pause');
  const { id } = JSON.parse(vi.mocked(port.postMessage).mock.calls[0][0]);
  port.onmessage!({ data: JSON.stringify({ type: 'response', id, ok: false, error: 'Unavailable' }) });
  await expect(result).rejects.toThrow('Unavailable'); bridge.dispose();
});
it('propagates iOS host capabilities without changing its message transport', async () => {
  const port: NativeMessagePort = { platform: 'ios', capabilities: { localLibrary: false, nativeAudio: true }, postMessage: vi.fn() };
  const bridge = createNativeBridge(port)!;
  expect(bridge.platform).toBe('ios');
  expect(bridge.capabilities).toEqual({ localLibrary: false, nativeAudio: true });
  const result = bridge.request('shell.profile');
  const { id } = JSON.parse(vi.mocked(port.postMessage).mock.calls[0][0]);
  port.onmessage!({ data: JSON.stringify({ type: 'response', id, ok: true, result: { setup: false } }) });
  await expect(result).resolves.toEqual({ setup: false });
  bridge.dispose();
});
