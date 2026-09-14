import { prepareServerHls } from './hlsDvr/serverCache';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GlassModal } from '../../core/ui/GlassModal';
import { usePlayerStore } from './PlayerContext';
import { useOptionalPlayerOverlay } from './PlayerOverlayContext';
import { temporaryHlsSource } from './temporaryHlsSource';

function useHlsPlayback() {
  const store = usePlayerStore();
  const overlay = useOptionalPlayerOverlay();
  const navigate = useNavigate();
  return async (url: string, title = '') => {
    const source = await prepareServerHls(temporaryHlsSource(url, title));
    // Publish playback intent before opening the viewport. The existing engine
    // queues it if the player has not mounted and displays playback errors/retry.
    void store.getState().playSource(source).catch(() => {});
    if (overlay) overlay.open();
    else navigate('/player');
  };
}

export function HlsPlaybackButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="ml-auto inline-flex min-h-10 shrink-0 items-center text-sm font-medium text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      onClick={() => setOpen(true)}>HLS 재생</button>
    {open && <HlsPlaybackDialog onClose={() => setOpen(false)} />}
  </>;
}

function HlsPlaybackDialog({ onClose, initialUrl = '', initialTitle = '', initialError = '' }: {
  onClose: () => void; initialUrl?: string; initialTitle?: string; initialError?: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState(initialError);
  const [opening, setOpening] = useState(false);
  const play = useHlsPlayback();
  return <GlassModal testId="hls-playback-dialog" title="HLS 재생" closeLabel="HLS 재생 닫기" onClose={onClose}
    footer={<button type="submit" form="hls-playback-form" className="muzio-glass-action" disabled={!url.trim() || opening}>재생</button>}>
    <form id="hls-playback-form" className="space-y-3" onSubmit={async event => {
      event.preventDefault();
      setOpening(true);
      try { await play(url, initialTitle); onClose(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'URL을 확인해 주세요.'); }
      finally { setOpening(false); }
    }}>
      <label className="block space-y-2 text-sm">
        <span>HLS URL</span>
        <input type="text" inputMode="url" value={url} autoComplete="off" autoCapitalize="none" spellCheck={false}
          placeholder="https://example.com/stream.m3u8" className="muzio-glass-input w-full px-4 py-2 text-sm outline-none"
          aria-invalid={!!error} aria-describedby={error ? 'hls-url-error' : 'hls-url-help'}
          onChange={event => { setUrl(event.target.value); setError(''); }} />
      </label>
      <p id="hls-url-help" className="text-sm text-muted">라이브러리와 재생 이력에 저장하지 않고 이번에만 재생합니다. 같은 HLS 주소는 저장분을 공유하며 최대 1GB를 보관합니다. 마지막 시청 신호가 끊긴 뒤 30분 동안 수집과 저장을 유지하므로, 그 안에 다시 열면 이어서 볼 수 있습니다.</p>
      <p className="text-xs text-muted">로그인이나 원래 사이트에서의 접근이 필요한 주소는 재생되지 않을 수 있습니다.</p>
      {error && <p id="hls-url-error" role="alert" className="text-sm text-red-500">{error}</p>}
    </form>
  </GlassModal>;
}

/** Extension entry: /play/hls#url=<encoded HTTP(S) URL>&title=<optional title>. */
export function HlsPlaybackEntryRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const play = useHlsPlayback();
  const handled = useRef(false);
  const [request] = useState(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    return { url: params.get('url') ?? '', title: params.get('title') ?? '' };
  });
  const [error, setError] = useState('');
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    // Strip the fragment immediately, including malformed input.
    navigate('/play/hls', { replace: true });
    if (!request.url) return;
    try {
      temporaryHlsSource(request.url, request.title);
      void play(request.url, request.title).then(() => navigate('/library/video', { replace: true })).catch(cause => { setError(cause instanceof Error ? cause.message : 'HLS를 열지 못했습니다.'); });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'URL을 확인해 주세요.');
    }
  }, [navigate, play, request]);
  return <HlsPlaybackDialog key={error} initialUrl={request.url} initialTitle={request.title} initialError={error}
    onClose={() => navigate('/library/video', { replace: true })} />;
}
