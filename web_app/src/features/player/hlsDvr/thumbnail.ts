/** Share a tiny decoded frame with the other viewers, without loading another video. */
export function connectHlsThumbnail(root: HTMLElement, playbackUrl: string): () => void {
  const url = new URL(playbackUrl, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/hls-cache/')) return () => {};
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) + 'thumbnail.jpg';
  url.search = ''; url.hash = '';
  let disposed = false, busy = false, lastAttempt = -Infinity;
  let request: AbortController | undefined;
  const capture = async () => {
    const video = root.querySelector('video');
    if (disposed || busy || Date.now() - lastAttempt < 60_000 || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    busy = true; lastAttempt = Date.now();
    try {
      const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 108;
      const context = canvas.getContext('2d'); if (!context) return;
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = canvas.width / scale, height = canvas.height / scale;
      context.drawImage(video, (video.videoWidth-width)/2, (video.videoHeight-height)/2, width, height, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7));
      if (disposed || !jpeg || jpeg.size > 64*1024) return;
      const abort = new AbortController(); request = abort;
      const timeout = setTimeout(() => abort.abort(), 12_000);
      try { await fetch(url.href, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg, signal: abort.signal }); }
      finally { clearTimeout(timeout); request = undefined; }
    } catch { /* A missing/blocked frame must never interrupt playback. */ }
    finally { busy = false; }
  };
  const update = () => { void capture(); };
  root.addEventListener('loadeddata', update, true);
  root.addEventListener('playing', update, true);
  const interval = setInterval(update, 60_000);
  update();
  return () => { disposed = true; request?.abort(); clearInterval(interval); root.removeEventListener('loadeddata', update, true); root.removeEventListener('playing', update, true); };
}
