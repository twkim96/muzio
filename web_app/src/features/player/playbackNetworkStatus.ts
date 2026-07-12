import { useEffect, useState } from 'react';

import type { PlaybackStatus } from '../../core/playback/session/session';
import type { PlaybackSource } from '../../core/playback/source/source';

export const AUDIO_NETWORK_RETRY_HINT_DELAY_MS = 7000;

export interface PlaybackNetworkHint {
  message: string;
  retryLabel: string;
}

export function usePlaybackNetworkHint(
  status: PlaybackStatus,
  source: PlaybackSource | null,
): PlaybackNetworkHint | null {
  const [retryHintReady, setRetryHintReady] = useState(false);
  const isAudio = source?.mediaType === 'audio';
  const statusKind = status.kind;
  const sourceId = source?.mediaId ?? null;

  useEffect(() => {
    setRetryHintReady(false);
    if (
      !isAudio ||
      (statusKind !== 'loading' && statusKind !== 'buffering')
    ) {
      return;
    }

    const handle = window.setTimeout(() => {
      setRetryHintReady(true);
    }, AUDIO_NETWORK_RETRY_HINT_DELAY_MS);

    return () => window.clearTimeout(handle);
  }, [isAudio, sourceId, statusKind]);

  if (!isAudio) return null;
  if (status.kind === 'loading' && retryHintReady) {
    return {
      message: 'Still loading audio. Network may be slow.',
      retryLabel: 'Retry',
    };
  }
  if (status.kind === 'buffering' && retryHintReady) {
    return {
      message: 'Buffering. Waiting for network.',
      retryLabel: 'Retry',
    };
  }
  if (status.kind === 'error') {
    return {
      message: 'Playback error. Retry when ready.',
      retryLabel: 'Retry',
    };
  }
  return null;
}
