import { afterEach, expect, test, vi } from 'vitest';
import type { PlaybackSource } from '../playback/source/source';
import { videoIndexSource } from './videoIndexSource';

const source: PlaybackSource = {
  kind: 'remote', mediaId: 'video1', mediaType: 'video', name: 'test.mp4',
  url: '/api/media/video1?v=2#t=21600',
};
const base = 'http://127.0.0.1:12345/0123456789abcdef0123456789abcdef/';
function port(videoIndexBaseUrl = base, platform = 'macos') {
  vi.stubGlobal('MuzioNative', { platform, videoIndexBaseUrl, postMessage: vi.fn() });
}
afterEach(() => vi.unstubAllGlobals());

test('uses the native video proxy while retaining media identity and resume fragment', () => {
  port();
  expect(videoIndexSource(source)).toEqual({ ...source, url: `${base}api/media/video1?v=2#t=21600` });
});

test('older hosts, audio, local, optimized, and foreign sources retain their URL', () => {
  expect(videoIndexSource(source)).toBe(source);
  port();
  for (const candidate of [
    { ...source, mediaType: 'audio' as const },
    { ...source, location: 'local' as const },
    { ...source, url: '/api/video-optimization/video1/playlist.m3u8' },
    { ...source, url: 'https://example.com/api/media/video1' },
  ]) expect(videoIndexSource(candidate)).toBe(candidate);
  port(base, 'android');
  expect(videoIndexSource(source)).toBe(source);
});

test('rejects malformed or non-loopback proxy metadata', () => {
  for (const value of ['https://example.com/', 'http://127.0.0.1:12345/no-token/', `${base}?other=1`, base.replace('127.0.0.1', 'localhost')]) {
    port(value);
    expect(videoIndexSource(source)).toBe(source);
  }
});
