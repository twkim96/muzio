import { describe, expect, test } from 'vitest';

import { describePlaybackStatus } from './playerMessage';

describe('describePlaybackStatus', () => {
  test('returns empty for idle and playing', () => {
    expect(describePlaybackStatus({ kind: 'idle' })).toBe('');
    expect(describePlaybackStatus({ kind: 'playing' })).toBe('');
  });

  test('describes loading and buffering', () => {
    expect(describePlaybackStatus({ kind: 'loading' })).toBe('Loading…');
    expect(describePlaybackStatus({ kind: 'buffering' })).toBe('Buffering…');
  });

  test('describes paused and ended', () => {
    expect(describePlaybackStatus({ kind: 'paused' })).toBe('Paused');
    expect(describePlaybackStatus({ kind: 'ended' })).toBe('Ended');
  });

  test('describes errors with the message', () => {
    expect(
      describePlaybackStatus({ kind: 'error', message: 'source not supported' }),
    ).toBe('Playback error: source not supported');
  });
});
