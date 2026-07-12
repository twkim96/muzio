import {
  fetchAppearanceSettings,
  type AppearanceSettingsPayload,
} from '../../core/api/appearanceClient';

export type ThemePreference = 'light' | 'dark';

export type ThemeMode = ThemePreference | 'custom';

export interface ThemeSettings {
  mode: ThemeMode;
  surfaceColor: string;
  foregroundColor: string;
  mutedColor: string;
  accentColor: string;
}

export const DARK_THEME_SETTINGS: ThemeSettings = {
  mode: 'dark',
  surfaceColor: '#1f1f1f',
  foregroundColor: '#ededed',
  mutedColor: '#aeaeae',
  accentColor: '#fa2d48',
};

export const LIGHT_THEME_SETTINGS: ThemeSettings = {
  mode: 'light',
  surfaceColor: '#ffffff',
  foregroundColor: '#09090b',
  mutedColor: '#71717a',
  accentColor: '#fa2d48',
};

export const DEFAULT_THEME_SETTINGS = DARK_THEME_SETTINGS;
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

const STORAGE_KEY = 'muzio.theme';
const SETTINGS_STORAGE_KEY = 'muzio.theme.settings';
const LEGACY_STORAGE_KEY = 'videio.theme';
const LEGACY_SETTINGS_STORAGE_KEY = 'videio.theme.settings';
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function readThemeSettings(): ThemeSettings {
  if (typeof window === 'undefined') return DEFAULT_THEME_SETTINGS;

  try {
    const rawSettings =
      window.localStorage.getItem(SETTINGS_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
    if (rawSettings) {
      const parsed: unknown = JSON.parse(rawSettings);
      if (isThemeSettingsRecord(parsed)) {
        const settings = normalizeThemeSettings(parsed);
        migrateLegacyThemeSettings(settings);
        return settings;
      }
    }
  } catch {
    // Fall back to the legacy preference below.
  }

  const storedPreference =
    window.localStorage.getItem(STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_STORAGE_KEY);
  const preference = isThemePreference(storedPreference)
    ? storedPreference
    : DEFAULT_THEME_PREFERENCE;
  if (isThemePreference(storedPreference)) {
    window.localStorage.setItem(STORAGE_KEY, storedPreference);
  }
  return presetThemeSettings(preference);
}

export function hasStoredThemeSettings(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.localStorage.getItem(SETTINGS_STORAGE_KEY) !== null ||
    window.localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY) !== null
  );
}

export async function syncThemeSettingsFromServer(): Promise<{
  settings: ThemeSettings;
  persisted: boolean;
}> {
  const result = await fetchAppearanceSettings();
  if (result.kind !== 'ok') {
    throw new Error(
      result.kind === 'badResponse'
        ? `Appearance request failed (${result.statusCode}).`
        : `Appearance request failed: ${result.message}`,
    );
  }
  const settings = themeSettingsFromPayload(result.response.settings);
  if (result.response.persisted || !hasStoredThemeSettings()) {
    saveThemeSettings(settings);
  }
  return {
    settings,
    persisted: result.response.persisted,
  };
}

export function saveThemeSettings(settings: ThemeSettings): ThemeSettings {
  const next = normalizeThemeSettings(settings);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    window.localStorage.setItem(
      STORAGE_KEY,
      next.mode === 'light' ? 'light' : 'dark',
    );
  }
  applyThemeSettings(next);
  return next;
}

export function applyThemeSettings(settings: ThemeSettings) {
  if (typeof document === 'undefined') return;

  const next = normalizeThemeSettings(settings);
  const root = document.documentElement;
  const isDark = next.mode === 'dark' || (next.mode === 'custom' && isDarkSurface(next));
  root.classList.toggle('dark', isDark);
  root.dataset.theme = next.mode;
  root.style.setProperty('--surface', hexToRgbChannels(next.surfaceColor));
  root.style.setProperty('--foreground', hexToRgbChannels(next.foregroundColor));
  root.style.setProperty('--muted', hexToRgbChannels(next.mutedColor));
  root.style.setProperty('--accent', hexToRgbChannels(next.accentColor));
}

export function readThemePreference(): ThemePreference {
  const settings = readThemeSettings();
  if (settings.mode === 'light' || settings.mode === 'dark') return settings.mode;
  return isDarkSurface(settings) ? 'dark' : 'light';
}

export function saveThemePreference(preference: ThemePreference): ThemePreference {
  saveThemeSettings(presetThemeSettings(preference));
  return preference;
}

export function applyThemePreference(preference: ThemePreference) {
  applyThemeSettings(presetThemeSettings(preference));
}

export function presetThemeSettings(preference: ThemePreference): ThemeSettings {
  return { ...(preference === 'light' ? LIGHT_THEME_SETTINGS : DARK_THEME_SETTINGS) };
}

export function normalizeThemeSettings(settings: ThemeSettings): ThemeSettings {
  const fallback = settings.mode === 'light' ? LIGHT_THEME_SETTINGS : DARK_THEME_SETTINGS;
  const surfaceColor = normalizeHexColor(settings.surfaceColor, fallback.surfaceColor);
  const foregroundColor = normalizeHexColor(
    settings.foregroundColor,
    fallback.foregroundColor,
  );
  const mutedColor = normalizeHexColor(settings.mutedColor, fallback.mutedColor);
  const accentColor = normalizeHexColor(settings.accentColor, fallback.accentColor);
  return {
    mode: isThemeMode(settings.mode) ? settings.mode : DEFAULT_THEME_SETTINGS.mode,
    surfaceColor,
    foregroundColor,
    mutedColor,
    accentColor,
  };
}

export function normalizeHexColor(value: string, fallback: string) {
  const trimmed = value.trim();
  if (HEX_COLOR_RE.test(trimmed)) return trimmed.toLowerCase();
  return fallback;
}

function isThemeSettingsRecord(value: unknown): value is ThemeSettings {
  return (
    typeof value === 'object' &&
    value !== null &&
    'mode' in value &&
    'surfaceColor' in value &&
    'foregroundColor' in value &&
    'mutedColor' in value &&
    'accentColor' in value &&
    typeof (value as ThemeSettings).mode === 'string' &&
    typeof (value as ThemeSettings).surfaceColor === 'string' &&
    typeof (value as ThemeSettings).foregroundColor === 'string' &&
    typeof (value as ThemeSettings).mutedColor === 'string' &&
    typeof (value as ThemeSettings).accentColor === 'string'
  );
}

function themeSettingsFromPayload(payload: AppearanceSettingsPayload): ThemeSettings {
  return normalizeThemeSettings({
    mode: 'custom',
    surfaceColor: payload.surfaceColor,
    foregroundColor: payload.foregroundColor,
    mutedColor: payload.mutedColor,
    accentColor: payload.accentColor,
  });
}

function isThemeMode(value: string): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'custom';
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark';
}

function migrateLegacyThemeSettings(settings: ThemeSettings) {
  if (window.localStorage.getItem(SETTINGS_STORAGE_KEY) === null) {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }
  if (window.localStorage.getItem(STORAGE_KEY) === null) {
    window.localStorage.setItem(
      STORAGE_KEY,
      settings.mode === 'light' ? 'light' : 'dark',
    );
  }
}

function hexToRgbChannels(hex: string) {
  const rgb = hexToRgb(hex);
  return `${rgb.r} ${rgb.g} ${rgb.b}`;
}

function isDarkSurface(settings: Pick<ThemeSettings, 'surfaceColor'>) {
  return luminance(hexToRgb(settings.surfaceColor)) < 0.45;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const raw = hex.replace('#', '');
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function luminance(rgb: Rgb) {
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
