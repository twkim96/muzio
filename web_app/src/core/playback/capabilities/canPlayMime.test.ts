import { describe, expect, test } from 'vitest';

import { canPlayMime } from './canPlayMime';

function probe(value: string) {
  return { canPlayType: () => value };
}

describe('canPlayMime', () => {
  test('returns probably for the strongest support level', () => {
    expect(canPlayMime('audio/mpeg', probe('probably'))).toBe('probably');
  });

  test('returns maybe for ambiguous support', () => {
    expect(canPlayMime('video/webm', probe('maybe'))).toBe('maybe');
  });

  test('returns no for empty support string', () => {
    expect(canPlayMime('video/x-fake', probe(''))).toBe('no');
  });

  test('returns no for empty or whitespace MIME', () => {
    expect(canPlayMime('', probe('probably'))).toBe('no');
    expect(canPlayMime('   ', probe('probably'))).toBe('no');
  });

  test('returns no for unexpected probe responses', () => {
    expect(canPlayMime('video/mp4', probe('definitely'))).toBe('no');
  });
});
