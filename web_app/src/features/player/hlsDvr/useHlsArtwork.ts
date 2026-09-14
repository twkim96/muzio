import { useEffect, useState } from 'react';
import type { PlaybackSource } from '../../../core/playback/source/source';

/** Read shared thumbnail metadata without opening media or extending its lease. */
export function useHlsArtwork(source: PlaybackSource | null): string | undefined {
  const id = source?.transient ? source.mediaId : undefined;
  const [artwork, setArtwork] = useState<{ id: string; url?: string }>();
  useEffect(() => {
    if (!id) return;
    let disposed = false, busy = false;
    let request: AbortController | undefined;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      const abort = new AbortController(); request = abort;
      const timeout = setTimeout(() => abort.abort(), 10_000);
      try {
        const response = await fetch('/api/hls-sessions', { cache: 'no-store', signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json() as { items?: { id: string; thumbnailUrl?: string }[] };
        if (!disposed && Array.isArray(data.items)) setArtwork({ id, url: data.items.find(item => item.id === id)?.thumbnailUrl });
      } catch { /* Keep the last frame during short network failures. */ }
      finally { clearTimeout(timeout); request = undefined; busy = false; }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => { disposed = true; request?.abort(); clearInterval(interval); };
  }, [id]);
  return id ? (artwork?.id === id ? artwork.url : undefined) : source?.artworkUrl;
}
