export function absolutePlaybackUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  return new URL(url, window.location.href).href;
}

export function openPlaybackStream(url: string): void {
  window.open(absolutePlaybackUrl(url), '_blank', 'noopener,noreferrer');
}

export async function shareOrCopyPlaybackStream(
  title: string,
  sourceUrl: string,
): Promise<'shared' | 'copied' | 'unavailable' | 'cancelled' | 'failed'> {
  const url = absolutePlaybackUrl(sourceUrl);
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({ title, url });
      return 'shared';
    }
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
    return 'unavailable';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return 'cancelled';
    }
    return 'failed';
  }
}
