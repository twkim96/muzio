import { useEffect, useState } from 'react';

import {
  fetchAppearanceSettings,
  resetAppearanceSettings as resetServerAppearanceSettings,
  updateAppearanceSettings,
  type AppearanceResult,
  type AppearanceSettingsPayload,
} from '../../core/api/appearanceClient';
import {
  fetchMediaRoots,
  refreshMediaRoots,
  updateMediaRoots,
  type MediaRootsResult,
  type MediaRootsSettings,
} from '../../core/api/mediaRootsClient';
import { useLibraryStores } from '../library/LibraryContext';
import { useBackendStatusStore } from './BackendStatusContext';
import { describeHealthResult } from './healthMessage';
import {
  LIGHT_THEME_SETTINGS,
  DARK_THEME_SETTINGS,
  normalizeHexColor,
  readThemeSettings,
  saveThemeSettings,
  type ThemeSettings,
} from './theme';

const themePresets: Array<{
  value: 'dark' | 'light';
  label: string;
  description: string;
  settings: ThemeSettings;
}> = [
  {
    value: 'dark',
    label: 'Dark',
    description: 'Apple Music style dark surfaces for night listening.',
    settings: DARK_THEME_SETTINGS,
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Bright surfaces for daytime library browsing.',
    settings: LIGHT_THEME_SETTINGS,
  },
];

const themeColorFields: Array<{
  key: 'surfaceColor' | 'foregroundColor' | 'mutedColor' | 'accentColor';
  label: string;
  description: string;
}> = [
  {
    key: 'surfaceColor',
    label: 'Surface',
    description: 'Main app background and panels.',
  },
  {
    key: 'foregroundColor',
    label: 'Text',
    description: 'Primary title and row text.',
  },
  {
    key: 'mutedColor',
    label: 'Muted',
    description: 'Secondary metadata and inactive controls.',
  },
  {
    key: 'accentColor',
    label: 'Accent',
    description: 'Active controls, progress, and highlights.',
  },
];

