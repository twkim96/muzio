import { describe, expect, test } from 'vitest';
import { hlsEntryUrl, reconnectTemporaryHlsSource, temporaryHlsSource } from './temporaryHlsSource';

describe('one-time HLS input', () => {
  test.each(['javascript:alert(1)', 'file:///tmp/a.m3u8', 'data:text/plain,x', '/relative.m3u8', 'https://user:pass@example.com/a.m3u8', 'not a url'])('rejects %s', value => {
    expect(() => temporaryHlsSource(value)).toThrow();
  });
  test('preserves signed query strings and extensionless HLS endpoints', () => {
    const url = 'https://example.com/play?sig=a%2Bb%2Fc%3D&x=one+two&x=three#t=3';
    const source = temporaryHlsSource(` ${url} `, ' Broadcast ');
    expect(source).toMatchObject({ url, name: 'Broadcast', transient: true, mediaType: 'video', mimeType: 'application/vnd.apple.mpegurl' });
    expect(source.mediaId).not.toBe(temporaryHlsSource(url).mediaId);
    expect(source.mediaId).not.toContain('sig=');
    const entry = new URL(hlsEntryUrl('https://muzio.example/settings', url, '한글 & title'));
    expect(entry.pathname).toBe('/play/hls');
    expect(entry.search).toBe('');
    expect(new URLSearchParams(entry.hash.slice(1)).get('url')).toBe(url);
    expect(new URLSearchParams(entry.hash.slice(1)).get('title')).toBe('한글 & title');
  });
});

test('reconnection reloads HLS without changing signed request parameters or media identity', () => {
  const source = temporaryHlsSource('https://example.com/live.m3u8?sig=a%2Bb%3D');
  const retry = reconnectTemporaryHlsSource(source);
  expect(retry.mediaId).toBe(source.mediaId);
  expect(new URL(retry.url).search).toBe(new URL(source.url).search);
  expect(retry.url).not.toBe(source.url);
  expect(reconnectTemporaryHlsSource(retry).url).not.toBe(retry.url);
});
