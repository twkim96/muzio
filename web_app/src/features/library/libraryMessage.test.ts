import { describe, expect, test } from 'vitest';

import { describeLibraryError } from './libraryMessage';

describe('describeLibraryError', () => {
  test('formats badResponse with the status code', () => {
    expect(
      describeLibraryError({ kind: 'badResponse', statusCode: 500 }),
    ).toBe('Server replied with HTTP 500');
  });

  test('formats unreachable with the message', () => {
    expect(
      describeLibraryError({ kind: 'unreachable', message: 'refused' }),
    ).toBe('Backend unreachable: refused');
  });

  test('returns empty string for ok results', () => {
    expect(
      describeLibraryError({ kind: 'ok', items: [] }),
    ).toBe('');
  });
});
