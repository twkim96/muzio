import { HLSProviderLoader, type MediaProviderAdapter } from '@vidstack/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureEmbeddedHLSProvider,
  supportsEmbeddedHLSPlayback,
} from './hlsPlaybackSupport';

describe('PersistentVidstackPlayer HLS support', () => {
  const originalSupported = HLSProviderLoader.supported;

  afterEach(() => {
    HLSProviderLoader.supported = originalSupported;
    vi.restoreAllMocks();
  });

  it('accepts MediaSource-backed HLS even without native video HLS', () => {
    HLSProviderLoader.supported = true;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');

    expect(supportsEmbeddedHLSPlayback()).toBe(true);
  });

  it('keeps native HLS support when the HLS.js provider is unavailable', () => {
    HLSProviderLoader.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');

    expect(supportsEmbeddedHLSPlayback()).toBe(true);
  });

  it('uses the bundled HLS.js loader for Vidstack HLS providers', async () => {
    const provider = {
      $$PROVIDER_TYPE: 'HLS',
      library: null,
    } as unknown as MediaProviderAdapter & {
      library: (() => Promise<unknown>) | null;
    };

    configureEmbeddedHLSProvider(provider);

    expect(provider.library).toBeTypeOf('function');
    const module = await provider.library!();
    expect(module).toHaveProperty('default');
  });
});
