import {
  HLSProviderLoader,
  isHLSProvider,
  type MediaProviderAdapter,
} from '@vidstack/react';

export function supportsEmbeddedHLSPlayback(): boolean {
  if (HLSProviderLoader.supported) return true;
  if (typeof document === 'undefined') return false;
  try {
    const video = document.createElement('video');
    return video.canPlayType('application/vnd.apple.mpegurl') !== '' ||
      video.canPlayType('application/x-mpegURL') !== '';
  } catch {
    return false;
  }
}

export function configureEmbeddedHLSProvider(
  provider: MediaProviderAdapter | null,
): void {
  if (!isHLSProvider(provider)) return;
  provider.library = () => import('hls.js');
}
