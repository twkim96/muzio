import type { PlaybackSource } from '../playback/source/source';
import { nativeMessagePort } from './nativeBridge';

/** Keep media identity and saved progress on the original server source. */
export function videoIndexSource(source: PlaybackSource): PlaybackSource {
  const port = nativeMessagePort();
  if (!port?.videoIndexBaseUrl || !['ios', 'macos'].includes(port.platform ?? '') ||
      source.mediaType !== 'video' || source.location === 'local') return source;
  try {
    const base = new URL(port.videoIndexBaseUrl);
    const original = new URL(source.url, window.location.href);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname) || !base.port ||
        base.username || base.password || base.search || base.hash ||
        !/^\/[a-f0-9]{32}\/$/.test(base.pathname) ||
        original.origin !== window.location.origin ||
        original.pathname !== `/api/media/${encodeURIComponent(source.mediaId)}` ||
        original.searchParams.has('index')) return source;
    const proxy = new URL(original.pathname.slice(1), base);
    proxy.search = original.search;
    proxy.hash = original.hash;
    return { ...source, url: proxy.href };
  } catch {
    return source;
  }
}
