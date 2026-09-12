import { afterEach, expect, it, vi } from 'vitest';
import { configureAndroidShell } from '../../core/platform/androidShell';
import { connectNativeVideoSurface } from './nativeVideoSurface';
import { nativeVideoFullscreenActive, setNativeVideoFullscreen } from './nativeVideoFullscreen';
afterEach(() => { configureAndroidShell(null); document.body.innerHTML = ''; vi.restoreAllMocks(); });
it.each(['ios', 'macos'] as const)('%s clears only the video backdrop, hides the underlying route, clips sticky overlap and restores on disposal', (platform) => {
  const request = vi.fn().mockResolvedValue({});
  configureAndroidShell({ platform, capabilities: { nativeVideo: true }, request });
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  document.body.innerHTML = `<div id="root"><div id="route">Library</div><div data-testid="player-screen"><div id="viewport"><div id="surface"><div data-media-player><button>Play</button></div></div></div><section data-testid="video-info">Info</section></div></div>`;
  const root = document.querySelector<HTMLElement>('#surface')!;
  const player = root.querySelector<HTMLElement>('[data-media-player]')!;
  const info = document.querySelector<HTMLElement>('[data-testid="video-info"]')!;
  vi.spyOn(player, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 225, width: 400, height: 225 } as DOMRect);
  vi.spyOn(info, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 180, right: 400, bottom: 600, width: 400, height: 420 } as DOMRect);
  const dispose = connectNativeVideoSurface(root);
  expect(player.hasAttribute('data-native-video-clear')).toBe(true);
  expect(document.querySelector('#route')?.hasAttribute('data-native-video-covered')).toBe(true);
  expect(player.querySelector('button')?.closest('[data-native-video-covered]')).toBe(null);
  expect(info.style.clipPath).toBe('inset(45px 0 0 0)');
  expect(request).toHaveBeenCalledWith('video.frame', expect.objectContaining({ visible: true, width: 400, height: 225 }));
  dispose();
  expect(document.querySelector('[data-native-video-clear], [data-native-video-covered]')).toBe(null);
  expect(info.style.clipPath).toBe('');
  expect(request).toHaveBeenLastCalledWith('video.frame', { visible: false });
});
it('leaves ordinary web and Android rendering untouched', () => {
  const request = vi.fn();
  configureAndroidShell({ platform: 'android', request });
  connectNativeVideoSurface(document.createElement('div'))();
  expect(request).not.toHaveBeenCalled();
});

it.each(['ios', 'macos'] as const)('%s moves the same player through enter, exit, reenter and Escape, then restores all background state on disposal', (platform) => {
  const request = vi.fn().mockResolvedValue({});
  let receiveHost = (_event: { type: string; state?: unknown }) => {};
  configureAndroidShell({ platform, capabilities: { nativeVideo: true }, request,
    subscribe(listener) { receiveHost = listener; return () => {}; },
  });
  let tick: FrameRequestCallback = () => {};
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { tick = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  document.body.innerHTML = `<div id="root"><div id="route">Library</div><div data-testid="player-screen"><div id="viewport"><span id="before"></span><div id="surface"><div data-media-player><video></video><button>Play</button></div></div><span id="after"></span></div><section data-testid="video-info">Info</section></div></div>`;
  const root = document.querySelector<HTMLElement>('#surface')!;
  const home = root.parentElement!;
  const player = root.querySelector<HTMLElement>('[data-media-player]')!;
  const video = player.querySelector('video');
  const app = document.querySelector('#root')!;
  const route = document.querySelector('#route')!;
  vi.spyOn(player, 'getBoundingClientRect').mockImplementation(() => {
    const expanded = root.parentElement === document.body;
    return { x: 0, y: 0, left: 0, top: 0, right: expanded ? 800 : 400, bottom: expanded ? 600 : 225,
      width: expanded ? 800 : 400, height: expanded ? 600 : 225 } as DOMRect;
  });
  const dispose = connectNativeVideoSurface(root);
  const enter = () => {
    expect(setNativeVideoFullscreen(player, true)).toBe(true);
    tick(0);
    expect(nativeVideoFullscreenActive(player)).toBe(true);
    expect(root.parentElement).toBe(document.body);
    expect(request).toHaveBeenLastCalledWith('video.frame', expect.objectContaining({ visible: true, width: 800, height: 600 }));
    expect(root.querySelector('[data-media-player]')).toBe(player);
    expect(player.querySelector('video')).toBe(video);
    expect(app).toHaveAttribute('data-native-video-covered');
    expect(player.closest('[data-native-video-covered]')).toBeNull();
  };
  const expectInline = () => {
    tick(0);
    expect(nativeVideoFullscreenActive(player)).toBe(false);
    expect(root.parentElement).toBe(home);
    expect(request).toHaveBeenLastCalledWith('video.frame', expect.objectContaining({ visible: true, width: 400, height: 225 }));
    expect(root.previousElementSibling?.id).toBe('before');
    expect(root.nextElementSibling?.id).toBe('after');
    expect(app).not.toHaveAttribute('data-native-video-covered');
    expect(route).toHaveAttribute('data-native-video-covered');
  };
  enter();
  receiveHost({ type: 'videoFullscreen', state: { active: false } });
  expectInline();
  enter();
  setNativeVideoFullscreen(player, false);
  expectInline();
  enter();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  expectInline();
  enter();
  // The moved root retains downward exit gestures, while horizontal seeks do not exit.
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    player.dispatchEvent(event);
  };
  pointer('pointerdown', 50, 50); pointer('pointerup', 250, 55);
  expect(nativeVideoFullscreenActive(player)).toBe(true);
  pointer('pointerdown', 50, 50); pointer('pointerup', 60, 180);
  expectInline();
  enter();
  dispose();
  expect(root.parentElement).toBe(home);
  expect(document.querySelector('[data-native-video-clear], [data-native-video-covered], [data-native-video-expanded]')).toBeNull();
  expect(setNativeVideoFullscreen(player, true)).toBe(false);
  expect(request.mock.calls.filter(([command]) => command === 'video.fullscreen').map(([, payload]) => payload.active)).toEqual([true, false, true, false, true, false, true, false, true, false]);
  expect(request).toHaveBeenLastCalledWith('video.frame', { visible: false });
});
