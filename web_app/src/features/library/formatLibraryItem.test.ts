import { describe, expect, test } from 'vitest';

import {
  formatDuration,
  formatModified,
  formatSize,
  splitPath,
} from './formatLibraryItem';

describe('formatSize', () => {
  test('returns bytes for sub-KB values', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  test('returns KB with one decimal place for KB-range values', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1500)).toBe('1.5 KB');
  });

  test('returns MB with one decimal place for MB-range values', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 5 + 1024 * 100)).toBe('5.1 MB');
  });

  test('returns GB with two decimal places for GB-range values', () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatSize(1024 * 1024 * 1024 * 8 + 1024 * 1024 * 500)).toBe(
      '8.49 GB',
    );
  });

  test('returns dash for negative or non-finite values', () => {
    expect(formatSize(-1)).toBe('—');
    expect(formatSize(Number.NaN)).toBe('—');
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatModified', () => {
  test('formats RFC3339 UTC as YYYY-MM-DD', () => {
    expect(formatModified('2025-01-15T10:30:00Z')).toBe('2025-01-15');
  });

  test('preserves UTC even when input has an offset', () => {
    expect(formatModified('2025-01-15T22:00:00-09:00')).toBe('2025-01-16');
  });

  test('returns dash for invalid input', () => {
    expect(formatModified('not a date')).toBe('—');
    expect(formatModified('')).toBe('—');
  });
});

describe('formatDuration', () => {
  test('formats minutes and hours', () => {
    expect(formatDuration(2700)).toBe('45m');
    expect(formatDuration(5400)).toBe('1h 30m');
  });

  test('returns empty string for unknown duration', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('');
  });
});

describe('splitPath', () => {
  test('splits nested paths into directory and filename', () => {
    expect(splitPath('Inception/Inception.mkv')).toEqual({
      directory: 'Inception/',
      filename: 'Inception.mkv',
    });
    expect(splitPath('a/b/c.mp3')).toEqual({
      directory: 'a/b/',
      filename: 'c.mp3',
    });
  });

  test('returns empty directory for root-level files', () => {
    expect(splitPath('song.mp3')).toEqual({
      directory: '',
      filename: 'song.mp3',
    });
  });
});
