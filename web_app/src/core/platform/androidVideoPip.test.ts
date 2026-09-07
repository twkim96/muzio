import { afterEach, expect, test, vi } from 'vitest';
import { configureAndroidShell } from './androidShell';
import { connectAndroidVideoPip } from './androidVideoPip';

afterEach(() => { configureAndroidShell(null); document.body.innerHTML = ''; vi.restoreAllMocks(); });
function fixture() {
  const request = vi.fn().mockResolvedValue({});
  configureAndroidShell({ request });
  const host = document.createElement('div');
  const root = document.createElement('div');
  const video = document.createElement('video');
  root.append(video); host.append(root); document.body.append(host);
  Object.defineProperties(video, { paused: { value: true, configurable: true }, readyState: { value: 4 }, videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
  const dispose = connectAndroidVideoPip(root);
  return { request, host, root, video, dispose };
}
test('only actual playing video enables automatic PiP, pause and detach disable it', () => {
  const { request, video, dispose } = fixture();
  expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: false, width: 1920, height: 1080 });
  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  video.dispatchEvent(new Event('playing'));
  expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: true, width: 1920, height: 1080 });
  Object.defineProperty(video, 'paused', { value: true, configurable: true });
  video.dispatchEvent(new Event('pause'));
  expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: false, width: 1920, height: 1080 });
  dispose(); expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: false });
});
test('PiP isolates existing video surface and restores exact host without replacing video', () => {
  const { root, host, video, dispose } = fixture();
  root.style.color = 'red';
  const initialStyle = root.getAttribute('style');
  window.dispatchEvent(new CustomEvent('muzio-pip', { detail: true }));
  expect(root.parentElement).toBe(document.body);
  expect(root.querySelector('video')).toBe(video);
  expect(document.body.hasAttribute('data-muzio-pip')).toBe(true);
  window.dispatchEvent(new CustomEvent('muzio-pip', { detail: false }));
  expect(root.parentElement).toBe(host);
  expect(root.getAttribute('style')).toBe(initialStyle);
  expect(document.body.hasAttribute('data-muzio-pip')).toBe(false);
  dispose();
});
test('stopping invisible Activity pauses video, cleanup while PiP restores layout', () => {
  const { video, host, root, dispose } = fixture();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  window.dispatchEvent(new Event('muzio-video-stop'));
  expect(pause).toHaveBeenCalledOnce();
  window.dispatchEvent(new CustomEvent('muzio-pip', { detail: true }));
  dispose(); expect(root.parentElement).toBe(host);
  expect(document.head.textContent).not.toContain('data-muzio-pip-video');
});

test('PiP covers visual viewport when Android page scale makes CSS viewport smaller', () => {
  const viewport = new EventTarget();
  Object.assign(viewport, { width: 251.04, height: 140.82 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerWidth', 251);
  vi.stubGlobal('innerHeight', 141);
  const { root, dispose } = fixture();
  window.dispatchEvent(new CustomEvent('muzio-pip', { detail: true }));
  expect(root.style.width).toBe('251.04px');
  expect(root.style.height).toBe('140.82px');
  expect(document.documentElement.hasAttribute('data-muzio-pip')).toBe(true);
  Object.assign(viewport, { width: 300, height: 170 });
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.width).toBe('300px');
  expect(root.style.height).toBe('170px');
  dispose();
  expect(document.documentElement.hasAttribute('data-muzio-pip')).toBe(false);
  vi.unstubAllGlobals();
});

test('PiP pause and play control the same video repeatedly and report actual state', async () => {
  const { video, request, dispose } = fixture();
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    video.dispatchEvent(new Event('pause'));
  });
  const play = vi.spyOn(video, 'play').mockImplementation(async () => {
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    video.dispatchEvent(new Event('playing'));
  });
  const control = (command: string) => window.dispatchEvent(new CustomEvent('muzio-video-control', { detail: command }));
  control('play');
  expect(play).not.toHaveBeenCalled();
  window.dispatchEvent(new CustomEvent('muzio-pip', { detail: true }));
  for (let cycle = 0; cycle < 3; cycle++) {
    control('play'); await Promise.resolve();
    expect(video.paused).toBe(false);
    expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: true, width: 1920, height: 1080 });
    control('play'); await Promise.resolve();
    expect(video.paused).toBe(false);
    expect(pause).toHaveBeenCalledTimes(cycle);
    control('pause');
    expect(video.paused).toBe(true);
    expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: false, width: 1920, height: 1080 });
  }
  const calls = play.mock.calls.length;
  control('toggle');
  expect(play).toHaveBeenCalledTimes(calls);
  dispose();
  control('play');
  expect(play).toHaveBeenCalledTimes(calls);
});

test('a rejected PiP play reports paused state and allows another attempt', async () => {
  const { video, request, dispose } = fixture();
  const play = vi.spyOn(video, 'play').mockRejectedValueOnce(new Error('interrupted'))
    .mockImplementationOnce(async () => {
      Object.defineProperty(video, 'paused', { value: false, configurable: true });
    });
  window.dispatchEvent(new CustomEvent('muzio-pip', { detail: true }));
  const control = () => window.dispatchEvent(new CustomEvent('muzio-video-control', { detail: 'play' }));
  control(); await Promise.resolve();
  expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: false, width: 1920, height: 1080 });
  control(); await Promise.resolve();
  expect(play).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith('shell.videoState', { playing: true, width: 1920, height: 1080 });
  dispose();
});