export function SettingsScreen() {
  const [theme, setTheme] = useState<ThemeSettings>(() => readThemeSettings());
  const [themeStatus, setThemeStatus] = useState<
    'ready' | 'loading' | 'saving' | 'saved' | 'error'
  >('loading');
  const [themeMessage, setThemeMessage] = useState('');
  const useStore = useBackendStatusStore();
  const backend = useStore();
  const libraryStores = useLibraryStores();
  const [mediaRoots, setMediaRoots] = useState<MediaRootsSettings>({
    audioRoots: [],
    videoRoots: [],
    imageRoots: [],
    persistent: false,
    degradedRoots: [],
    index: { enabled: false, loadedItems: 0 },
    watcher: { enabled: false, roots: [] },
  });
  const [mediaRootsStatus, setMediaRootsStatus] = useState<
    'loading' | 'ready' | 'saving' | 'refreshing' | 'saved' | 'error'
  >('loading');
  const [mediaRootsMessage, setMediaRootsMessage] = useState('');

  const persistTheme = async (next: ThemeSettings) => {
    setTheme(saveThemeSettings(next));
    setThemeStatus('saving');
    const result = await updateAppearanceSettings(toAppearancePayload(next));
    if (result.kind !== 'ok') {
      setThemeStatus('error');
      setThemeMessage(describeAppearanceResult(result));
      return;
    }
    const saved = saveThemeSettings(
      fromAppearancePayload(result.response.settings, next.mode),
    );
    setTheme(saved);
    setThemeStatus('saved');
    setThemeMessage('Appearance saved to the backend config.');
  };

  const updateThemePreset = (next: ThemeSettings) => {
    void persistTheme(next);
  };

  const updateThemeColor = (
    key: 'surfaceColor' | 'foregroundColor' | 'mutedColor' | 'accentColor',
    value: string,
  ) => {
    const fallback = theme[key];
    void persistTheme({
      ...theme,
      mode: 'custom',
      [key]: normalizeHexColor(value, fallback),
    });
  };

  const resetTheme = async () => {
    const fallback = saveThemeSettings(DARK_THEME_SETTINGS);
    setTheme(fallback);
    setThemeStatus('saving');
    const result = await resetServerAppearanceSettings();
    if (result.kind !== 'ok') {
      setThemeStatus('error');
      setThemeMessage(describeAppearanceResult(result));
      return;
    }
    const next = saveThemeSettings(fromAppearancePayload(result.response.settings, 'dark'));
    setTheme(next);
    setThemeStatus('ready');
    setThemeMessage('Appearance reset to default.');
  };

  useEffect(() => {
    let ignore = false;
    setThemeStatus('loading');
    void fetchAppearanceSettings().then((result) => {
      if (ignore) return;
      if (result.kind === 'ok') {
        if (result.response.persisted) {
          setTheme(saveThemeSettings(fromAppearancePayload(result.response.settings)));
          setThemeMessage('Appearance loaded from the backend config.');
        } else {
          setThemeMessage('Appearance is saved on this browser until changed.');
        }
        setThemeStatus('ready');
        return;
      }
      setThemeStatus('error');
      setThemeMessage(describeAppearanceResult(result));
    });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    setMediaRootsStatus('loading');
    void fetchMediaRoots().then((result) => {
      if (ignore) return;
      if (result.kind === 'ok') {
        setMediaRoots(result.settings);
        setMediaRootsStatus('ready');
        setMediaRootsMessage(describeLibraryIndex(result.settings));
        return;
      }
      setMediaRootsStatus('error');
      setMediaRootsMessage(describeMediaRootsResult(result));
    });
    return () => {
      ignore = true;
    };
  }, []);

  const saveMediaRoots = async () => {
    setMediaRootsStatus('saving');
    const next = sanitizeMediaRoots(mediaRoots);
    const result = await updateMediaRoots(next);
    if (result.kind !== 'ok') {
      setMediaRootsStatus('error');
      setMediaRootsMessage(describeMediaRootsResult(result));
      return;
    }
    setMediaRoots(result.settings);
    await reloadLibraries();
    setMediaRootsStatus('saved');
    const warningSuffix = describeMediaRootWarnings(result.settings);
    setMediaRootsMessage(
      result.settings.persistent
        ? `Saved and refreshed ${result.settings.itemCount ?? 0} items.${warningSuffix}`
        : `Applied for this server run and refreshed ${result.settings.itemCount ?? 0} items.${warningSuffix}`,
    );
  };

  const refreshCurrentMediaRoots = async () => {
    setMediaRootsStatus('refreshing');
    const result = await refreshMediaRoots();
    if (result.kind !== 'ok') {
      setMediaRootsStatus('error');
      setMediaRootsMessage(describeMediaRootsResult(result));
      return;
    }
    setMediaRoots(result.settings);
    await reloadLibraries();
    setMediaRootsStatus('saved');
    setMediaRootsMessage(
      `Rescanned ${result.settings.itemCount ?? 0} items.${describeMediaRootWarnings(result.settings)}`,
    );
  };

  const reloadLibraries = async () => {
    await Promise.all([
      libraryStores.audio.getState().load(),
      libraryStores.video.getState().load(),
      libraryStores.image.getState().load(),
    ]);
  };

  const mediaRootsBusy =
    mediaRootsStatus === 'loading' ||
    mediaRootsStatus === 'saving' ||
    mediaRootsStatus === 'refreshing';

  return (
    <div className="w-full px-4 py-7 sm:px-8 lg:px-10">
      <header className="mb-8 max-w-5xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">
          Settings
        </p>
        <h1 className="mt-2 text-5xl font-semibold tracking-tight sm:text-6xl">
          Settings
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
          Theme, backend health, and local runtime notes for this MacBook-first
          web app.
        </p>
      </header>

      <div className="grid max-w-5xl">
        <section
          id="appearance"
          className="border-t border-zinc-200/70 py-6 dark:border-white/10"
        >
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Appearance</h2>
              <p className="mt-1 text-sm text-muted">
                Customize the app colors. The setting is saved in the backend
                config and mirrored on this browser.
              </p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <p className="mt-1 text-sm text-muted">
                Current: {theme.mode === 'custom'
                  ? 'Custom'
                  : theme.mode === 'dark'
                    ? 'Dark'
                    : 'Light'}
              </p>
              <button
                type="button"
                data-testid="theme-reset"
                disabled={themeStatus === 'loading' || themeStatus === 'saving'}
                className="inline-flex h-9 items-center justify-center rounded-full border border-zinc-300 px-4 text-sm font-semibold text-foreground hover:bg-zinc-200/70 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                onClick={() => void resetTheme()}
              >
                Reset
              </button>
            </div>
          </div>

          <div className="mb-5 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Theme preset">
            {themePresets.map((option) => {
              const active = theme.mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`theme-option-${option.value}`}
                  className={[
                    'rounded-xl border p-4 text-left transition',
                    active
                      ? 'border-accent bg-accent/10 ring-2 ring-accent/30'
                      : 'border-zinc-200 bg-transparent hover:border-zinc-300 dark:border-white/10 dark:hover:border-white/20',
                  ].join(' ')}
                  onClick={() => updateThemePreset(option.settings)}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-base font-semibold">{option.label}</span>
                    <span
                      aria-hidden
                      className={[
                        'h-5 w-5 rounded-full border',
                        active
                          ? 'border-accent bg-accent shadow-[inset_0_0_0_4px_rgb(var(--surface))]'
                          : 'border-zinc-300 dark:border-zinc-600',
                      ].join(' ')}
                    />
                  </span>
                  <span className="mt-2 block text-sm leading-6 text-muted">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {themeColorFields.map((field) => (
              <ThemeColorInput
                key={field.key}
                label={field.label}
                description={field.description}
                value={theme[field.key]}
                testId={`theme-color-${field.key}`}
                onChange={(value) => updateThemeColor(field.key, value)}
              />
            ))}
          </div>
          <p
            data-testid="theme-status"
            className="mt-4 text-sm text-muted"
          >
            {themeStatus === 'loading'
              ? 'Loading appearance...'
              : themeStatus === 'saving'
                ? 'Saving appearance...'
                : themeMessage}
          </p>
        </section>

        <section
          id="backend-status"
          className="border-t border-zinc-200/70 py-6 dark:border-white/10"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Backend Status</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                The web app talks to the same-origin backend that served it.
                Use this probe when playback or library refresh feels
                disconnected.
              </p>
            </div>
            <button
              type="button"
              data-testid="test-button"
              disabled={backend.isProbing}
              className="inline-flex h-10 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
              onClick={() => backend.testConnection()}
            >
              {backend.isProbing ? 'Testing...' : 'Test'}
            </button>
          </div>

          {backend.lastResult !== null && (
            <p
              data-testid="probe-result"
              className="mt-4 border-t border-zinc-200/70 px-0 py-3 text-sm text-muted dark:border-white/10"
            >
              {describeHealthResult(backend.lastResult)}
            </p>
          )}
        </section>

        <section
          id="media-folders"
          className="border-t border-zinc-200/70 py-6 dark:border-white/10"
        >
          <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold">Media Folders</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                Configure the backend folders scanned for music, video, and images.
                Add more roots with +, then save to refresh the libraries.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="refresh-media-roots"
                disabled={mediaRootsBusy}
                className="inline-flex h-10 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-semibold text-foreground shadow-sm hover:bg-zinc-200/70 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10"
                onClick={() => void refreshCurrentMediaRoots()}
              >
                {mediaRootsStatus === 'refreshing' ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                type="button"
                data-testid="save-media-roots"
                disabled={mediaRootsBusy}
                className="inline-flex h-10 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
                onClick={() => void saveMediaRoots()}
              >
                {mediaRootsStatus === 'saving' ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <RootListEditor
              label="Music folders"
              testPrefix="audio-roots"
              roots={mediaRoots.audioRoots}
              onChange={(audioRoots) =>
                setMediaRoots((current) => ({ ...current, audioRoots }))
              }
            />
            <RootListEditor
              label="Video folders"
              testPrefix="video-roots"
              roots={mediaRoots.videoRoots}
              onChange={(videoRoots) =>
                setMediaRoots((current) => ({ ...current, videoRoots }))
              }
            />
            <RootListEditor
              label="Image folders"
              testPrefix="image-roots"
              roots={mediaRoots.imageRoots}
              onChange={(imageRoots) =>
                setMediaRoots((current) => ({ ...current, imageRoots }))
              }
            />
          </div>

          <p
            data-testid="media-roots-status"
            className="mt-4 text-sm text-muted"
          >
            {mediaRootsStatus === 'loading'
              ? 'Loading media folders...'
              : mediaRootsStatus === 'refreshing'
                ? 'Refreshing media folders...'
              : mediaRootsMessage ||
                (mediaRoots.persistent
                  ? 'Changes can be saved to backend config.'
                  : 'Changes apply to this server run unless backend configuration is persisted.')}
          </p>
        </section>

        <section
          id="runtime-notes"
          className="border-t border-zinc-200/70 py-6 dark:border-white/10"
        >
          <div className="mb-5">
            <h2 className="text-2xl font-semibold">Runtime Notes</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
              Build the web application, then let the Go backend serve it from
              the same origin. Keep the service on localhost or a trusted
              private network because authentication is not implemented.
            </p>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2">
            <RuntimeItem label="Deployment" value="Go server + built web app" />
            <RuntimeItem label="Web app" value="Same origin as this page" />
            <RuntimeItem label="Backend service" value="Muzio" />
            <RuntimeItem label="Version" value="1.3.12" />
          </dl>
        </section>
      </div>
    </div>
  );
}

function ThemeColorInput({
  label,
  description,
  value,
  testId,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  testId: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commitDraft = () => {
    onChange(draft);
  };

  return (
    <label className="rounded-xl border border-zinc-200/70 p-4 dark:border-white/10">
      <span className="flex items-start justify-between gap-4">
        <span>
          <span className="block text-base font-semibold">{label}</span>
          <span className="mt-1 block text-sm leading-6 text-muted">
            {description}
          </span>
        </span>
        <input
          aria-label={`${label} color picker`}
          data-testid={`${testId}-picker`}
          type="color"
          value={value}
          className="h-11 w-14 shrink-0 cursor-pointer rounded-lg border border-zinc-300 bg-transparent p-1 dark:border-white/10"
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
      <input
        aria-label={`${label} hex color`}
        data-testid={`${testId}-hex`}
        value={draft}
        inputMode="text"
        className="mt-3 w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono text-sm uppercase outline-none focus:border-accent dark:border-white/10"
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitDraft();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function RootListEditor({
  label,
  testPrefix,
  roots,
  onChange,
}: {
  label: string;
  testPrefix: string;
  roots: string[];
  onChange: (roots: string[]) => void;
}) {
  const visibleRoots = roots.length === 0 ? [''] : roots;
  const updateRoot = (index: number, value: string) => {
    const next = [...visibleRoots];
    next[index] = value;
    onChange(next);
  };
  const removeRoot = (index: number) => {
    onChange(visibleRoots.filter((_, current) => current !== index));
  };
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{label}</h3>
        <button
          type="button"
          data-testid={`${testPrefix}-add`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-300 text-xl font-semibold hover:bg-zinc-200/70 dark:border-white/10 dark:hover:bg-white/10"
          onClick={() => onChange([...visibleRoots, ''])}
        >
          +
        </button>
      </div>
      <div className="space-y-2">
        {visibleRoots.map((root, index) => (
          <div key={index} className="flex gap-2">
            <input
              aria-label={`${label} ${index + 1}`}
              data-testid={`${testPrefix}-input`}
              value={root}
              placeholder="/path/to/folder"
              className="min-w-0 flex-1 border-b border-zinc-300 bg-transparent px-0 py-2 text-sm outline-none placeholder:text-muted focus:border-accent dark:border-white/20"
              onChange={(event) => updateRoot(index, event.target.value)}
            />
            <button
              type="button"
              aria-label={`Remove ${label} ${index + 1}`}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-zinc-200/70 hover:text-zinc-950 dark:hover:bg-white/10 dark:hover:text-foreground"
              onClick={() => removeRoot(index)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuntimeItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-zinc-200/70 py-4 dark:border-white/10">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-2 break-words text-sm font-semibold">{value}</dd>
    </div>
  );
}

function sanitizeMediaRoots(
  settings: Pick<MediaRootsSettings, 'audioRoots' | 'videoRoots' | 'imageRoots'>,
) {
  return {
    audioRoots: cleanRoots(settings.audioRoots),
    videoRoots: cleanRoots(settings.videoRoots),
    imageRoots: cleanRoots(settings.imageRoots),
  };
}

function describeDegradedRoots(settings: MediaRootsSettings): string {
  if (settings.degradedRoots.length === 0) return '';
  const details = settings.degradedRoots
    .map((root) => `${root.path} (${root.error})`)
    .join('; ');
  return ` Kept last known files for ${details}.`;
}

function describeLibraryIndex(settings: MediaRootsSettings): string {
  const warnings = describeMediaRootWarnings(settings).trim();
  if (warnings !== '') return warnings;
  const watcher = describeWatcher(settings);
  if (!settings.index.enabled) return watcher;
  const verified = settings.index.lastVerifiedAt
    ? ` Last verified ${new Date(settings.index.lastVerifiedAt).toLocaleString()}.`
    : '';
  return `Loaded ${settings.index.loadedItems} indexed items.${verified}${watcher ? ` ${watcher}` : ''}`;
}

function describeMediaRootWarnings(settings: MediaRootsSettings): string {
  const degraded = describeDegradedRoots(settings).trim();
  const indexError = settings.index.lastError
    ? `Library index write is delayed: ${settings.index.lastError}`
    : '';
  const watcherError = settings.watcher.lastError
    ? `Filesystem watcher error: ${settings.watcher.lastError}`
    : '';
  const warnings = [degraded, indexError, watcherError].filter(Boolean).join(' ');
  return warnings === '' ? '' : ` ${warnings}`;
}

function describeWatcher(settings: MediaRootsSettings): string {
  const manualRoots = settings.watcher.roots.filter((root) => !root.enabled);
  const active = settings.watcher.enabled
    ? `Live updates active via ${settings.watcher.backend ?? 'filesystem watcher'}.`
    : '';
  const manual = manualRoots.length > 0
    ? `Manual refresh required for ${manualRoots
        .map((root) => `${root.path}${root.reason ? ` (${root.reason})` : ''}`)
        .join('; ')}.`
    : '';
  return [active, manual].filter(Boolean).join(' ');
}

function cleanRoots(roots: string[]) {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const root of roots) {
    const next = root.trim();
    if (next === '' || seen.has(next)) continue;
    seen.add(next);
    cleaned.push(next);
  }
  return cleaned;
}

function describeMediaRootsResult(result: Exclude<MediaRootsResult, { kind: 'ok' }>) {
  if (result.kind === 'badResponse') {
    return `Media folder request failed (${result.statusCode}).`;
  }
  return `Media folder request failed: ${result.message}`;
}

function toAppearancePayload(settings: ThemeSettings): AppearanceSettingsPayload {
  return {
    surfaceColor: settings.surfaceColor,
    foregroundColor: settings.foregroundColor,
    mutedColor: settings.mutedColor,
    accentColor: settings.accentColor,
  };
}

function fromAppearancePayload(
  settings: AppearanceSettingsPayload,
  mode: ThemeSettings['mode'] = 'custom',
): ThemeSettings {
  return {
    mode,
    surfaceColor: settings.surfaceColor,
    foregroundColor: settings.foregroundColor,
    mutedColor: settings.mutedColor,
    accentColor: settings.accentColor,
  };
}

function describeAppearanceResult(result: Exclude<AppearanceResult, { kind: 'ok' }>) {
  if (result.kind === 'badResponse') {
    return `Appearance request failed (${result.statusCode}).`;
  }
  return `Appearance request failed: ${result.message}`;
}
