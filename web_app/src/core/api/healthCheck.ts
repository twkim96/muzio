/**
 * Probes the backend's /healthz endpoint over the **same origin** as the web
 * app. The Phase 1 backend returns
 * `{"status":"ok","service":"muzio-backend"}`; any other shape is
 * treated as a misconfigured target rather than a broken backend, because
 * users sometimes place the web app behind an unrelated reverse proxy.
 *
 * The web client never points at an absolute URL chosen by the user. In
 * development the Vite proxy forwards `/healthz` to the Go backend; in
 * production the same Go backend serves the web bundle. Cross-origin probing
 * would require a CORS surface we deliberately do not expose. Per-server
 * profile selection (entering an arbitrary backend URL) is an Android-only
 * concern and lands with Phase 9 in its own native code.
 */
export type HealthCheckResult =
  | { kind: 'ok'; service: string }
  | { kind: 'badResponse'; statusCode: number }
  | { kind: 'unreachable'; message: string };

export interface HealthCheckOptions {
  /** Override the global fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Probe timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const HEALTH_PATH = '/healthz';

export async function probeHealth(
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // The timeout must protect headers AND body parsing. Servers can stream
  // headers immediately and then stall the body, which would otherwise leave
  // response.json() pending forever after the AbortController was cleaned up.
  try {
    let response: Response;
    try {
      response = await fetchImpl(HEALTH_PATH, { signal: controller.signal });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { kind: 'unreachable', message: 'connection timed out' };
      }
      return {
        kind: 'unreachable',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (response.status !== 200) {
      return { kind: 'badResponse', statusCode: response.status };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        return { kind: 'unreachable', message: 'connection timed out' };
      }
      return { kind: 'badResponse', statusCode: 200 };
    }

    if (!isRecord(body) || body.status !== 'ok') {
      return { kind: 'badResponse', statusCode: 200 };
    }
    const service = typeof body.service === 'string' ? body.service : 'unknown';
    return { kind: 'ok', service };
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
