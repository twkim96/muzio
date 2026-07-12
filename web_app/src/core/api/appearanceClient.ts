export interface AppearanceSettingsPayload {
  surfaceColor: string;
  foregroundColor: string;
  mutedColor: string;
  accentColor: string;
}

export interface AppearanceSettingsResponse {
  settings: AppearanceSettingsPayload;
  persisted: boolean;
}

export type AppearanceResult =
  | { kind: 'ok'; response: AppearanceSettingsResponse }
  | { kind: 'badResponse'; statusCode: number; message?: string }
  | { kind: 'unreachable'; message: string };

export interface AppearanceOptions {
  fetchImpl?: typeof fetch;
}

const APPEARANCE_PATH = '/api/settings/appearance';

export async function fetchAppearanceSettings(
  options: AppearanceOptions = {},
): Promise<AppearanceResult> {
  return requestAppearance('GET', undefined, options);
}

export async function updateAppearanceSettings(
  settings: AppearanceSettingsPayload,
  options: AppearanceOptions = {},
): Promise<AppearanceResult> {
  return requestAppearance('PUT', { settings }, options);
}

export async function resetAppearanceSettings(
  options: AppearanceOptions = {},
): Promise<AppearanceResult> {
  return requestAppearance('DELETE', undefined, options);
}

async function requestAppearance(
  method: 'GET' | 'PUT' | 'DELETE',
  body: { settings: AppearanceSettingsPayload } | undefined,
  options: AppearanceOptions,
): Promise<AppearanceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(APPEARANCE_PATH, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: unknown) {
    return {
      kind: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (response.status !== 200) {
    return {
      kind: 'badResponse',
      statusCode: response.status,
      message: await response.text().catch(() => ''),
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { kind: 'badResponse', statusCode: 200 };
  }
  const parsed = parseResponse(raw);
  if (parsed === null) {
    return { kind: 'badResponse', statusCode: 200 };
  }
  return { kind: 'ok', response: parsed };
}

function parseResponse(raw: unknown): AppearanceSettingsResponse | null {
  if (!isRecord(raw) || !isRecord(raw.settings)) return null;
  const settings = raw.settings;
  if (
    typeof settings.surfaceColor !== 'string' ||
    typeof settings.foregroundColor !== 'string' ||
    typeof settings.mutedColor !== 'string' ||
    typeof settings.accentColor !== 'string'
  ) {
    return null;
  }
  return {
    settings: {
      surfaceColor: settings.surfaceColor,
      foregroundColor: settings.foregroundColor,
      mutedColor: settings.mutedColor,
      accentColor: settings.accentColor,
    },
    persisted: raw.persisted === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
