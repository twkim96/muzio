import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../PlayerContext';
import { useOptionalPlayerOverlay } from '../PlayerOverlayContext';
import { temporaryHlsSource } from '../temporaryHlsSource';
import { deleteHlsSession, pingHlsSession, prepareServerHls } from './serverCache';

export interface SharedHlsSession { id: string; url: string; title: string; state: 'live' | 'unknown' | 'ended' | 'stopped'; playbackUrl?: string; thumbnailUrl?: string; bytes?: number; lastSeenAt?: number }
/** Only the current temporary video sends a viewing heartbeat, including while paused. */
export function SharedHlsSessionSync() {
  const store = usePlayerStore();
  const id = store(state => state.active === 'video' && state.video.source?.transient ? state.video.source.mediaId : undefined);
  useEffect(() => {
    if (!id) return;
    let inFlight = false;
    const ping = () => {
      if (inFlight) return;
      inFlight = true;
      void pingHlsSession(id).catch(() => {}).finally(() => { inFlight = false; });
    };
    ping();
    window.addEventListener('pageshow', ping);
    window.addEventListener('online', ping);
    document.addEventListener('visibilitychange', ping);
    const interval = setInterval(ping, 60_000);
    return () => {
      clearInterval(interval);
      window.removeEventListener('pageshow', ping); window.removeEventListener('online', ping);
      document.removeEventListener('visibilitychange', ping);
      // Leaving a tab or switching video stops only this viewer's heartbeat.
      // The shared recording continues until every viewer has been absent 20 min.
    };
  }, [id]);
  return null;
}
export function SharedHlsSessions() {
  const [items, setItems] = useState<SharedHlsSession[]>([]);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const removed = useRef(new Set<string>());
  const store = usePlayerStore();
  const current = store(state => state.video.source);
  const active = store(state => state.active);
  const overlay = useOptionalPlayerOverlay();
  useEffect(() => {
    let disposed = false, inFlight = false, lastSuccess = Date.now();
    const refresh = async () => {
      if (Date.now() - lastSuccess >= 20 * 60_000) setItems([]);
      if (inFlight) return; inFlight = true;
      try {
        const response = await fetch('/api/hls-sessions', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return;
        const data = await response.json() as { items?: SharedHlsSession[] };
        if (!disposed && Array.isArray(data.items)) { lastSuccess = Date.now(); setItems(data.items.filter(item => !removed.current.has(item.id))); }
      } catch { /* Keep the last snapshot during a brief network interruption. */ }
      finally { inFlight = false; }
    };
    void refresh(); const interval = setInterval(() => void refresh(), 10_000);
    return () => { disposed = true; clearInterval(interval); };
  }, []);
  if (!items.length && !error) return null;
  return <section aria-label="임시 HLS" className="mb-3 min-w-0 max-w-full border-b border-[color:var(--color-border)] pb-3">
    <h3 className="px-2 py-2 text-sm font-medium">임시 HLS</h3>
    <ul className="grid min-w-0 grid-cols-1 gap-1">{items.map(item => <li key={item.id} className="flex min-w-0 items-center gap-1">
      <button type="button" disabled={opening || !!deleting} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-foreground/10"
        onClick={async () => {
          setError(''); setOpening(true);
          try {
            if (current?.mediaId !== item.id || active !== 'video') {
              const source = await prepareServerHls(temporaryHlsSource(item.url, item.title));
              void store.getState().playSource(source).catch(() => {});
            }
            overlay?.open();
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'HLS를 열지 못했습니다.'); }
          finally { setOpening(false); }
        }}>
        <HlsThumbnail url={item.thumbnailUrl} />
        <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.title}</span>
        <span className="block whitespace-normal break-words text-xs text-muted">{item.state === 'ended' ? '방송 종료 · 보관 중' : item.state === 'stopped' ? '수집 중지 · 보관 중' : item.state === 'unknown' ? '상태 확인 필요' : '라이브'} · {hlsStoredSize(item.bytes)} / 1.5GB{current?.mediaId === item.id ? ' · 현재 세션' : ''}{item.lastSeenAt && Number.isFinite(item.lastSeenAt) ? <span className="ml-2 inline-block" title={`마지막 시청 신호: ${new Date(item.lastSeenAt).toLocaleString('ko-KR')}`}>{new Date(item.lastSeenAt).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span> : null}</span>
        </span>
      </button>
      <button type="button" aria-label={`저장분 삭제: ${item.title}`} title="공유 HLS 녹화와 저장분 즉시 삭제"
        disabled={opening || !!deleting} className="mr-2 min-h-10 shrink-0 rounded-lg px-2 text-xs text-muted hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
        onClick={async () => {
          setError(''); setDeleting(item.id);
          try {
            await deleteHlsSession(item.id);
            removed.current.add(item.id); setItems(rows => rows.filter(row => row.id !== item.id));
            const state = store.getState();
            if (state.active === 'video' && state.video.source?.mediaId === item.id) state.pauseActive();
          } catch (cause) { setError(cause instanceof Error ? cause.message : '삭제하지 못했습니다.'); }
          finally { setDeleting(undefined); }
        }}>{deleting === item.id ? '삭제 중' : '삭제'}</button>
    </li>)}</ul>
    {error && <p role="alert" className="px-2 text-xs text-red-500">{error}</p>}
  </section>;
}

function HlsThumbnail({ url }: { url?: string }) {
  const [failed, setFailed] = useState<string>();
  return <span className="relative aspect-video w-20 shrink-0 overflow-hidden rounded-md bg-foreground/10 sm:w-24" aria-hidden="true">
    {url && failed !== url
      ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(url)} />
      : <span className="absolute inset-0 grid place-items-center text-muted"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></span>}
  </span>;
}

function hlsStoredSize(bytes = 0): string {
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)}GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)}MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)}KB`;
  return `${size}B`;
}
