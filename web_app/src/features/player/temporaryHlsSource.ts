import type { PlaybackSource } from '../../core/playback/source/source';

let sequence = 0;
const nextAttemptId = () => `${Date.now()}-${++sequence}`;

/** Shared contract for manual input and extension links. Never persist signed URLs. */
export function temporaryHlsSource(raw: string, title = ''): PlaybackSource {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { throw new Error('올바른 HLS URL을 입력해 주세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('사용자 정보가 없는 HTTP 또는 HTTPS URL을 입력해 주세요.');
  }
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.protocol === 'http:') {
    throw new Error('HTTPS로 실행 중인 Muzio에서는 HTTPS 스트림 URL을 입력해 주세요.');
  }
  return {
    kind: 'remote', mediaType: 'video', transient: true,
    mediaId: `temporary-hls:${globalThis.crypto?.randomUUID?.() ?? `${nextAttemptId()}-${Math.random().toString(36).slice(2)}`}`,
    url: url.href, mimeType: 'application/vnd.apple.mpegurl',
    name: title.trim().slice(0, 200) || `HLS · ${url.hostname}`,
  };
}

/** The fragment keeps stream tokens out of the Muzio server's request URL. */
export function hlsEntryUrl(muzioUrl: string, streamUrl: string, title = ''): string {
  const entry = new URL('/play/hls', muzioUrl);
  entry.hash = new URLSearchParams({ url: streamUrl, ...(title ? { title } : {}) }).toString();
  return entry.href;
}

/** A new fragment forces provider reload without changing signed query parameters. */
export function reconnectTemporaryHlsSource(source: PlaybackSource): PlaybackSource {
  if (!source.transient) return source;
  const url = new URL(source.url);
  url.hash = `muzio-reconnect=${nextAttemptId()}`;
  return { ...source, url: url.href };
}
