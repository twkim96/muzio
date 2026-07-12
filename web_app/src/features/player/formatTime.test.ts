import { describe, expect, test } from 'vitest';

import { formatTime } from './formatTime';

describe('formatTime', () => {
  test('formats sub-minute as 0:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(7)).toBe('0:07');
    expect(formatTime(59)).toBe('0:59');
  });

  test('formats sub-hour as m:ss', () => {
    expect(formatTime(60)).toBe('1:00');
    expect(formatTime(125)).toBe('2:05');
    expect(formatTime(3599)).toBe('59:59');
  });

  test('formats hour-and-up as h:mm:ss', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3661)).toBe('1:01:01');
    expect(formatTime(36000)).toBe('10:00:00');
  });

  test('floors fractional seconds', () => {
    expect(formatTime(7.9)).toBe('0:07');
  });

  test('returns 0:00 for non-finite or negative input', () => {
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatTime(-1)).toBe('0:00');
  });
});
