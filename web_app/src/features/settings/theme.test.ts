import { beforeEach, describe, expect, test } from 'vitest';

import {
  applyThemeSettings,
  readThemeSettings,
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
  saveThemeSettings,
} from './theme';

describe('theme preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.theme;
  });

  test('defaults to dark', () => {
    expect(readThemePreference()).toBe('dark');
    expect(readThemeSettings().mode).toBe('dark');
  });

  test('saves and applies light mode', () => {
    saveThemePreference('light');

    expect(readThemePreference()).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  test('applies dark mode', () => {
    applyThemePreference('dark');

    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('saves and applies custom color settings', () => {
    saveThemeSettings({
      mode: 'custom',
      surfaceColor: '#101214',
      foregroundColor: '#f4f5f6',
      mutedColor: '#a1a7ad',
      accentColor: '#1c6417',
    });

    expect(readThemeSettings()).toEqual({
      mode: 'custom',
      surfaceColor: '#101214',
      foregroundColor: '#f4f5f6',
      mutedColor: '#a1a7ad',
      accentColor: '#1c6417',
    });
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.dataset.theme).toBe('custom');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('16 18 20');
    expect(document.documentElement.style.getPropertyValue('--foreground')).toBe(
      '244 245 246',
    );
    expect(document.documentElement.style.getPropertyValue('--muted')).toBe('161 167 173');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('28 100 23');
  });

  test('migrates legacy videio theme settings without losing preferences', () => {
    window.localStorage.setItem(
      'videio.theme.settings',
      JSON.stringify({
        mode: 'custom',
        surfaceColor: '#101214',
        foregroundColor: '#f4f5f6',
        mutedColor: '#a1a7ad',
        accentColor: '#1c6417',
      }),
    );

    expect(readThemeSettings().mode).toBe('custom');
    expect(window.localStorage.getItem('muzio.theme.settings')).not.toBeNull();
    expect(window.localStorage.getItem('muzio.theme')).toBe('dark');
  });

  test('migrates a legacy videio preset preference', () => {
    window.localStorage.setItem('videio.theme', 'light');

    expect(readThemePreference()).toBe('light');
    expect(window.localStorage.getItem('muzio.theme')).toBe('light');
  });

  test('applies light custom surfaces without dark class', () => {
    applyThemeSettings({
      mode: 'custom',
      surfaceColor: '#f8fafc',
      foregroundColor: '#111827',
      mutedColor: '#64748b',
      accentColor: '#2563eb',
    });

    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.dataset.theme).toBe('custom');
  });
});
