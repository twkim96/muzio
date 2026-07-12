import type { HealthCheckResult } from '../../core/api/healthCheck';

/**
 * Pure helper that converts a probe result into a presentation string.
 * Lifted out of the screen component so unit tests can assert against the
 * exact wording without rendering the React tree.
 */
export function describeHealthResult(result: HealthCheckResult): string {
  switch (result.kind) {
    case 'ok':
      return `Connected to ${result.service}`;
    case 'badResponse':
      return `Server replied with HTTP ${result.statusCode}`;
    case 'unreachable':
      return `Unreachable: ${result.message}`;
  }
}
