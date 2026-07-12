import { describe, expect, test } from 'vitest';

import { describeHealthResult } from './healthMessage';

describe('describeHealthResult', () => {
  test('formats ok results with the service name', () => {
    expect(
      describeHealthResult({ kind: 'ok', service: 'muzio-backend' }),
    ).toBe('Connected to muzio-backend');
  });

  test('formats badResponse results with the status code', () => {
    expect(
      describeHealthResult({ kind: 'badResponse', statusCode: 404 }),
    ).toBe('Server replied with HTTP 404');
  });

  test('formats unreachable results with the message', () => {
    expect(
      describeHealthResult({ kind: 'unreachable', message: 'refused' }),
    ).toBe('Unreachable: refused');
  });
});
