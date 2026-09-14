import type { PlaybackSource } from '../../../core/playback/source/source';

/** The server atomically joins viewers by their complete signed HLS URL. */
export async function prepareServerHls(source: PlaybackSource): Promise<PlaybackSource> {
  if (!source.transient) return source;
  const original = source.hlsOriginalUrl ?? source.url;
  const response = await fetch('/api/hls-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register', url: original, title: source.title ?? source.name ?? 'HLS' }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('서버 HLS 캐시를 열지 못했습니다. 서버 연결과 저장 공간을 확인해 주세요.');
  const data = await response.json() as { id: string; playbackUrl: string };
  if (!data.id || !data.playbackUrl?.startsWith('/api/hls-cache/')) throw new Error('서버 HLS 재생 주소가 올바르지 않습니다.');
  return { ...source, mediaId: data.id, hlsOriginalUrl: original, url: new URL(data.playbackUrl, window.location.origin).href };
}
/** Paused/buffered players may make no media requests, so renew once a minute too. */
export async function pingHlsSession(id: string): Promise<void> {
  await fetch('/api/hls-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'heartbeat', id }), signal: AbortSignal.timeout(10_000),
  });
}

export async function deleteHlsSession(id: string): Promise<void> {
  const response = await fetch('/api/hls-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id }), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('HLS 저장분을 삭제하지 못했습니다. 다시 시도해 주세요.');
}
