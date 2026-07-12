import type { PlaybackStatus } from '../../core/playback/session/session';

/**
 * Pure formatter for status banners shown next to the player controls.
 * Component code stays dumb; tests pin the wording.
 */
export function describePlaybackStatus(status: PlaybackStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'loading':
      return 'Loading…';
    case 'buffering':
      return 'Buffering…';
    case 'playing':
      return '';
    case 'paused':
      return 'Paused';
    case 'ended':
      return 'Ended';
    case 'error':
      return `Playback error: ${status.message}`;
  }
}
